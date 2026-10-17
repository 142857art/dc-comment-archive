const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { script } = require('./load-scripts.cjs');

test('archive renders hostile text safely and groups late replies without hiding orphan comments', async () => {
  const { document } = parseHTML(`<html><body><input id="search" value=""><button id="export"></button>
    <p id="feedback"></p><p id="summary"></p><p id="resultsCount"></p><nav id="postList"></nav><main id="postDetail"></main></body></html>`);
  const record = (id, text, parentId = '') => ({ id, text, parentId, author: '<img src=x onerror=alert(1)>', media: [], date: '12:00' });
  const post = { key: 'board:example:123', title: '<script>alert(1)</script>', gallery: '테스트', url: 'https://gall.dcinside.com/board/view/?id=example&no=123',
    firstSavedAt: '2026-10-16T01:00:00Z', lastSavedAt: '2026-10-16T01:00:00Z', comments: [
      record('1', '원댓글'), record('3', '다른 댓글'), record('2', '<img src=x onerror=alert(1)> 답글', '1'), record('4', '부모 누락 답글', '999')
    ] };
  const context = vm.createContext({ document, URL, Blob, setTimeout, clearTimeout,
    chrome: { runtime: { sendMessage: async () => ({ ok: true, posts: [post], settings: {}, bytes: 1024 }) }, storage: { onChanged: { addListener() {} } } } });
  vm.runInContext(script('archive.js'), context, { filename: 'archive.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(document.querySelector('h2').textContent, post.title);
  assert.equal(document.querySelectorAll('script,img').length, 0);
  assert.deepEqual([...document.querySelectorAll('article .comment-text')].map(n => n.textContent), ['원댓글', '<img src=x onerror=alert(1)> 답글', '다른 댓글', '부모 누락 답글']);
  assert.equal(document.querySelectorAll('article.reply').length, 1);
  assert.match(document.querySelectorAll('article')[3].textContent, /답글 · 원댓글 #999/);
  assert.equal(document.querySelectorAll('a')[0].rel, 'noopener noreferrer');
});
