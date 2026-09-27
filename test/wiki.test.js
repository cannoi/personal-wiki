const assert = require('assert');
const http = require('http');
const app = require('../server');

let server;
let port;

before((done) => {
  server = http.createServer(app);
  server.listen(0, '0.0.0.0', () => {
    port = server.address().port;
    done();
  });
});

after((done) => {
  server.close(done);
});

describe('Personal Wiki Health Check', () => {
  it('should return ok on health endpoint', (done) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      assert.strictEqual(res.statusCode, 200);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        assert.strictEqual(json.status, 'ok');
        done();
      });
    }).on('error', done);
  });
});
