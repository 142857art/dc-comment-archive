(function (root) {
  'use strict';
  function parseNotice(raw) {
    const post = root.DCArchive.parsePostUrl(raw?.url);
    if (!post) return null;
    const url = new URL(raw.url);
    const focus = url.searchParams.get('fcno') || '';
    const parent = url.searchParams.get('fpno') || '';
    if (focus && !/^[1-9]\d{0,19}$/.test(focus)) return null;
    if (parent && !/^-?\d{1,20}$/.test(parent)) return null;
    const text = typeof raw.text === 'string' ? raw.text.replace(/\bNEW\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
    // Other alarm types (recommendations, manager notices, etc.) do not trigger a fetch.
    if (!focus && !/댓글|답글/.test(text)) return null;
    const target = new URL(post.url);
    if (focus) target.searchParams.set('fcno', focus);
    if (parent) target.searchParams.set('fpno', parent);
    return { ...post, url: target.href, focus, parent, text,
      fingerprint: `${post.key}:${focus ? 'comment:' + focus : 'notice:' + text}` };
  }
  function readNotice(anchor, baseUrl) {
    let url;
    try { url = new URL(anchor.getAttribute('href'), baseUrl).href; } catch { return null; }
    return parseNotice({ url, text: anchor.textContent });
  }
  function inertHtml(doc, html) {
    const template = doc.createElement('template');
    template.innerHTML = html;
    return template.content;
  }
  function commentsFromResponse(doc, response) {
    if (!Array.isArray(response?.comments)) {
      if (response?.comments === null && Number(response.total_cnt) === 0) return [];
      throw new Error('댓글 응답을 읽을 수 없습니다.');
    }
    return response.comments.filter(c => c && c.del_yn !== 'Y' && c.nicktype !== 'COMMENT_BOY').map(c => {
      const memo = inertHtml(doc, String(c.memo || ''));
      const media = [...memo.querySelectorAll('img,video,audio,source')].map(el => {
        const src = el.getAttribute('src') || el.getAttribute('data-src');
        let url = '';
        if (src) { try { url = root.DCArchive.safeMediaUrl(new URL(src, 'https://gall.dcinside.com').href); } catch {} }
        return { url, alt: el.getAttribute('alt') || el.getAttribute('title') || '디시콘 / 미디어' };
      }).filter(m => m.url);
      return { id: String(c.no || ''), parentId: c.c_no && String(c.c_no) !== '0' ? String(c.c_no) : '',
        author: String(c.name || ''), date: String(c.reg_date || ''), text: root.DCExtractor.plainText(memo), media };
    });
  }
  root.DCNotifications = { parseNotice, readNotice, inertHtml, commentsFromResponse };
  if (typeof module !== 'undefined') module.exports = root.DCNotifications;
})(globalThis);
