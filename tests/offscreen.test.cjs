const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { script } = require('./load-scripts.cjs');

function offscreen(reservationResponse = { ok: true, reserved: true }) {
  let listener;
  const calls = [], environments = [], pending = [], messages = [];
  const chrome = { runtime: {
    id: 'extension-test',
    getURL: path => `chrome-extension://extension-test/${path}`,
    sendMessage: async message => { messages.push(message); return reservationResponse; },
    onMessage: { addListener: fn => { listener = fn; } }
  } };
  const DCCollector = { collectTarget: (job, environment) => {
    calls.push(job);
    environments.push(environment);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } };
  const context = vm.createContext({ chrome, DCCollector });
  vm.runInContext(script('offscreen.js'), context, { filename: 'offscreen.js' });
  return { calls, environments, pending, messages, send: (key, fields = {}) => new Promise(resolve => {
    listener({ target: 'offscreen', type: 'COLLECT_TARGET', job: { key, ...fields } },
      { id: 'extension-test', url: 'chrome-extension://extension-test/background.js' }, resolve);
  }) };
}

test('offscreen requests durable probe permission for the exact collector claim', async () => {
  const app = offscreen();
  const running = app.send('mgallery:example:123', { generation: 'generation-1', attemptAt: 1700000000000 });
  assert.equal(await app.environments[0].reserveDeletionProbe(), true);
  assert.deepEqual(app.messages.map(message => ({ ...message })), [{ type: 'RESERVE_DELETION_PROBE', key: 'mgallery:example:123', generation: 'generation-1', attemptAt: 1700000000000 }]);
  app.pending.shift().resolve({ state: 'alive', count: 0 });
  assert.equal((await running).ok, true);
});

test('offscreen fails closed when probe permission is absent or rejected', async () => {
  for (const response of [undefined, { ok: false, reserved: true }, { ok: true, reserved: false }, { ok: true }]) {
    const app = offscreen(response === undefined ? null : response);
    const running = app.send('first');
    assert.equal(await app.environments[0].reserveDeletionProbe(), false);
    app.pending.shift().resolve({ state: 'alive', count: 0 });
    await running;
  }
});

for (const outcome of ['success', 'failure']) {
  test(`offscreen prevents simultaneous requests and releases its guard after ${outcome}`, async () => {
    const app = offscreen();
    const first = app.send('first');
    assert.equal(app.calls.length, 1);
    const blocked = await app.send('second');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /확인 중/);
    assert.equal(app.calls.length, 1);
    const running = app.pending.shift();
    if (outcome === 'success') running.resolve({ state: 'alive', count: 0 });
    else running.reject(new Error('HTTP 503'));
    const result = await first;
    assert.equal(result.ok, outcome === 'success');
    if (outcome === 'failure') assert.equal(result.error, 'HTTP 503');
    const next = app.send('second');
    assert.equal(app.calls.length, 2);
    assert.equal(app.calls[1].key, 'second');
    app.pending.shift().resolve({ state: 'alive', count: 1 });
    assert.equal((await next).ok, true);
  });
}
