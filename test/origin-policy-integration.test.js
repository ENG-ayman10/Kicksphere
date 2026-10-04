const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { createOriginPolicy } = require('../utils/runtimeConfig');

function websocketStatus(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Local handshake timed out')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write([
      'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1', `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? [`Origin: ${origin}`] : []), '', ''
    ].join('\r\n')));
    socket.once('data', data => { const firstLine = data.toString().split('\r\n')[0]; socket.destroy(); resolve(firstLine); });
  });
}

test('production origin guard blocks untrusted writes and direct WebSocket handshakes; native access does not bypass route auth', async () => {
  const policy = createOriginPolicy({ allowAllOrigins: false, allowedOrigins: ['https://app.example.test'] });
  let writes = 0;
  const app = express();
  app.use(policy.middleware);
  app.use(cors({ origin: policy.corsOrigin, credentials: true }));
  app.post('/public', (req, res) => { writes++; res.json({ success: true }); });
  app.get('/protected', (req, res) => res.status(401).json({ success: false }));
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: policy.corsOrigin, credentials: true }, allowRequest: policy.allowSocketRequest });
  const connectionErrors = [];
  io.engine.on('connection_error', error => connectionErrors.push(error));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const base = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${base}/public`, { method: 'POST', headers: { Origin: 'https://evil.example.test' } });
    assert.equal(denied.status, 403);
    assert.equal(writes, 0);
    const allowed = await fetch(`${base}/public`, { method: 'POST', headers: { Origin: 'https://app.example.test' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    assert.equal((await fetch(`${base}/protected`)).status, 401);
    assert.equal((await fetch(`${base}/public`, { method: 'POST' })).status, 200);
    // Engine.IO returns 400 for rejected upgrades but identifies the origin
    // policy rejection with its FORBIDDEN error code (4).
    assert.match(await websocketStatus(port, 'https://evil.example.test'), / 400 /);
    assert.equal(connectionErrors.at(-1).code, 4);
    assert.match(await websocketStatus(port, 'https://app.example.test'), / 101 /);
    assert.match(await websocketStatus(port), / 101 /);
  } finally {
    io.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
});
