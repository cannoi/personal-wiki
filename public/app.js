let authMode = 'login';
let currentDashboard = { folders: [], pages: [] };
let activePageId = null;
let autosaveTimer = null;

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('auth-submit-btn').innerText = mode === 'login' ? 'Sign In' : 'Register';
  document.getElementById('auth-error').innerText = '';
}

async function handleAuth(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
  
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (res.ok) {
      initApp();
    } else {
      document.getElementById('auth-error').innerText = data.error || 'Authentication failed';
    }
  } catch (err) {
    document.getElementById('auth-error').innerText = 'Network error';
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('main-screen').classList.add('hidden');
}

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      initApp();
    } else {
      document.getElementById('auth-screen').classList.remove('hidden');
    }
  } catch (e) {
    document.getElementById('auth-screen').classList.remove('hidden');
  }
}

async function initApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');
  await loadDashboard();
}

async function loadDashboard(searchQuery = '') {
  let url = '/api/dashboard';
  if (searchQuery) {
    url = `/api/pages?search=${encodeURIComponent(searchQuery)}`;
    const res = await fetch(url);
    const pages = await res.json();
    renderSidebar([], pages);
    return;
  }
  const res = await fetch(url);
  if (res.ok) {
    currentDashboard = await res.json();
    renderSidebar(currentDashboard.folders, currentDashboard.pages);
    populateFolderDropdowns(currentDashboard.folders);
  }
}

function renderSidebar(folders, pages) {
  const tree = document.getElementById('sidebar-tree');
  let html = '';
  
  // Unfoldered pages
  const rootPages = pages.filter(p => !p.folder_id);
  if (rootPages.length > 0) {
    html += '<ul class="page-list">';
    rootPages.forEach(p => {
      html += `<li class="page-item ${activePageId === p.id ? 'active' : ''}" onclick="openPage(${p.id})">${escapeHtml(p.title)}</li>`;
    });
    html += '</ul>';
  }

  // Folders and their pages
  folders.forEach(f => {
    const folderPages = pages.filter(p => p.folder_id === f.id);
    html += `<div class="folder-item">
      <div class="folder-title">
        <span>📁 ${escapeHtml(f.name)}</span>
        <button class="btn-icon" style="font-size:0.75rem" onclick="deleteFolder(${f.id})">🗑️</button>
      </div>
      <ul class="page-list">`;
    folderPages.forEach(p => {
      html += `<li class="page-item ${activePageId === p.id ? 'active' : ''}" onclick="openPage(${p.id})">${escapeHtml(p.title)}</li>`;
    });
    html += `</ul></div>`;
  });

  tree.innerHTML = html || '<p style="padding:1rem; color:var(--text-muted); font-size:0.85rem;">No pages yet. Create one!</p>';
}

function populateFolderDropdowns(folders) {
  const select = document.getElementById('new-page-folder');
  let html = '<option value="">Root (No Folder)</option>';
  folders.forEach(f => {
    html += `<option value="${f.id}">${escapeHtml(f.name)}</option>`;
  });
  select.innerHTML = html;
}

async function openPage(id) {
  activePageId = id;
  const res = await fetch(`/api/pages/${id}`);
  if (res.ok) {
    const page = await res.json();
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('page-editor-view').classList.remove('hidden');
    document.getElementById('page-title-input').value = page.title;
    document.getElementById('page-markdown-input').value = page.markdown || '';
    document.getElementById('page-preview-pane').innerHTML = page.rendered_html || '';
    
    renderAttachments(page.attachments);
    loadDashboard(); // Refresh sidebar active state
  }
}

function triggerAutosave() {
  const status = document.getElementById('autosave-status');
  status.innerText = 'Unsaved...';
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveCurrentPage, 800);
}

async function saveCurrentPage() {
  if (!activePageId) return;
  const title = document.getElementById('page-title-input').value;
  const markdown = document.getElementById('page-markdown-input').value;
  const status = document.getElementById('autosave-status');

  const res = await fetch(`/api/pages/${activePageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, markdown })
  });
  if (res.ok) {
    status.innerText = 'Saved';
    const pageRes = await fetch(`/api/pages/${activePageId}`);
    const pageData = await pageRes.json();
    document.getElementById('page-preview-pane').innerHTML = pageData.rendered_html || '';
    loadDashboard();
  } else {
    status.innerText = 'Error saving';
  }
}

function openNewFolderModal() {
  document.getElementById('folder-modal').classList.remove('hidden');
}

function openNewPageModal() {
  document.getElementById('page-modal').classList.remove('hidden');
}

function closeModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

async function createFolder() {
  const name = document.getElementById('new-folder-name').value;
  if (!name) return;
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (res.ok) {
    document.getElementById('new-folder-name').value = '';
    closeModals();
    loadDashboard();
  }
}

async function createPage() {
  const title = document.getElementById('new-page-title').value;
  const folder_id = document.getElementById('new-page-folder').value;
  if (!title) return;
  const res = await fetch('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, folder_id: folder_id ? parseInt(folder_id) : null })
  });
  if (res.ok) {
    const data = await res.json();
    document.getElementById('new-page-title').value = '';
    closeModals();
    await loadDashboard();
    openPage(data.id);
  }
}

async function deleteCurrentPage() {
  if (!activePageId || !confirm('Are you sure you want to delete this page?')) return;
  const res = await fetch(`/api/pages/${activePageId}`, { method: 'DELETE' });
  if (res.ok) {
    activePageId = null;
    document.getElementById('page-editor-view').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    loadDashboard();
  }
}

async function deleteFolder(id) {
  if (!confirm('Delete folder and move its pages to root?')) return;
  await fetch(`/api/folders/${id}`, { method: 'DELETE' });
  loadDashboard();
}

async function uploadAttachment(e) {
  const file = e.target.files[0];
  if (!file || !activePageId) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`/api/pages/${activePageId}/attachments`, {
    method: 'POST',
    body: formData
  });
  if (res.ok) {
    e.target.value = '';
    openPage(activePageId);
  }
}

async function deleteAttachment(id) {
  await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
  openPage(activePageId);
}

function renderAttachments(attachments) {
  const list = document.getElementById('attachments-list');
  let html = '';
  attachments.forEach(att => {
    html += `<div class="attachment-chip">
      <a href="/attachments-static/${att.stored_name}" target="_blank">${escapeHtml(att.original_name)}</a>
      <button class="btn-icon" style="font-size:0.7rem" onclick="deleteAttachment(${att.id})">❌</button>
    </div>`;
  });
  list.innerHTML = html || '<span style="color:var(--text-muted); font-size:0.8rem;">No attachments</span>';
}

function handleSearch(e) {
  const q = e.target.value;
  loadDashboard(q);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

checkSession();
