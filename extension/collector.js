(function (root) {
  'use strict';
  const MAX_PAGES = 10;
  const MAX_RESPONSE = 4 * 1024 * 1024;
  function countNumber(value) {
    const text = String(value ?? '').trim().replace(/,/g, '');
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('댓글 수를 읽을 수 없습니다.');
    return Number(text);
  }
  function isDeletedResponse(html, identity) {
    // DC's missing/deleted-post response is this entire server-generated script.
    // Never search article text for an error phrase or execute the redirect.
    const match = html.trim().match(/^<script(?:\s+type=["']text\/javascript["'])?\s*>\s*location\.replace\(["'](\/derror\/deleted\/([a-zA-Z0-9_-]+)\/([a-z_]+)\/([a-z_]+)\/(\d+))["']\);?\s*<\/script>$/);
    return Boolean(match && match[2] === identity.galleryId && match[5] === identity.no);
  }
  async function request(url, options, fetcher) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetcher(url, { ...options, credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal });
      const text = await response.text();
      if (text.length > MAX_RESPONSE) throw new Error('댓글 응답 크기가 너무 큽니다.');
      return { response, text };
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('글을 불러오지 못했습니다. 네트워크와 로그인 상태를 확인해 주세요.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function requireOk(response) {
    if (!response.ok) throw new Error(`댓글 확인 요청 실패 (HTTP ${response.status})`);
  }
  function nextPage(doc, pagination, current, rawCount, total) {
    if (typeof pagination === 'string' && pagination.trim()) {
      const fragment = root.DCNotifications.inertHtml(doc, pagination);
      const displayed = fragment.querySelector('em')?.textContent.trim();
      if (!displayed || countNumber(displayed) !== current) throw new Error('댓글 페이지가 일치하지 않습니다.');
      const pages = [...fragment.querySelectorAll('a[href]')].map(anchor => {
        const match = anchor.getAttribute('href').match(/^javascript:viewComments\(\s*(\d+)\s*,/);
        return match ? countNumber(match[1]) : 0;
      });
      return pages.some(page => page > current) ? current + 1 : null;
    }
    if (total === 0 || rawCount >= total) return null;
    throw new Error('댓글 페이지 정보를 읽을 수 없습니다.');
  }
  async function collectTarget(job, environment = {}) {
    const identity = root.DCArchive.parsePostUrl(job?.url);
    if (!identity || job.key !== identity.key) throw new Error('백업 대상 글 주소가 올바르지 않습니다.');
    const doc = environment.document || root.document;
    const fetcher = environment.fetch || root.fetch.bind(root);
    const fetched = await request(identity.url, {}, fetcher);
    if (isDeletedResponse(fetched.text, identity)) return { state: 'deleted' };
    requireOk(fetched.response);
    const html = root.DCNotifications.inertHtml(doc, fetched.text);
    const metadata = root.DCExtractor.extractPostMetadata(html, identity.url);
    if (!metadata || metadata.key !== identity.key) throw new Error('글 정보를 읽을 수 없습니다. 로그인 또는 접근 제한을 확인해 주세요.');
    if (job.expectedUid && root.DCArchive.normalizeUid(metadata.authorUid) !== root.DCArchive.normalizeUid(job.expectedUid)) {
      throw new Error('백업 대상 글의 작성자가 일치하지 않습니다.');
    }
    const count = countNumber(html.querySelector('#comment_cnt')?.getAttribute('value'));
    if (count === job.lastCount && !job.force) return { state: 'alive', metadata, count, comments: null, complete: true };
    if (!count) return { state: 'alive', metadata, count, comments: [], complete: true };
    const value = selector => html.querySelector(selector)?.getAttribute('value') || '';
    const token = value('#e_s_n_o');
    if (!token) throw new Error('댓글 요청 정보를 찾지 못했습니다.');
    let page = Number.isSafeInteger(job.nextPage) && job.nextPage > 1 && job.collectionCount === count ? job.nextPage : 1;
    const comments = new Map();
    const rawIds = new Set();
    let collectionCount = count;
    let complete = false;
    for (let fetchedPages = 0; fetchedPages < MAX_PAGES; fetchedPages++) {
      const body = new URLSearchParams({ id: identity.galleryId, no: identity.no, cmt_id: identity.galleryId, cmt_no: identity.no,
        focus_cno: '', focus_pno: '', e_s_n_o: token, comment_page: String(page), sort: 'D', prevCnt: '',
        board_type: value('#board_type'), _GALLTYPE_: value('#_GALLTYPE_'), secret_article_key: value('#secret_article_key'), clean: '', nptest: '' });
      const result = await request('https://gall.dcinside.com/board/comment/', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: body.toString() }, fetcher);
      requireOk(result.response);
      let response;
      try { response = JSON.parse(result.text); } catch { throw new Error('댓글 응답을 읽을 수 없습니다.'); }
      const responseCount = countNumber(response?.total_cnt);
      // A changing total while paging invalidates the cursor. Save what was read,
      // then start a fresh collection next pass instead of claiming completeness.
      const changedDuringPaging = responseCount !== collectionCount;
      collectionCount = responseCount;
      for (const comment of root.DCNotifications.commentsFromResponse(doc, response)) comments.set(comment.id, comment);
      for (const comment of response.comments || []) if (comment?.no) rawIds.add(String(comment.no));
      const next = nextPage(doc, response.pagination, page, rawIds.size, collectionCount);
      if (changedDuringPaging) return { state: 'alive', metadata, count: collectionCount, comments: [...comments.values()], complete: false, nextPage: 1, collectionCount };
      if (next === null) { complete = true; break; }
      page = next;
    }
    return { state: 'alive', metadata, count: collectionCount, comments: [...comments.values()], complete,
      ...(complete ? {} : { nextPage: page, collectionCount }) };
  }
  root.DCCollector = { collectTarget, countNumber, isDeletedResponse, nextPage, MAX_PAGES };
  if (typeof module !== 'undefined') module.exports = root.DCCollector;
})(globalThis);
