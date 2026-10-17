const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { script } = require('./load-scripts.cjs');

const url = 'https://gall.dcinside.com/board/view/?id=example&no=123';
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function content({ uid = 'owner', allOwnPosts = false, status = 'active' } = {}) {
  const { document } = parseHTML(`<html><body><div class="gallview_head"><span class="title_subject">내 글</span>
    <div class="gall_writer" data-uid="${uid}" data-nick="작성자"></div><span class="gall_comment">댓글 <a>0</a></span></div>
    <div class="comment_wrap" id="comment_wrap_123"><div class="comment_count">전체 댓글 <em id="comment_total_123">0</em>개</div></div></body></html>`);
  const messages = [];
  const observers = [];
  const events = {};
  const timers = new Map();
  let timerId = 0;
  let listener;
  let intervals = 0;
  let scans = 0;
  const settings = { ownUid: 'owner', autoSave: true, allOwnPosts, idleMinutes: 10, pollSeconds: 30 };
  const chrome = { runtime: { id: 'extension-test', onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async message => {
      messages.push(structuredClone(message));
      if (message.type === 'GET_CONFIG') return { ok: true, settings, tracked: status === 'active', target: { status }, excluded: false, count: 0 };
      if (message.type === 'GET_SETTINGS') return { ok: true, settings };
      return { ok: true, count: 0, target: { status }, tracked: status === 'active' };
    } } };
  class Observer {
    constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({ document, location: { href: url }, chrome, URL, console,
    MutationObserver: Observer, setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => { intervals++; return 9999; }, clearInterval() {},
    addEventListener: (name, fn) => { events[name] = fn; } });
  for (const file of ['core.js', 'extractor.js']) vm.runInContext(script(file), context, { filename: file });
  const original = context.DCExtractor.extractPost;
  context.DCExtractor.extractPost = (...args) => { scans++; return original(...args); };
  vm.runInContext(script('content.js'), context, { filename: 'content.js' });
  return { document, messages, observers, events, timers, settings,
    get intervals() { return intervals; }, get scans() { return scans; },
    runTimers: async () => { const jobs = [...timers.values()]; timers.clear(); for (const job of jobs) job.fn(); await tick(); },
    mutate: async () => {
      for (const observer of observers.filter(o => !o.disconnected)) observer.fn([{ target: document.querySelector('.comment_wrap'), addedNodes: [] }]);
      await tick();
    },
    message: type => new Promise(resolve => {
      const wait = listener({ type }, { id: 'extension-test' }, result => resolve(structuredClone(result)));
      if (wait !== true) resolve(undefined);
    })
  };
}

test('opening post sends metadata without initially scanning or saving comments and installs no polling interval', async () => {
  const app = content();
  await tick();
  assert.equal(app.intervals, 0);
  assert.equal(app.scans, 0);
  assert.equal(app.messages.some(m => m.type === 'SAVE_SNAPSHOT'), false);
  assert.ok(app.messages.some(m => m.type === 'POST_SEEN'));
});

test('DOM comment count changes signal background and identical mutations do not repeat it', async () => {
  const app = content();
  await tick();
  app.messages.length = 0;
  app.document.getElementById('comment_total_123').textContent = '1';
  app.document.querySelector('.gall_comment').textContent = '댓글 1';
  await app.mutate(); await app.runTimers();
  const signals = () => app.messages.filter(m => m.type === 'COUNT_CHANGED' || m.type === 'POST_SEEN');
  assert.equal(signals().length, 1);
  assert.equal(signals()[0].count, 1);
  await app.mutate(); await app.runTimers();
  assert.equal(signals().length, 1);
  assert.equal(app.scans, 0, 'worker owns comment collection');
});

test('pagehide disconnects scoped observers and cancels pending timers', async () => {
  const app = content();
  await tick();
  assert.ok(app.observers.length);
  assert.ok(app.observers.flatMap(o => o.targets).every(target => target !== app.document.body));
  app.events.pagehide({ persisted: false });
  assert.ok(app.observers.every(o => o.disconnected));
  assert.equal(app.timers.size, 0);
});

test('website notices only signal worker, deduplicate DOM rerenders, and never fetch comments in tab', async () => {
  const href = `${url}&fcno=55`;
  const { document } = parseHTML('<html><body><div id="alarmList"><ul class="notice_list"></ul></div><div class="alarmPopup"></div></body></html>');
  const messages = [];
  const observers = [];
  const timers = new Map();
  let timerId = 0;
  let fetches = 0;
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const context = vm.createContext({ document, location: { href: url, origin: 'https://gall.dcinside.com' }, URL, console,
    chrome: { runtime: { sendMessage: async message => { messages.push(structuredClone(message)); return { ok: true }; } } },
    MutationObserver: Observer, addEventListener() {},
    fetch: async () => { fetches++; throw new Error('Tab must not fetch comments'); },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id) });
  for (const file of ['core.js', 'notification-core.js', 'notifications.js']) vm.runInContext(script(file), context, { filename: file });
  await tick();
  document.querySelector('.notice_list').innerHTML = `<li><a class="notice_txt" href="${href}">내 글에 댓글이 등록되었습니다.</a></li>`;
  for (const observer of observers) observer.fn([{ target: document.getElementById('alarmList'), addedNodes: [] }]);
  for (const timer of [...timers.values()]) if (timer.delay < 5000) timer.fn();
  await tick();
  for (const observer of observers) observer.fn([{ target: document.getElementById('alarmList'), addedNodes: [] }]);
  for (const timer of [...timers.values()]) if (timer.delay < 5000) timer.fn();
  await tick();
  assert.equal(messages.filter(m => m.type === 'NOTICE_SIGNAL').length, 1);
  assert.equal(messages.filter(m => /^NOTICE_(CLAIM|SAVE|FINISH)$/.test(m.type)).length, 0);
  assert.equal(fetches, 0);
});
