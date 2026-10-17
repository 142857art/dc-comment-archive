const test = require('node:test');
const assert = require('node:assert/strict');
const { core } = require('./load-scripts.cjs');

const url = 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123';
const comment = (id, text = '댓글') => ({ id, parentId: '', author: '독자', text, date: '10.16 12:00', media: [] });
const snapshot = (comments = []) => core.sanitizeSnapshot({ url, title: '내 글', author: '나', authorUid: 'owner', comments }, url);

test('monitoring settings default to 3 seconds and retain valid saved intervals', () => {
  assert.equal(core.DEFAULT_SETTINGS.pollSeconds, 3);
  assert.equal(core.normalizeSettings().pollSeconds, 3);
  assert.equal(core.normalizeSettings().idleMinutes, 10);
  for (const pollSeconds of [1, 2, 3, 30, 3600]) {
    assert.equal(core.normalizeSettings({ pollSeconds }).pollSeconds, pollSeconds);
  }
  assert.equal(core.normalizeSettings({ pollSeconds: '1' }).pollSeconds, 1);
  for (const pollSeconds of [0, -1, 0.5, 1.5, 3601, '', null, 'invalid']) {
    assert.throws(() => core.normalizeSettings({ pollSeconds }), /1~3600초/);
  }
});

test('ownership uses stable UID, never nickname or anonymous identity', () => {
  const settings = { ownUid: 'OwNeR', autoSave: true };
  assert.equal(core.isOwnPost({ authorUid: 'owner', author: '이름변경' }, settings), true);
  assert.equal(core.isOwnPost({ authorUid: 'other', author: 'owner' }, settings), false);
  assert.equal(core.isOwnPost({ authorUid: '', author: 'owner' }, settings), false);
  assert.equal(core.isOwnPost({ authorUid: 'owner' }, { ...settings, autoSave: false }), false);
  assert.equal(core.isOwnPost({ authorUid: 'owner' }, { ownUid: '', autoSave: true }), false);
  assert.throws(() => core.normalizeUid('https://gallog.dcinside.com/owner'));
});

test('canonical URL retains gallery type and excludes paging parameters', () => {
  for (const prefix of ['', 'mgallery/', 'mini/', 'person/']) {
    const parsed = core.parsePostUrl(`https://gall.dcinside.com/${prefix}board/view?id=example&no=123&page=2`);
    assert.equal(parsed.url, `https://gall.dcinside.com/${prefix}board/view/?id=example&no=123`);
    assert.equal(parsed.key, `${prefix.slice(0, -1) || 'board'}:example:123`);
  }
  for (const invalid of ['http://gall.dcinside.com/board/view/?id=x&no=1',
    'https://gall.dcinside.com.evil.test/board/view/?id=x&no=1',
    'https://gall.dcinside.com/board/lists/?id=x&no=1',
    'https://gall.dcinside.com/board/view/?id=x&no=0',
    'https://gall.dcinside.com/board/view/?id=../x&no=1']) assert.equal(core.parsePostUrl(invalid), null);
});

test('snapshot rejects mismatched sources and removes deleted or duplicate rows', () => {
  const data = { url, title: '글', authorUid: 'owner', comments: [comment('1', 'old'), comment('1', 'new'),
    { ...comment('2'), deleted: true }, comment('invalid'), comment('3', '')] };
  assert.throws(() => core.sanitizeSnapshot(data, url.replace('no=123', 'no=124')));
  assert.throws(() => core.sanitizeSnapshot({ ...data, title: '' }, url));
  assert.deepEqual(core.sanitizeSnapshot(data, url).comments.map(c => [c.id, c.text]), [['1', 'new']]);
});

test('media accepts only HTTPS DC Inside domains without credentials', () => {
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,a', 'http://dcimg.dcinside.com/a.png',
    'https://dcinside.com.evil.test/a', 'https://user:pass@dcinside.com/a', 'https://evil.test/a']) {
    assert.equal(core.safeMediaUrl(bad), '');
  }
  const saved = snapshot([{ ...comment('1', ''), media: [{ url: 'https://dcimg.dcinside.com/a.png', alt: '콘' },
    { url: 'javascript:alert(1)', alt: 'bad' }] }]);
  assert.deepEqual(saved.comments[0].media, [{ url: 'https://dcimg.dcinside.com/a.png', alt: '콘' }]);
});

test('partial pages, later deletion and empty snapshots preserve prior comments', () => {
  const first = core.mergePost(null, snapshot([comment('1'), comment('2')]), '2026-10-16T01:00:00Z');
  const page2 = core.mergePost(first, snapshot([comment('3')]), '2026-10-16T01:01:00Z');
  const gone = core.mergePost(page2, snapshot([]), '2026-10-16T01:02:00Z');
  assert.deepEqual(gone.comments.map(c => c.id), ['1', '2', '3']);
  assert.equal(gone.firstSavedAt, first.firstSavedAt);
  assert.equal(gone.comments[0].lastSeenAt, first.lastSavedAt);
});

test('edits preserve old text and media once; identical rescans do not create history', () => {
  const first = core.mergePost(null, snapshot([comment('1', '수정 전')]), '2026-10-16T01:00:00Z');
  const edited = core.mergePost(first, snapshot([comment('1', '수정 후')]), '2026-10-16T01:01:00Z');
  const repeat = core.mergePost(edited, snapshot([comment('1', '수정 후')]), '2026-10-16T01:02:00Z');
  assert.equal(repeat.comments.length, 1);
  assert.equal(repeat.comments[0].firstSeenAt, first.lastSavedAt);
  assert.equal(repeat.comments[0].history.length, 1);
  assert.equal(repeat.comments[0].history[0].text, '수정 전');
  assert.equal(repeat.comments[0].history[0].capturedAt, first.lastSavedAt);
  assert.equal(first.comments[0].history.length, 0, 'merge must not mutate old snapshots');
});
