'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseDevices, selectDevice, hasLocalReverse, probeBackend, isPortFree, ensureBridge } =
  require('../scripts/local-android-runtime');

test('device selection waits for authorization and does not guess between two phones', () => {
  const devices = parseDevices('List of devices attached\r\nphone1 unauthorized usb:1\r\nphone2 device model:Phone\r\n');
  assert.deepEqual(selectDevice(devices, 'phone1'), { serial: 'phone1', state: 'unauthorized' });
  assert.equal(selectDevice(devices).serial, 'phone2');
  assert.equal(selectDevice([...devices, { serial: 'phone3', state: 'device' }]).state, 'multiple');
  assert.equal(selectDevice(devices, 'absent').state, 'disconnected');
});

test('a different port or forward destination does not prove the local API bridge', () => {
  assert.equal(hasLocalReverse('UsbFfs tcp:3000 tcp:3001'), false);
  assert.equal(hasLocalReverse('UsbFfs tcp:8082 tcp:8082'), false);
  assert.equal(hasLocalReverse('UsbFfs tcp:8082 tcp:8082\nUsbFfs tcp:3000 tcp:3000\n'), true);
});

test('reconnecting the same phone restores a lost mapping without installing or clearing anything', async () => {
  let connected = true;
  let mapping = '';
  let restored = 0;
  const commands = [];
  const execute = async (_, args) => {
    commands.push(args);
    if (args[0] === 'devices') return connected ? 'phone1 device model:Phone\n' : '';
    if (args.at(-1) === '--list') return mapping;
    assert.deepEqual(args, ['-s', 'phone1', 'reverse', 'tcp:3000', 'tcp:3000']);
    mapping = 'UsbFfs tcp:3000 tcp:3000\n';
    restored++;
    return '';
  };
  assert.equal((await ensureBridge('adb', undefined, execute)).state, 'connected');
  assert.equal(restored, 1);
  await ensureBridge('adb', undefined, execute);
  assert.equal(restored, 1);
  connected = false;
  mapping = '';
  assert.equal((await ensureBridge('adb', undefined, execute)).state, 'disconnected');
  connected = true;
  assert.equal((await ensureBridge('adb', undefined, execute)).state, 'connected');
  assert.equal(restored, 2);
  assert.ok(commands.every(args => args[0] === 'devices' || args[2] === 'reverse'));
});

test('an unsuccessful reverse operation is not announced as connected', async () => {
  const execute = async (_, args) => args[0] === 'devices' ? 'phone1 device\n' : '';
  assert.equal((await ensureBridge('adb', undefined, execute)).state, 'bridge-failed');
});

test('unauthorized or ambiguous phones never receive a reverse command', async () => {
  for (const output of ['phone1 unauthorized\n', 'phone1 device\nphone2 device\n']) {
    const calls = [];
    await ensureBridge('adb', undefined, async (_, args) => { calls.push(args); return output; });
    assert.deepEqual(calls, [['devices', '-l']]);
  }
});

test('HTTP readiness distinguishes our API, draining API and an unrelated occupied port', async t => {
  let mode = 'ready';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') {
      res.end(JSON.stringify(mode === 'foreign' ? { success: true, message: 'Another app' } :
        { success: true, message: 'KickSphere Backend OK 🚀' }));
    } else {
      res.statusCode = mode === 'draining' ? 503 : 200;
      res.end(JSON.stringify({ success: mode !== 'draining', status: mode === 'draining' ? 'draining' : 'ready' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  assert.equal(await probeBackend(origin), 'ready');
  assert.equal(await isPortFree(port, '127.0.0.1'), false);
  mode = 'draining';
  assert.equal(await probeBackend(origin), 'not-ready');
  mode = 'foreign';
  assert.equal(await probeBackend(origin), 'foreign');
});

test('a stopped backend is reported as unreachable', async () => {
  assert.equal(await probeBackend('http://127.0.0.1:0'), 'unreachable');
});
