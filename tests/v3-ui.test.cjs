const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
const { script } = require('./load-scripts.cjs');
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const writeMarkup = '<html><body><article id="write_wrap"><form id="write"><input name="id" value="example"><input name="subject" value="제목"><div class="btn_box write"><button class="btn_grey cancle">취소</button><button class="write">등록</button></div></form></article></body></html>';
const writeLocation = { href: 'https://gall.dcinside.com/mgallery/board/write/?id=example', origin: 'https://gall.dcinside.com', pathname: '/mgallery/board/write/' };

function writer(settings = {}) {
  const { document, CustomEvent, Event } = parseHTML(writeMarkup);
  const messages = []; let changed; let runtimeListener;
  const context = vm.createContext({ document, location: writeLocation, URL, setTimeout,
    chrome: { runtime: { id: 'extension', onMessage: { addListener: fn => { runtimeListener = fn; } }, sendMessage: message => { messages.push(message); return Promise.resolve({ ok: true, settings: { autoSave: true, ...settings } }); } },
      storage: { onChanged: { addListener: fn => { changed = fn; } } } } });
  vm.runInContext(script('writer.js'), context);
  return { document, messages, CustomEvent, Event, change: next => changed({ settings: { newValue: next } }, 'local'),
    config: next => { settings = next; runtimeListener({ type: 'CONFIG_CHANGED' }, { id: 'extension' }); } };
}

test('write toggle sits immediately left of cancel and only queues successful opted-in registration', async () => {
  const app = writer(); await tick();
  const button = app.document.querySelector('.dca-backup-toggle');
  assert.equal(button.nextElementSibling.textContent, '취소');
  assert.equal(button.type, 'button');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(app.messages.map(m => m.type), ['GET_SETTINGS', 'WRITE_ARM']);
  assert.equal(app.messages.at(-1).enabled, false);
  const success = () => app.document.dispatchEvent(new app.CustomEvent('dc-comment-archive-write-success', { detail: JSON.stringify({ url: 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123', title: '<img>' }) }));
  success(); assert.equal(app.messages.some(m => m.type === 'WRITE_SUCCESS'), false);
  button.click();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(app.messages.at(-1).enabled, true);
  success();
  assert.equal(app.messages.at(-1).type, 'WRITE_SUCCESS');
  assert.equal(app.messages.at(-1).title, '<img>');
  assert.equal(app.document.querySelectorAll('img').length, 0);
});

test('all-own mode hides write toggle and arms registration; master disable disarms it', async () => {
  const app = writer({ allOwnPosts: true }); await tick();
  assert.equal(app.document.querySelector('.dca-backup-toggle'), null);
  assert.equal(app.messages.at(-1).enabled, true);
  app.change({ autoSave: false, allOwnPosts: true });
  assert.equal(app.messages.at(-1).enabled, false);
});

test('trusted CONFIG_CHANGED refreshes the write UI without content storage events', async () => {
  const app = writer(); await tick();
  assert.ok(app.document.querySelector('.dca-backup-toggle'));
  app.config({ allOwnPosts: true }); await tick();
  assert.equal(app.document.querySelector('.dca-backup-toggle'), null);
  assert.equal(app.messages.at(-1).enabled, true);
  app.config({ allOwnPosts: false }); await tick();
  assert.ok(app.document.querySelector('.dca-backup-toggle'));
});

function bridge({ response = 'true||123||0', method = 'POST', target = '/board/forms/article_submit', status = 200, page = writeLocation, extra = '' } = {}) {
  const { document, CustomEvent } = parseHTML(writeMarkup.replace('<input name="subject"', `${extra}<input name="subject"`));
  const order = []; const emitted = [];
  document.addEventListener('dc-comment-archive-write-success', event => { order.push('extension'); emitted.push(JSON.parse(event.detail)); });
  class XHR {
    constructor() { this.listeners = []; this.readyState = 0; }
    addEventListener(name, fn) { if (name === 'readystatechange') this.listeners.push(fn); }
    open() { this.readyState = 1; }
    send() { this.status = status; this.responseText = response; this.readyState = 4; this.listeners.forEach(fn => fn()); order.push('site-navigation'); }
  }
  const context = vm.createContext({ document, location: page, URL, CustomEvent, XMLHttpRequest: XHR });
  vm.runInContext(script('write-bridge.js'), context);
  const xhr = new XHR(); xhr.open(method, target, false); xhr.send('password=not-inspected');
  return { order, emitted };
}

test('synchronous write success is captured before site navigation and contains only post metadata', () => {
  const result = bridge();
  assert.deepEqual(result.order, ['extension', 'site-navigation']);
  assert.deepEqual(result.emitted, [{ id: 'example', title: '제목', no: '123', url: 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123' }]);
});

test('write bridge ignores pending, failure, unrelated requests, modify and malformed post numbers', () => {
  for (const options of [{ response: 'pending||대기' }, { response: 'false||실패' }, { response: 'true||bad' }, { status: 500 },
    { method: 'GET' }, { target: 'https://evil.example/board/forms/article_submit' }, { target: '/board/forms/comment_submit' },
    { extra: '<input name="no" value="123">' }, { page: { ...writeLocation, pathname: '/mgallery/board/modify/' } }]) {
    assert.equal(bridge(options).emitted.length, 0, JSON.stringify(options));
  }
});

test('deletion notice renders safe text once and opens the matching archive before acknowledgement', async () => {
  const { document } = parseHTML('<html><body></body></html>');
  const messages = []; let listener;
  const window = {}; window.top = window;
  const context = vm.createContext({ document, window,
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async message => {
      messages.push(message);
      return { ok: true, notices: [{ key: 'k', title: '<img src=x>', count: 2 }] };
    } } } });
  vm.runInContext(script('site-ui.js'), context); await tick();
  assert.equal(document.querySelectorAll('.dca-one-noticewrap').length, 1);
  assert.equal(document.querySelectorAll('img').length, 0);
  listener({ type: 'DELETE_NOTICE_AVAILABLE' }); await tick();
  assert.equal(document.querySelectorAll('.dca-one-noticewrap').length, 1);
  document.querySelector('.dca-one-notice-text').click(); await tick();
  assert.deepEqual(messages.slice(-2).map(m => [m.type, m.key]), [['OPEN_ARCHIVE', 'k'], ['ACK_DELETION', 'k']]);
  assert.equal(document.querySelectorAll('.dca-one-noticewrap').length, 0);
});

test('popup sends every backup setting and can stop an active target', async () => {
  const { document, Event } = parseHTML(fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8'));
  const messages = [];
  const settings = { ownUid: 'owner', autoSave: true, allOwnPosts: false, pollSeconds: 30, idleMinutes: 10 };
  const context = vm.createContext({ document,
    chrome: { runtime: { sendMessage: async message => { messages.push(message); return { ok: true, settings, posts: [], bytes: 0, targets: [{ key: 'k', title: '<img>', status: 'active', lastCount: 2, expiresAt: '2026-10-16T02:00:00Z' }] }; } },
      storage: { onChanged: { addListener() {} } } } });
  vm.runInContext(script('popup.js'), context); await tick();
  assert.equal(document.getElementById('pollSeconds').value, '30', 'saved intervals remain selected');
  assert.equal(document.getElementById('pollSeconds').getAttribute('min'), '1');
  document.getElementById('allOwnPosts').checked = true;
  document.getElementById('pollSeconds').value = '1'; document.getElementById('idleMinutes').value = '5';
  document.getElementById('settingsForm').dispatchEvent(new Event('submit', { cancelable: true })); await tick();
  const saved = messages.find(message => message.type === 'SAVE_SETTINGS').settings;
  assert.equal(saved.allOwnPosts, true); assert.equal(saved.pollSeconds, 1); assert.equal(saved.idleMinutes, 5);
  document.querySelector('.target-row button').click(); await tick();
  assert.equal(messages.find(message => message.type === 'STOP_TARGET').key, 'k');
  assert.equal(document.querySelectorAll('img').length, 0);
});

test('archive hash selects the deleted backup rather than the newest post', async () => {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '..', 'extension', 'archive.html'), 'utf8'));
  const post = key => ({ key, title: key, gallery: '갤러리', comments: [], firstSavedAt: '2026-10-16', lastSavedAt: key === 'newer' ? '2026-10-17' : '2026-10-16' });
  const messages = [];
  const context = vm.createContext({ document, URL, Blob, setTimeout, clearTimeout, location: { hash: '#deleted%3Akey' }, addEventListener() {},
    chrome: { runtime: { sendMessage: async message => { messages.push(message); return { ok: true, posts: [post('newer'), post('deleted:key')], targets: [{ key: 'deleted:key', status: 'deleted' }], settings: {} }; } }, storage: { onChanged: { addListener() {} } } } });
  vm.runInContext(script('archive.js'), context); await tick();
  assert.equal(document.querySelector('#postDetail h2').textContent, 'deleted:key');
  assert.match(document.querySelector('#postDetail').textContent, /원글 삭제됨/);
  document.getElementById('search').dispatchEvent(new (document.defaultView.Event)('input')); await tick();
  assert.deepEqual(messages.filter(m => m.type === 'ACK_DELETION').map(m => m.key), ['deleted:key']);
});
