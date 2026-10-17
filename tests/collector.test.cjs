const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { script } = require('./load-scripts.cjs');
const url = 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123';
const job = { url, key: 'mgallery:example:123', lastCount: 0, expectedUid: 'owner', metadata: { title: '내 글', authorUid: 'owner' } };
const row = (no, { uid = 'owner', notice = false, gallery = 'example' } = {}) => `<tr data-no="${no}"><td class="gall_num">${notice ? '공지' : no}</td><td class="gall_tit"><a href="/mgallery/board/view/?id=${gallery}&no=${no}">제목</a></td><td class="gall_writer" data-uid="${uid}"></td></tr>`;
const list = (rows = row('124') + row('123') + row('122'), extra = '') => `<input id="id" value="example"><input id="e_s_n_o" value="token"><input id="_GALLTYPE_" value="M"><table>${rows}</table>${extra}`;
const page = (current, last, comments, total = 2) => ({ total_cnt: total, comments,
  pagination: `<em>${current}</em>${current < last ? `<a href="javascript:viewComments(${current + 1},'D',true)">${current + 1}</a>` : ''}` });
const comment = (no, parent = 0) => ({ no: String(no), c_no: parent, name: '독자', memo: '댓글', reg_date: '10.16 13:00', del_yn: 'N' });
const empty = { total_cnt: 0, comments: null, pagination: null };
const deleted = '<script type="text/javascript">location.replace("/derror/deleted/example/gallery/gallery/123");</script>';
function setup(responses, options = {}) {
  const { document } = parseHTML('<html></html>');
  const context = vm.createContext({ document, URL, URLSearchParams, AbortController, setTimeout, clearTimeout });
  for (const file of ['core.js', 'extractor.js', 'notification-core.js', 'collector.js']) vm.runInContext(script(file), context);
  // Browser DocumentFragment.textContent is a string; linkedom returns null.
  const plainText = context.DCExtractor.plainText;
  context.DCExtractor.plainText = fragment => {
    const wrapper = document.createElement('div'); wrapper.append(fragment.cloneNode(true)); return plainText(wrapper);
  };
  const calls = []; let now = 100000;
  const fetch = async (requestUrl, requestOptions) => {
    calls.push({ url: requestUrl, options: requestOptions });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected extra network request');
    return { ok: (response.status || 200) < 400, status: response.status || 200,
      text: async () => typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
  };
  return { collector: context.DCCollector, calls, time: value => { now = value; },
    collect: target => context.DCCollector.collectTarget(target, { document, fetch, now: () => now, ...options }) };
}
const apiCalls = h => h.calls.filter(c => c.url.endsWith('/board/comment/'));
const articleCalls = h => h.calls.filter(c => c.url.includes('/view/'));

test('normal and repeated polls use comment API with a cached list token and no article GET', async () => {
  const h = setup([{ body: list() }, { body: page(1, 1, [comment(11), comment(12)]) }, { body: page(1, 1, [comment(11), comment(12)]) }]);
  const first = await h.collect(job);
  h.time(103000);
  const second = await h.collect({ ...job, lastCount: 2, monitorState: first.monitorState });
  assert.equal(second.count, 2); assert.equal(second.comments, null); assert.equal(second.complete, true);
  assert.equal(h.calls.length, 3); assert.equal(apiCalls(h).length, 2); assert.equal(articleCalls(h).length, 0);
  assert.equal(h.calls[0].url, 'https://gall.dcinside.com/mgallery/board/lists/?id=example&page=1');
  const options = h.calls[1].options;
  assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(options.signal.aborted, false); assert.equal(options.headers.Referer, undefined);
  const body = new URLSearchParams(options.body);
  assert.equal(body.get('_GALLTYPE_'), 'M'); assert.equal(body.get('e_s_n_o'), 'token');
});

test('zero comments are ordinary availability and never imply deletion', async () => {
  const h = setup([{ body: list('') }, { body: empty }], { reserveDeletionProbe: async () => { throw Error('must not reserve'); } });
  const result = await h.collect(job);
  assert.equal(result.state, 'alive'); assert.equal(result.comments, null); assert.equal(articleCalls(h).length, 0);
});

test('changed count collects sequential pages and preserves reply parents', async () => {
  const h = setup([{ body: list() }, { body: page(1, 2, [comment(11)]) }, { body: page(2, 2, [comment(12, 11)]) }]);
  const result = await h.collect(job);
  assert.equal(result.complete, true); assert.equal(result.comments.length, 2); assert.equal(result.comments[1].parentId, '11');
  assert.deepEqual(apiCalls(h).map(c => new URLSearchParams(c.options.body).get('comment_page')), ['1', '2']);
});

test('force retries unchanged comments but regular unchanged polls skip later pages', async () => {
  for (const force of [false, true]) {
    const h = setup([{ body: list() }, { body: page(1, 2, [comment(11)]) }, ...(force ? [{ body: page(2, 2, [comment(12)]) }] : [])]);
    const result = await h.collect({ ...job, lastCount: 2, force });
    assert.equal(apiCalls(h).length, force ? 2 : 1); assert.equal(result.comments?.length ?? null, force ? 2 : null);
  }
});

test('one pass bounds comment requests and provides a continuation', async () => {
  const h = setup([{ body: list() }, ...Array.from({ length: 10 }, (_, i) => ({ body: page(i + 1, 20, [comment(i + 1)], 20) }))]);
  const result = await h.collect(job);
  assert.equal(result.complete, false); assert.equal(result.nextPage, 11); assert.equal(result.collectionCount, 20);
  assert.equal(apiCalls(h).length, 10); assert.equal(result.comments.length, 10);
});

test('continuation checks page one first and resumes only if count still matches', async () => {
  for (const [collectionCount, expected] of [[20, '11'], [19, '2']]) {
    const h = setup([{ body: list() }, { body: page(1, 20, [comment(1)], 20) }, { body: page(Number(expected), Number(expected), [comment(2)], 20) }]);
    const result = await h.collect({ ...job, lastCount: 20, force: collectionCount === 19, nextPage: 11, collectionCount });
    assert.equal(result.complete, true);
    assert.deepEqual(apiCalls(h).map(c => new URLSearchParams(c.options.body).get('comment_page')), ['1', expected]);
  }
});

test('count change during paging saves partial comments and invalidates cursor', async () => {
  const h = setup([{ body: list() }, { body: page(1, 2, [comment(1)], 2) }, { body: page(2, 2, [comment(2)], 3) }]);
  const result = await h.collect(job);
  assert.equal(result.complete, false); assert.equal(result.nextPage, 1); assert.equal(result.count, 3); assert.equal(result.comments.length, 2);
});

test('list existence checks are thirty seconds apart while comments still poll', async () => {
  const h = setup([{ body: list() }, { body: empty }, { body: empty }, { body: empty }, { body: list() }]);
  let result = await h.collect(job);
  h.time(129999); result = await h.collect({ ...job, monitorState: result.monitorState });
  assert.equal(h.calls.filter(c => c.url.includes('/lists/')).length, 1);
  h.time(130000); result = await h.collect({ ...job, monitorState: result.monitorState });
  assert.equal(h.calls.filter(c => c.url.includes('/lists/')).length, 2); assert.equal(result.monitorState.lastListCheckAt, 130000);
});

test('an ordinary page movement follows ranges without treating missing rows as deletion', async () => {
  let reserved = 0;
  const h = setup([{ body: list(row('130') + row('125')) }, { body: empty }, { body: list(row('124') + row('123') + row('122')) }], { reserveDeletionProbe: async () => { reserved++; return true; } });
  const result = await h.collect(job);
  assert.equal(result.monitorState.listPage, 2); assert.equal(result.resetDeletionProbe, true);
  assert.equal(result.state, 'alive'); assert.equal(reserved, 0); assert.equal(articleCalls(h).length, 0);
});

test('an out-of-range old post is unknown after at most three list pages', async () => {
  const h = setup([{ body: list(row('150') + row('145')) }, { body: empty }, { body: list(row('144') + row('140')) }, { body: list(row('139') + row('135')) }], { reserveDeletionProbe: async () => { throw Error('must not reserve'); } });
  const result = await h.collect(job);
  assert.equal(result.state, 'alive'); assert.equal(h.calls.length, 4); assert.equal(articleCalls(h).length, 0);
});

test('bracketed absence reserves before one confirmation and retains collected comments on deletion', async () => {
  let reserved = false;
  const h = setup([{ body: list(row('124') + row('122')) }, { body: page(1, 1, [comment(11)], 1) }, { status: 404, body: deleted }],
    { reserveDeletionProbe: async () => { assert.equal(articleCalls(h).length, 0); reserved = true; return true; } });
  const result = await h.collect(job);
  assert.equal(reserved, true); assert.equal(result.state, 'deleted'); assert.equal(result.comments.length, 1);
  assert.equal(articleCalls(h).length, 1); assert.equal(result.resetDeletionProbe, undefined);
});

test('a false or failed deletion probe cannot repeat until durable reservation is released', async () => {
  for (const probe of [{ body: '<div>still alive</div>' }, new Error('network failed')]) {
    let latch = false;
    const h = setup([{ body: list(row('124') + row('122')) }, { body: empty }, probe,
      { body: empty }, { body: list(row('124') + row('122')) }], { reserveDeletionProbe: async () => { if (latch) return false; latch = true; return true; } });
    const result = await h.collect(job);
    h.time(130000); const second = await h.collect({ ...job, monitorState: result.monitorState });
    assert.equal(result.state, 'alive'); assert.equal(second.state, 'alive'); assert.equal(articleCalls(h).length, 1);
    if (probe instanceof Error) assert.match(result.monitoringError, /network failed/);
  }
});

test('missing reservation callback cannot make an article request', async () => {
  const h = setup([{ body: list(row('124') + row('122')) }, { body: empty }]);
  assert.equal((await h.collect(job)).state, 'alive'); assert.equal(articleCalls(h).length, 0);
});

test('notices count as presence but cannot establish ordinary numerical brackets', async () => {
  const h = setup([{ body: list(row('124') + row('123', { notice: true }) + row('122')) }, { body: empty }]);
  assert.equal((await h.collect(job)).resetDeletionProbe, true);
  const onlyNotices = setup([{ body: list(row('124', { notice: true }) + row('122', { notice: true })) }, { body: empty }], { reserveDeletionProbe: async () => { throw Error('must not reserve'); } });
  assert.equal((await onlyNotices.collect(job)).state, 'alive'); assert.equal(articleCalls(onlyNotices).length, 0);
});

test('unordered, duplicate and foreign linked rows cannot establish absence', async () => {
  for (const rows of [row('122') + row('124'), row('124') + row('124') + row('122'), row('124', { gallery: 'other' }) + row('122')]) {
    const h = setup([{ body: list(rows) }, { body: empty }], { reserveDeletionProbe: async () => { throw Error('must not reserve'); } });
    assert.equal((await h.collect(job)).state, 'alive'); assert.equal(articleCalls(h).length, 0);
  }
});

test('bracket calculations preserve post numbers beyond Number precision', async () => {
  const big = { ...job, url: url.replace('no=123', 'no=9007199254740993'), key: 'mgallery:example:9007199254740993' };
  let reserved = 0;
  const h = setup([{ body: list(row('9007199254740994') + row('9007199254740992')) }, { body: empty }], { reserveDeletionProbe: async () => { reserved++; return false; } });
  await h.collect(big); assert.equal(reserved, 1); assert.equal(articleCalls(h).length, 0);
});

test('failed scheduled list checks preserve successfully collected comments', async () => {
  const h = setup([{ body: list() }, { body: empty }, { body: page(1, 1, [comment(11)], 1) }, { status: 503, body: 'unavailable' }]);
  const first = await h.collect(job); h.time(130000);
  const result = await h.collect({ ...job, monitorState: first.monitorState });
  assert.equal(result.state, 'alive'); assert.equal(result.comments.length, 1); assert.match(result.monitoringError, /503/);
});

test('body text, foreign deletion sentinel and generic 404 cannot confirm deletion', async () => {
  for (const response of [{ body: '<div>삭제된 글입니다.</div>' }, { status: 404, body: 'Not found' },
    { status: 404, body: deleted.replace('/example/', '/other/') }, { body: `<div>${deleted}</div>` }]) {
    const h = setup([{ body: list(row('124') + row('122')) }, { body: empty }, response], { reserveDeletionProbe: async () => true });
    assert.equal((await h.collect(job)).state, 'alive');
  }
});

test('bad identity, gallery context and mismatched exact-row authors are rejected', async () => {
  const invalid = setup([]); await assert.rejects(invalid.collect({ ...job, url: 'https://evil.test' })); assert.equal(invalid.calls.length, 0);
  for (const body of [list().replace('id="id" value="example"', 'id="id" value="other"'), list().replace('id="e_s_n_o"', 'id="missing"'), list(row('123', { uid: 'different' }))]) {
    const h = setup([{ body }]); await assert.rejects(h.collect(job)); assert.equal(h.calls.length, 1);
  }
});

test('failed comment API invalidates token and next pass reboots from a list', async () => {
  const h = setup([{ body: list() }, { status: 429, body: 'too many requests' }, { body: list() }, { body: empty }]);
  await assert.rejects(h.collect(job)); await h.collect(job);
  assert.equal(h.calls.filter(c => c.url.includes('/lists/')).length, 2); assert.equal(articleCalls(h).length, 0);
});

test('expired cached token refreshes from a listing without article fallback', async () => {
  const h = setup([{ body: list() }, { body: empty }, { body: list() }, { body: empty }]);
  const first = await h.collect(job); h.time(400000); await h.collect({ ...job, monitorState: first.monitorState });
  assert.equal(h.calls.filter(c => c.url.includes('/lists/')).length, 2); assert.equal(articleCalls(h).length, 0);
});

test('malformed, blocked and failed comment responses remain errors', async () => {
  for (const response of [{ body: '<html>로그인 필요</html>' }, { status: 429, body: 'too many requests' },
    { body: { total_cnt: 2, comments: null } }, new Error('connection reset'), { body: page(9, 9, [comment(1)]) }]) {
    await assert.rejects(setup([{ body: list() }, response]).collect(job));
  }
});

test('a later-page network failure returns earlier comments with a reset cursor', async () => {
  const h = setup([{ body: list() }, { body: page(1, 2, [comment(1)], 2) }, new Error('connection reset')]);
  const result = await h.collect(job);
  assert.equal(result.comments.length, 1); assert.equal(result.complete, false); assert.equal(result.nextPage, 1);
  assert.match(result.monitoringError, /connection reset/); assert.equal(articleCalls(h).length, 0);
});

test('gallery list inline type declaration is read as data and never executed', async () => {
  const body = list().replace('<input id="_GALLTYPE_" value="M">', '<script>var _GALLERY_TYPE_ = "M"; throw Error("never execute");</script>');
  const h = setup([{ body }, { body: empty }]);
  await h.collect(job); assert.equal(new URLSearchParams(apiCalls(h)[0].options.body).get('_GALLTYPE_'), 'M');
  const missing = setup([{ body: list().replace('<input id="_GALLTYPE_" value="M">', '') }]);
  await assert.rejects(missing.collect(job), /종류/);
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

test('all supported gallery paths keep their list route and actual declared request type', async () => {
  for (const [prefix, kind, type] of [['', 'board', 'G'], ['mgallery/', 'mgallery', 'M'], ['mini/', 'mini', 'MI'], ['person/', 'person', 'PR']]) {
    const targetUrl = `https://gall.dcinside.com/${prefix}board/view/?id=example&no=123`;
    const body = list().replaceAll('/mgallery/board/view/', `/${prefix}board/view/`).replace('id="_GALLTYPE_" value="M"', `id="_GALLTYPE_" value="${type}"`);
    const h = setup([{ body }, { body: empty }]);
    const result = await h.collect({ ...job, url: targetUrl, key: `${kind}:example:123` });
    assert.equal(result.resetDeletionProbe, true);
    assert.equal(h.calls[0].url, `https://gall.dcinside.com/${prefix}board/lists/?id=example&page=1`);
    assert.equal(new URLSearchParams(apiCalls(h)[0].options.body).get('_GALLTYPE_'), type);
  }
});
