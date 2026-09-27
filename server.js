const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ATTACHMENT_DIR = process.env.ATTACHMENT_DIR || path.join(__dirname, 'attachments');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ATTACHMENT_DIR)) fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'wiki.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    parent_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    folder_id INTEGER,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    markdown TEXT DEFAULT '',
    is_favorite INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(folder_id) REFERENCES folders(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    page_id INTEGER,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
  )`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'personal-wiki-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/attachments-static', express.static(ATTACHMENT_DIR));

const upload = multer({
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_SIZE || '10485760', 10) },
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ATTACHMENT_DIR),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
    }
  })
});

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Health Endpoint
app.get('/health', (req, res) => {
  db.get('SELECT 1', (err) => {
    if (err) {
      res.status(500).json({ status: 'error', database: err.message });
    } else {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
  });
});

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, hash], function(err) {
      if (err) return res.status(400).json({ error: 'Email already registered or invalid' });
      req.session.userId = this.lastID;
      req.session.email = email;
      res.json({ success: true, userId: this.lastID, email });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) return res.status(401).json({ error: 'Invalid email or password' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ success: true, userId: user.id, email: user.email });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ userId: req.session.userId, email: req.session.email });
});

// Dashboard / Overview
app.get('/api/dashboard', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.all('SELECT id, name, parent_id, created_at FROM folders WHERE user_id = ? ORDER BY name', [userId], (err, folders) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT id, folder_id, title, slug, is_favorite, is_archived, updated_at FROM pages WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20', [userId], (err2, pages) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ folders, pages });
    });
  });
});

// Folders
app.get('/api/folders', requireAuth, (req, res) => {
  db.all('SELECT * FROM folders WHERE user_id = ? ORDER BY name', [req.session.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/folders', requireAuth, (req, res) => {
  const { name, parent_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Folder name required' });
  db.run('INSERT INTO folders (user_id, name, parent_id) VALUES (?, ?, ?)', [req.session.userId, name, parent_id || null], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name, parent_id: parent_id || null });
  });
});

app.delete('/api/folders/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM folders WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run('UPDATE pages SET folder_id = NULL WHERE folder_id = ? AND user_id = ?', [req.params.id, req.session.userId], () => {
      res.json({ success: true });
    });
  });
});

// Pages
app.get('/api/pages', requireAuth, (req, res) => {
  const { folder_id, search } = req.query;
  let query = 'SELECT id, folder_id, title, slug, is_favorite, is_archived, updated_at FROM pages WHERE user_id = ?';
  let params = [req.session.userId];
  if (folder_id !== undefined) {
    if (folder_id === 'null' || folder_id === '') {
      query += ' AND folder_id IS NULL';
    } else {
      query += ' AND folder_id = ?';
      params.push(folder_id);
    }
  }
  if (search) {
    query += ' AND (title LIKE ? OR markdown LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ' ORDER BY title ASC';
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/pages/:id', requireAuth, (req, res) => {
  db.get('SELECT * FROM pages WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, page) => {
    if (err || !page) return res.status(404).json({ error: 'Page not found' });
    db.all('SELECT * FROM attachments WHERE page_id = ? AND user_id = ?', [page.id, req.session.userId], (err2, attachments) => {
      page.attachments = attachments || [];
      
      // Parse markdown & render with [[Wiki Links]] support
      let html = marked.parse(page.markdown || '');
      html = sanitizeHtml(html, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3']),
        allowedAttributes: { 
          ...sanitizeHtml.defaults.allowedAttributes,
          'img': ['src', 'alt', 'title']
        }
      });
      page.rendered_html = html;
      res.json(page);
    });
  });
});

app.post('/api/pages', requireAuth, (req, res) => {
  const { title, folder_id, markdown } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  db.run(
    'INSERT INTO pages (user_id, folder_id, title, slug, markdown, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [req.session.userId, folder_id || null, title, slug, markdown || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, title, slug, folder_id: folder_id || null });
    }
  );
});

app.patch('/api/pages/:id', requireAuth, (req, res) => {
  const { title, folder_id, markdown, is_favorite, is_archived } = req.body;
  db.get('SELECT * FROM pages WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, page) => {
    if (err || !page) return res.status(404).json({ error: 'Page not found' });
    
    const newTitle = title !== undefined ? title : page.title;
    const newSlug = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newFolderId = folder_id !== undefined ? folder_id : page.folder_id;
    const newMarkdown = markdown !== undefined ? markdown : page.markdown;
    const newFav = is_favorite !== undefined ? (is_favorite ? 1 : 0) : page.is_favorite;
    const newArch = is_archived !== undefined ? (is_archived ? 1 : 0) : page.is_archived;

    db.run(
      'UPDATE pages SET title = ?, slug = ?, folder_id = ?, markdown = ?, is_favorite = ?, is_archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [newTitle, newSlug, newFolderId, newMarkdown, newFav, newArch, req.params.id, req.session.userId],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ success: true, updated_at: new Date().toISOString() });
      }
    );
  });
});

app.delete('/api/pages/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM pages WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Attachments
app.post('/api/pages/:id/attachments', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const pageId = req.params.id;
  const userId = req.session.userId;
  
  db.get('SELECT id FROM pages WHERE id = ? AND user_id = ?', [pageId, userId], (err, page) => {
    if (err || !page) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Page not found' });
    }
    db.run(
      'INSERT INTO attachments (user_id, page_id, original_name, stored_name, mime_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, pageId, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size],
      function(err2) {
        if (err2) {
          fs.unlinkSync(req.file.path);
          return res.status(500).json({ error: err2.message });
        }
        res.json({ id: this.lastID, original_name: req.file.originalname, stored_name: req.file.filename });
      }
    );
  });
});

app.delete('/api/attachments/:id', requireAuth, (req, res) => {
  db.get('SELECT * FROM attachments WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId], (err, att) => {
    if (err || !att) return res.status(404).json({ error: 'Attachment not found' });
    const filePath = path.join(ATTACHMENT_DIR, att.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.run('DELETE FROM attachments WHERE id = ?', [req.params.id], () => {
      res.json({ success: true });
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Personal Wiki running on http://0.0.0.0:${PORT}`);
});

module.exports = app;
