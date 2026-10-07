// Run: node dev/mock-server.js   then open http://localhost:8765
// Serves index.html with a pretend Google web app behind it (simulated sheet with your migrated data).
// Test controls:  POST /__mode {"mode":"normal"|"down"|"slow"|"bogus"}   POST /__now {"iso":"2026-10-07T08:00:00Z"}   GET /__rows
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createBackend } = require('./mock-sheet');

const PORT = Number(process.env.PORT) || 8765;
const root = path.join(__dirname, '..');
const b = createBackend({ csvFile: path.join(__dirname, 'dadfit-log.csv'), mode: 'text', now: '2026-10-07T08:00:00Z', key: 'test-key-12345' });
b.run('migrate'); b.run('backfill');
let mode = 'normal';
const types = { '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/exec') {
      if (mode === 'down') return req.socket.destroy();
      if (mode === 'bogus') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end('{"ok":true,"message":"Dad Fit tracker web app is running."}'); }
      const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(b.post(body))); };
      return mode === 'slow' ? setTimeout(reply, 3000) : reply();
    }
    if (req.method === 'POST' && url === '/__mode') { mode = JSON.parse(body).mode; res.end('ok'); return; }
    if (req.method === 'POST' && url === '/__now') { b.setNow(JSON.parse(body).iso); res.end('ok'); return; }
    if (url === '/__rows') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ log: b.grid('Log'), sets: b.grid('Sets').length - 1, sport: b.grid('Sport') })); return; }
    const rel = url === '/' ? 'index.html' : decodeURIComponent(url.slice(1));
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || rel.startsWith('dev')) { res.writeHead(404); res.end('not found'); return; }
    let data = fs.readFileSync(file);
    if (rel === 'index.html') data = Buffer.from(data.toString().replace(/const API_URL = "[^"]*";/, 'const API_URL = "http://localhost:' + PORT + '/exec";'));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('Dad Fit test server on http://localhost:' + PORT + '  (key: test-key-12345)'));
