const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
const { core, script } = require('./load-scripts.cjs');
vm.runInThisContext(script('notification-core.js'), { filename: 'notification-core.js' });
const notices = globalThis.DCNotifications;
const url = 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123';

test('focused website comment alerts keep only relevant URL parameters and deduplicate list versus popup', () => {
  const list = notices.parseNotice({ url: `${url}&fcno=55&fpno=44&page=4`, text: '[갤러리] 내 글에 댓글이 등록되었습니다.' });
  const popup = notices.parseNotice({ url: `${url}&fcno=55&fpno=44`, text: 'NEW [갤러리] 댓글 알림' });
  assert.equal(list.fingerprint, popup.fingerprint);
  assert.equal(list.focus, '55');
  assert.equal(list.parent, '44');
  assert.equal(new URL(list.url).searchParams.has('page'), false);
  assert.equal(notices.parseNotice({ url, text: '내 글의 댓글이 등록되었습니다.' }).focus, '');
});

test('recommendation and malformed or foreign comment alerts do not trigger fetches', () => {
  for (const raw of [
    { url, text: '[실시간 베스트] 추천 글' },
    { url: `${url}&fcno=bad`, text: '댓글' },
    { url: `${url}&fcno=55&fpno=script`, text: '댓글' },
    { url: 'https://evil.test/board/view/?id=example&no=123&fcno=55', text: '댓글' },
    { url: 'https://gall.dcinside.com/board/lists/?id=example', text: '댓글' }
  ]) assert.equal(notices.parseNotice(raw), null);
});

test('actual list and one-line popup anchor structure produces the same focused notice', () => {
  const { document } = parseHTML(`<html><body><div id="alarmList"><ul class="notice_list"><li>
    <a class="notice_txt noline" href="/mgallery/board/view/?id=example&no=123&fcno=55">[갤러리] 댓글이 등록되었습니다.</a>
    <button><span class="blind">알림삭제</span></button></li></ul></div>
    <div class="alarmPopup"><div class="pop_content one_noticewrap"><a class="one_notice_txt" href="${url}&fcno=55">
    <span class="new"><em class="blind">NEW</em></span>[갤러리] 댓글이 등록되었습니다.</a><button>닫기</button></div></div></body></html>`);
  const list = notices.readNotice(document.querySelector('.notice_txt'), url);
  const popup = notices.readNotice(document.querySelector('.one_notice_txt'), url);
  assert.equal(list.fingerprint, popup.fingerprint);
  assert.doesNotMatch(list.text, /삭제|닫기/);
  assert.doesNotMatch(popup.text, /NEW|닫기/);
});

test('comment JSON keeps text, reply parent and safe media while filtering deleted and robot rows', () => {
  const { document } = parseHTML('<html></html>');
  // linkedom returns null for DocumentFragment.textContent; browsers return descendant text.
  const plainText = globalThis.DCExtractor.plainText;
  globalThis.DCExtractor.plainText = fragment => {
    const wrapper = document.createElement('div');
    wrapper.append(fragment.cloneNode(true));
    return plainText(wrapper);
  };
  try {
  const rows = notices.commentsFromResponse(document, { comments: [
    { no: 55, c_no: 44, name: '독자', reg_date: '10.16 12:00', memo: '첫 줄<br>둘째 줄<img src="https://dcimg.dcinside.com/a.png" alt="콘"><video><source src="//dcimg.dcinside.com/a.webm"></video><script>alert(1)</script><button>답글쓰기</button><img src="javascript:alert(1)">' },
    { no: 56, c_no: 0, name: '다른 독자', memo: '일반 댓글' },
    { no: 57, memo: '삭제된 댓글', del_yn: 'Y' },
    { no: 58, memo: '댓글돌이', nicktype: 'COMMENT_BOY' }
  ] });
  const sanitized = core.sanitizeSnapshot({ url, title: '내 글', authorUid: 'owner', comments: rows }, url);
  assert.deepEqual(sanitized.comments.map(c => [c.id, c.parentId, c.text]), [['55', '44', '첫 줄\n둘째 줄[콘]'], ['56', '', '일반 댓글']]);
  assert.deepEqual(sanitized.comments[0].media.map(m => m.url), ['https://dcimg.dcinside.com/a.png', 'https://dcimg.dcinside.com/a.webm']);
  } finally { globalThis.DCExtractor.plainText = plainText; }
});

test('empty comment responses are distinct from unavailable or malformed responses', () => {
  const { document } = parseHTML('<html></html>');
  assert.deepEqual(notices.commentsFromResponse(document, { comments: null, total_cnt: 0 }), []);
  assert.deepEqual(notices.commentsFromResponse(document, { comments: [] }), []);
  assert.throws(() => notices.commentsFromResponse(document, { comments: null, total_cnt: 5 }));
  assert.throws(() => notices.commentsFromResponse(document, { error: '로그인 필요' }));
});
