const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const { once } = require('node:events');

async function setup(t, result) {
  const calls = [], file = '../routes/imageRoutes';
  delete require.cache[require.resolve(file)];
  const original = Module._load;
  let clientConfig;
  Module._load = function(name, parent, main) {
    return name === 'axios' ? { create(options) { clientConfig = options;
      return { get: async url => { calls.push(url); return result; } }; } }
      : original.call(this, name, parent, main);
  };
  let router;
  try { router = require(file); } finally { Module._load = original; }
  const app = express(); app.use('/api/images', router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { calls, clientConfig, base: `http://127.0.0.1:${server.address().port}/api/images` };
}
test('BSD image proxy is fixed-host, unauthenticated, bounded and shares cached public bytes', async t => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const { base, calls, clientConfig } = await setup(t, { status: 200, data: bytes });
  const [a,b] = await Promise.all([fetch(base+'/bsd/team/57'), fetch(base+'/bsd/team/57')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.headers.get('content-type'), 'image/png');
  assert.equal(a.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), bytes);
  assert.deepEqual(calls, ['https://sports.bzzoiro.com/img/team/57/']);
  assert.equal(clientConfig.headers.Authorization, undefined);
  assert.equal(clientConfig.maxRedirects, 0);
  assert.equal(clientConfig.maxContentLength, 1048576);
  for (const path of ['/bsd/team/0','/bsd/other/1','/bsd/player/1e3']) {
    assert.equal((await fetch(base+path)).status, 400);
  }
  assert.equal(calls.length, 1);
});
test('BSD image proxy refuses non-image payloads and preserves missing-image state', async t => {
  const {base} = await setup(t,{ status:200, data: Buffer.from('<html>no image</html>') });
  assert.equal((await fetch(base+'/bsd/player/852')).status,502);
  const missing=await setup(t,{status:204,data:Buffer.alloc(0)});
  assert.equal((await fetch(missing.base+'/bsd/player/852')).status,404);
});
