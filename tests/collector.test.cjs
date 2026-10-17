const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { script } = require('./load-scripts.cjs');
const url = 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123';
const job = { url, key: 'mgallery:example:123', lastCount: 0, expectedUid: 'owner' };
const post = (count = 2, extra = '') => `<html><body><div class="gallview_head"><span class="title_subject">내 글</span>
  <span class="gall_writer" data-uid="owner" data-nick="글쓴이"></span></div><input id="comment_cnt" value="${count}">
  <span id="comment_total_123">0</span><input id="e_s_n_o" value="token"><input id="_GALLTYPE_" value="M">${extra}</body></html>`;
const page = (current, last, comments, total = 2) => ({ total_cnt: total, comments,
  pagination: `<em>${current}</em>${current < last ? `<a href="javascript:viewComments(${current + 1},'D',true)">${current + 1}</a>` : ''}` });
const comment = (no, parent = 0) => ({ no: String(no), c_no: parent, name: '독자', memo: '댓글', reg_date: '10.16 13:00', del_yn: 'N' });
function setup(responses) {
  const { document } = parseHTML('<html></html>');
  const context = vm.createContext({ document, URL, URLSearchParams, AbortController, setTimeout, clearTimeout });
  for (const file of ['core.js', 'extractor.js', 'notification-core.js', 'collector.js']) vm.runInContext(script(file), context);
  // Browser DocumentFragment.textContent is a string; linkedom returns null.
  const plainText = context.DCExtractor.plainText;
  context.DCExtractor.plainText = fragment => {
    const wrapper = document.createElement('div'); wrapper.append(fragment.cloneNode(true)); return plainText(wrapper);
  };
  const calls = [];
  const fetch = async (requestUrl, options) => {
    calls.push({ url: requestUrl, options });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected extra network request');
    return { ok: (response.status || 200) < 400, status: response.status || 200,
      text: async () => typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
  };
  return { collector: context.DCCollector, calls, collect: target => context.DCCollector.collectTarget(target, { document, fetch }) };
}

test('unchanged count reads the server-rendered count and skips comment API', async () => {
  const h = setup([{ body: post(2) }]);
  const result = await h.collect({ ...job, lastCount: 2 });
  assert.equal(result.count, 2); assert.equal(result.comments, null); assert.equal(result.complete, true);
  assert.equal(h.calls.length, 1);
  const options = h.calls[0].options;
  assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(options.signal.aborted, false);
});

test('newly registered empty post fetches no initial comment content', async () => {
  const h = setup([{ body: post(0) }]);
  assert.equal((await h.collect(job)).comments, null); assert.equal(h.calls.length, 1);
});

test('changed count collects sequential pages and preserves reply parents', async () => {
  const h = setup([{ body: post() }, { body: page(1, 2, [comment(11)]) }, { body: page(2, 2, [comment(12, 11)]) }]);
  const result = await h.collect(job);
  assert.equal(result.complete, true); assert.equal(result.comments.length, 2); assert.equal(result.comments[1].parentId, '11');
  assert.deepEqual(h.calls.slice(1).map(c => new URLSearchParams(c.options.body).get('comment_page')), ['1', '2']);
  const body = new URLSearchParams(h.calls[1].options.body);
  assert.equal(body.get('_GALLTYPE_'), 'M'); assert.equal(body.get('e_s_n_o'), 'token');
  assert.equal(h.calls[1].options.headers.Referer, undefined);
});

test('force retries incomplete or notified count even when unchanged', async () => {
  const h = setup([{ body: post() }, { body: page(1, 1, [comment(11), comment(12)]) }]);
  assert.equal((await h.collect({ ...job, lastCount: 2, force: true })).comments.length, 2);
});

test('one pass bounds requests and provides an explicit continuation', async () => {
  const h = setup([{ body: post(20) }, ...Array.from({ length: 10 }, (_, i) => ({ body: page(i + 1, 20, [comment(i + 1)], 20) }))]);
  const result = await h.collect(job);
  assert.equal(result.complete, false); assert.equal(result.nextPage, 11); assert.equal(result.collectionCount, 20);
  assert.equal(h.calls.length, 11); assert.equal(result.comments.length, 10);
});

test('continuation resumes only when the observed count still matches', async () => {
  for (const [collectionCount, expected] of [[20, '11'], [19, '1']]) {
    const h = setup([{ body: post(20) }, { body: page(Number(expected), Number(expected), [comment(1)], 20) }]);
    await h.collect({ ...job, force: true, nextPage: 11, collectionCount });
    assert.equal(new URLSearchParams(h.calls[1].options.body).get('comment_page'), expected);
  }
});

test('count change during paging saves partial comments and invalidates the cursor', async () => {
  const h = setup([{ body: post(2) }, { body: page(1, 2, [comment(1)], 3) }]);
  const result = await h.collect(job);
  assert.equal(result.complete, false); assert.equal(result.nextPage, 1); assert.equal(result.count, 3);
  assert.equal(result.comments.length, 1); assert.equal(h.calls.length, 2);
});

test('exact server deletion response is recognized on HTTP 404 without executing scripts', async () => {
  const h = setup([{ status: 404, body: '<script type="text/javascript">location.replace("/derror/deleted/example/gallery/gallery/123");</script>' }]);
  assert.equal((await h.collect(job)).state, 'deleted');
});

test('body text, access errors, foreign deletion identities, and generic 404 never imply deletion', async () => {
  for (const response of [
    { body: '<div>삭제된 글입니다.</div>' },
    { status: 403, body: '로그인 필요' },
    { status: 404, body: 'Not found' },
    { status: 404, body: '<script type="text/javascript">location.replace("/derror/deleted/other/gallery/gallery/123");</script>' },
    { body: '<script type="text/javascript">location.replace("/derror/deleted/example/gallery/gallery/999");</script>' }
  ]) await assert.rejects(setup([response]).collect(job));
  const h = setup([{ body: post(2, '<p>삭제된 글입니다.</p><script>location.replace("/derror/deleted/example/gallery/gallery/123");</script>') }]);
  assert.equal((await h.collect({ ...job, lastCount: 2 })).state, 'alive');
});

test('bad target or mismatched author cannot initiate collection', async () => {
  const invalid = setup([]);
  await assert.rejects(invalid.collect({ ...job, url: 'https://evil.test' })); assert.equal(invalid.calls.length, 0);
  const h = setup([{ body: post() }]);
  await assert.rejects(h.collect({ ...job, expectedUid: 'different' }), /작성자/); assert.equal(h.calls.length, 1);
});

test('missing count cannot silently use async comment_total placeholder zero', async () => {
  await assert.rejects(setup([{ body: post().replace('id="comment_cnt"', 'id="missing"') }]).collect(job), /댓글 수/);
});

test('malformed, blocked and failed comment responses remain errors', async () => {
  for (const response of [{ body: '<html>로그인 필요</html>' }, { status: 429, body: 'too many requests' },
    { body: { total_cnt: 2, comments: null } }, new Error('connection reset')]) {
    await assert.rejects(setup([{ body: post() }, response]).collect(job));
  }
});

test('unexpected pagination page cannot mark a duplicated page as complete', async () => {
  await assert.rejects(setup([{ body: post() }, { body: page(9, 9, [comment(1)]) }]).collect(job), /페이지/);
  await assert.rejects(setup([{ body: post() }, { body: { ...page(1, 1, [comment(1)]), pagination: '<span>오류</span>' } }]).collect(job), /페이지/);
});

test('offscreen collector rejects content-script and extension-page callers', async () => {
  let listener; let collected = 0;
  const context = vm.createContext({ chrome: { runtime: { id: 'extension-id', getURL: file => `chrome-extension://extension-id/${file}`,
    onMessage: { addListener: fn => { listener = fn; } } } }, DCCollector: { collectTarget: async () => { collected++; return { state: 'alive' }; } } });
  vm.runInContext(script('offscreen.js'), context);
  const message = { target: 'offscreen', type: 'COLLECT_TARGET', job };
  for (const sender of [{ id: 'foreign' }, { id: 'extension-id', tab: {} }, { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' }]) {
    let response; listener(message, sender, value => { response = value; }); assert.equal(response.ok, false);
  }
  assert.equal(listener({ ...message, target: 'other' }, { id: 'extension-id' }, () => {}), undefined);
  const result = await new Promise(resolve => { assert.equal(listener(message, { id: 'extension-id' }, resolve), true); });
  assert.equal(result.ok, true); assert.equal(collected, 1);
});
