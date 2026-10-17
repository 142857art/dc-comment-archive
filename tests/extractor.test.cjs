const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { core, extractor: { extractPost } } = require('./load-scripts.cjs');

const url = 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123';
// Reduced structural fixtures from research/post.html and comment.js, never execute site scripts.
const row = (id, body, extra = '', cls = 'cmt_info') => `<li><div class="${cls} clear" data-no="${id}" ${extra}>
  <div class="addbox"><div class="cmt_nickbox"><span class="gall_writer ub-writer" data-nick="독자" data-uid="reader"><span class="nickname">독자</span></span></div>
  <div class="clear cmt_txtbox">${body}</div></div><div class="fr clear"><span class="date_time">10.16 12:00</span><button>삭제</button></div></div></li>`;
const document = (rows = '', uid = 'owner') => parseHTML(`<html><body>
  <span class="title_subject">목록의 다른 제목</span><input id="gallery_name" value="테스트 갤러리">
  <div class="gallview_head"><h3><span class="title_headtext">일반</span><span class="title_subject">진짜 글 제목</span></h3>
  <div class="gall_writer ub-writer" data-nick="글쓴이" data-uid="${uid}"><span class="nickname">글쓴이</span></div></div>
  <div id="comment_wrap_123"><ul class="cmt_list">${rows}</ul></div>
  <div id="comment_wrap_999">${row('900', '다른 글 댓글')}</div></body></html>`).document;

test('extracts current post, reply parents and line breaks without action labels', () => {
  const doc = document(row('1', '<p class="usertxt ub-word">첫 줄<br>둘째 줄</p><button>답글쓰기</button>', 'data-article-no="123"') +
    `<li><div class="reply show"><div class="reply_box"><ul class="reply_list" id="reply_list_1" p-no="1">${row('2', '<p>@독자 답글</p>', '', 'reply_info')}</ul></div></div></li>`);
  const saved = extractPost(doc, url);
  assert.equal(saved.title, '진짜 글 제목');
  assert.equal(saved.authorUid, 'owner');
  assert.equal(saved.gallery, '테스트 갤러리');
  assert.deepEqual(saved.comments.map(c => [c.id, c.parentId, c.text]), [['1', '', '첫 줄\n둘째 줄'], ['2', '1', '@독자 답글']]);
});

test('ignores deleted rows, automated comments, other article chunks and foreign wraps', () => {
  const doc = document(row('1', '보존', 'data-article-no="123"') + row('2', '<p class="del_reply">삭제된 댓글</p>') +
    row('3', '댓글돌이').replace('<li>', '<li class="dory">') + row('4', '이전 글', 'data-article-no="122"'));
  assert.deepEqual(extractPost(doc, url).comments.map(c => c.id), ['1']);
});

test('safe image and video attachments survive extraction; script and UI text are removed', () => {
  const doc = document(row('1', `<script>bad()</script><style>.bad{}</style><span class="blind">숨김</span>
    <img src="https://dcimg.dcinside.com/a.png" alt="디시콘"><video><source src="//dcimg.dcinside.com/a.webm"></video>
    <div class="coment_dccon_info"><span>패키지 정보</span><button>디시콘 보기</button></div><img src="https://evil.test/a.png">`));
  const saved = core.sanitizeSnapshot(extractPost(doc, url), url);
  assert.equal(saved.comments.length, 1);
  assert.equal(saved.comments[0].text, '[디시콘]');
  assert.deepEqual(saved.comments[0].media.map(m => m.url), ['https://dcimg.dcinside.com/a.png', 'https://dcimg.dcinside.com/a.webm']);
});

test('delayed comment DOM can be rescanned and a new page merges without loss', () => {
  const doc = document();
  const initial = extractPost(doc, url);
  assert.deepEqual(initial.comments, []);
  doc.querySelector('.cmt_list').innerHTML = row('1', '첫 페이지');
  const page1 = core.mergePost(null, core.sanitizeSnapshot(extractPost(doc, url), url));
  doc.querySelector('.cmt_list').innerHTML = row('2', '둘째 페이지');
  const page2 = core.mergePost(page1, core.sanitizeSnapshot(extractPost(doc, url), url));
  assert.deepEqual(page2.comments.map(c => c.text), ['첫 페이지', '둘째 페이지']);
});

test('anonymous authors remain anonymous and missing article head is rejected', () => {
  assert.equal(extractPost(document('', ''), url).authorUid, '');
  const doc = document();
  doc.querySelector('.gallview_head').remove();
  assert.equal(extractPost(doc, url), null);
  assert.equal(extractPost(document(), 'https://evil.test/'), null);
});
