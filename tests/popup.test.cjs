const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { script } = require('./load-scripts.cjs');

test('popup displays target failures safely and refreshes the next saved state', async () => {
  const { document } = parseHTML(fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8'));
  let lastError = '<img src=x onerror=alert(1)> 저장 실패';
  let changed;
  const context = vm.createContext({ document,
    chrome: { runtime: { sendMessage: async () => ({ ok: true, settings: { ownUid: 'owner', autoSave: true }, posts: [], bytes: 0,
      targets: [{ key: 'k', title: '글', status: 'active', lastCount: 2, lastError, expiresAt: '2026-10-16T01:10:00Z' }] }) },
      storage: { onChanged: { addListener: fn => { changed = fn; } } } } });
  vm.runInContext(script('popup.js'), context, { filename: 'popup.js' });
  await new Promise(resolve => setImmediate(resolve));
  const node = document.querySelector('.target-row .muted');
  assert.equal(node.textContent, '<img src=x onerror=alert(1)> 저장 실패');
  assert.equal(node.classList.contains('error'), true);
  assert.equal(document.querySelectorAll('img').length, 0);
  lastError = '';
  changed({}, 'local');
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = document.querySelector('.target-row .muted');
  assert.match(refreshed.textContent, /^댓글 2개 · /);
  assert.equal(refreshed.classList.contains('error'), false);
});
