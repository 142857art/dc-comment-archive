(function (root) {
  'use strict';
  const MAX_PAGES = 10;
  const MAX_RESPONSE = 4 * 1024 * 1024;
  const LIST_INTERVAL = 30000;
  const CONTEXT_TTL = 5 * 60 * 1000;
  const contexts = new Map();
  function countNumber(value) {
    const text = String(value ?? '').trim().replace(/,/g, '');
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('댓글 수를 읽을 수 없습니다.');
    return Number(text);
  }
  function isDeletedResponse(html, identity) {
    // Only this entire server-generated response establishes deletion.
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
  function listUrl(identity, page) {
    const url = new URL(identity.url.replace('/view/', '/lists/'));
    url.search = new URLSearchParams({ id: identity.galleryId, page: String(page) }).toString();
    return url.href;
  }
  function inspectList(html, identity, expectedUid) {
    const value = selector => html.querySelector(selector)?.getAttribute('value') || '';
    const ids = [...html.querySelectorAll('#id, #gallery_id')].map(input => input.getAttribute('value')).filter(Boolean);
    if (!ids.length || ids.some(id => id !== identity.galleryId) || !value('#e_s_n_o')) throw new Error('갤러리 목록 요청 정보를 확인할 수 없습니다.');
    const rows = [...html.querySelectorAll('tr[data-no]')];
    const ordinary = [];
    let present = false;
    for (const row of rows) {
      const no = row.getAttribute('data-no');
      if (!/^[1-9]\d{0,19}$/.test(no || '')) continue;
      const links = [...row.querySelectorAll('.gall_tit a[href]')].map(a => {
        try { return root.DCArchive.parsePostUrl(new URL(a.getAttribute('href'), identity.url).href); } catch { return null; }
      });
      if (!links.some(post => post && post.galleryId === identity.galleryId && post.no === no && post.key.split(':')[0] === identity.key.split(':')[0])) continue;
      if (no === identity.no) {
        const uid = row.querySelector('.gall_writer[data-uid]')?.getAttribute('data-uid');
        if (uid && expectedUid && root.DCArchive.normalizeUid(uid) !== root.DCArchive.normalizeUid(expectedUid)) {
          const error = new Error('백업 대상 글의 작성자가 일치하지 않습니다.'); error.authorMismatch = true; throw error;
        }
        present = true;
      }
      if (row.querySelector('.gall_num')?.textContent.trim() === no) ordinary.push(BigInt(no));
    }
    const sorted = ordinary.length > 1 && ordinary.every((number, i) => !i || ordinary[i - 1] > number);
    const target = BigInt(identity.no);
    const min = sorted ? ordinary[ordinary.length - 1] : null;
    const max = sorted ? ordinary[0] : null;
    // Lists use a literal inline declaration instead of the view's hidden field.
    // Read only this value; never execute fetched scripts.
    const declarations = [...html.querySelectorAll('script:not([src])')].flatMap(script =>
      [...script.textContent.matchAll(/(?:var\s+)?_GALLERY_TYPE_\s*=\s*['"]([A-Z]{1,4})['"]/g)].map(match => match[1]));
    const gallType = value('#_GALLTYPE_') || declarations[0];
    if (!gallType || declarations.some(type => type !== gallType)) throw new Error('갤러리 종류를 확인할 수 없습니다.');
    return { present, bracketed: !present && sorted && target > min && target < max,
      direction: sorted && target < min ? 1 : sorted && target > max ? -1 : 0,
      context: { token: value('#e_s_n_o'), boardType: value('#board_type'), gallType } };
  }
  async function collectTarget(job, environment = {}) {
    const identity = root.DCArchive.parsePostUrl(job?.url);
    if (!identity || job.key !== identity.key) throw new Error('백업 대상 글 주소가 올바르지 않습니다.');
    const doc = environment.document || root.document;
    const fetcher = environment.fetch || root.fetch.bind(root);
    const now = typeof environment.now === 'function' ? environment.now() : environment.now ?? Date.now();
    const metadata = { ...identity, ...job.metadata, url: identity.url, key: identity.key };
    if (!metadata.title) throw new Error('백업 대상 글 제목을 확인할 수 없습니다.');
    if (job.expectedUid && root.DCArchive.normalizeUid(metadata.authorUid || '') !== root.DCArchive.normalizeUid(job.expectedUid)) throw new Error('백업 대상 글의 작성자가 일치하지 않습니다.');
    const cacheKey = identity.key.split(':').slice(0, 2).join(':');
    const monitorState = { lastListCheckAt: Number(job.monitorState?.lastListCheckAt) || 0,
      listPage: Number.isInteger(job.monitorState?.listPage) && job.monitorState.listPage > 0 && job.monitorState.listPage <= 1000000 ? job.monitorState.listPage : 1 };
    let context = contexts.get(cacheKey);
    let initialList;
    async function loadList(page) {
      const fetched = await request(listUrl(identity, page), {}, fetcher); requireOk(fetched.response);
      const result = inspectList(root.DCNotifications.inertHtml(doc, fetched.text), identity, job.expectedUid);
      context = { ...result.context, fetchedAt: now }; contexts.set(cacheKey, context);
      return result;
    }
    if (!context || now - context.fetchedAt >= CONTEXT_TTL || now < context.fetchedAt) initialList = await loadList(monitorState.listPage);
    const comments = new Map();
    const rawIds = new Set();
    let page = 1;
    let collectionCount;
    let complete = false;
    let unchanged = false;
    let cursor = null;
    let collectionError;
    let successfulPages = 0;
    try {
      for (let fetchedPages = 0; fetchedPages < MAX_PAGES; fetchedPages++) {
        const body = new URLSearchParams({ id: identity.galleryId, no: identity.no, cmt_id: identity.galleryId, cmt_no: identity.no,
          focus_cno: '', focus_pno: '', e_s_n_o: context.token, comment_page: String(page), sort: 'D', prevCnt: '',
          board_type: context.boardType, _GALLTYPE_: context.gallType, secret_article_key: '', clean: '', nptest: '' });
        const result = await request('https://gall.dcinside.com/board/comment/', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: body.toString() }, fetcher);
        requireOk(result.response);
        let response;
        try { response = JSON.parse(result.text); } catch { throw new Error('댓글 응답을 읽을 수 없습니다.'); }
        const responseCount = countNumber(response?.total_cnt);
        const parsed = root.DCNotifications.commentsFromResponse(doc, response);
        const changedDuringPaging = collectionCount !== undefined && responseCount !== collectionCount;
        collectionCount = responseCount;
        const resume = fetchedPages === 0 && Number.isSafeInteger(job.nextPage) && job.nextPage > 1 && job.collectionCount === collectionCount;
        if (fetchedPages === 0 && collectionCount === job.lastCount && !job.force && !resume) { unchanged = true; complete = true; break; }
        for (const comment of parsed) comments.set(comment.id, comment);
        for (const comment of response.comments || []) if (comment?.no) rawIds.add(String(comment.no));
        if (changedDuringPaging) { cursor = 1; break; }
        const next = nextPage(doc, response.pagination, page, rawIds.size, collectionCount);
        successfulPages++;
        if (next === null) { complete = true; break; }
        page = resume ? job.nextPage : next;
        cursor = page;
      }
    } catch (error) {
      contexts.delete(cacheKey);
      if (!successfulPages) throw error;
      // Keep comments from completed pages when a later page fails.
      complete = false; cursor = 1; collectionError = error.message;
    }
    const result = { state: 'alive', metadata, count: collectionCount, comments: unchanged ? null : [...comments.values()], complete,
      ...(complete ? {} : { nextPage: cursor || 1, collectionCount }), monitorState,
      ...(collectionError ? { monitoringError: collectionError } : {}) };
    // Listing failures must not discard a successful comment backup.
    if (initialList || !monitorState.lastListCheckAt || now - monitorState.lastListCheckAt >= LIST_INTERVAL || now < monitorState.lastListCheckAt) {
      monitorState.lastListCheckAt = now;
      try {
        let listing = initialList;
        const visited = new Set();
        for (let checked = 0; checked < 3; checked++) {
          const listPage = monitorState.listPage;
          visited.add(listPage);
          listing = listing || await loadList(listPage);
          if (listing.present) { result.resetDeletionProbe = true; break; }
          if (listing.bracketed) {
            // Reservation persists before the article request, surviving offscreen restarts.
            if (environment.reserveDeletionProbe && await environment.reserveDeletionProbe()) {
              const probe = await request(identity.url, {}, fetcher);
              if (isDeletedResponse(probe.text, identity)) result.state = 'deleted';
              else requireOk(probe.response);
            }
            break;
          }
          const next = listPage + listing.direction;
          if (!listing.direction || next < 1 || next > 1000000 || visited.has(next)) break;
          monitorState.listPage = next;
          listing = null;
        }
      } catch (error) {
        if (error.authorMismatch) throw error;
        result.monitoringError = error.message;
      }
    }
    return result;
  }
  root.DCCollector = { collectTarget, countNumber, isDeletedResponse, nextPage, inspectList, MAX_PAGES, LIST_INTERVAL };
  if (typeof module !== 'undefined') module.exports = root.DCCollector;
})(globalThis);
