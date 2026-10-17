const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { script } = require('./load-scripts.cjs');

function offscreen() {
  let listener;
  const calls = [], pending = [];
  const chrome = { runtime: {
    id: 'extension-test',
    getURL: path => `chrome-extension://extension-test/${path}`,
    onMessage: { addListener: fn => { listener = fn; } }
  } };
  const DCCollector = { collectTarget: job => {
    calls.push(job);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  } };
  const context = vm.createContext({ chrome, DCCollector });
  vm.runInContext(script('offscreen.js'), context, { filename: 'offscreen.js' });
  return { calls, pending, send: key => new Promise(resolve => {
    listener({ target: 'offscreen', type: 'COLLECT_TARGET', job: { key } },
      { id: 'extension-test', url: 'chrome-extension://extension-test/background.js' }, resolve);
  }) };
}

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
