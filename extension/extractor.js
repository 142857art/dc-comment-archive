(function (root) {
  'use strict';
  function plainText(element) {
    if (!element) return '';
    const copy = element.cloneNode(true);
    copy.querySelectorAll('script,style,button,.coment_dccon_info,.blind').forEach(e => e.remove());
    copy.querySelectorAll('br').forEach(e => e.replaceWith('\n'));
    copy.querySelectorAll('img').forEach(e => e.replaceWith(e.getAttribute('alt') ? `[${e.getAttribute('alt')}]` : ''));
    return copy.textContent.replace(/\u00a0/g, ' ').trim();
  }
  function extractPostMetadata(doc, url) {
    const identity = root.DCArchive.parsePostUrl(url);
    const head = doc.querySelector('.gallview_head');
    const writer = head?.querySelector('.gall_writer[data-uid]');
    const title = plainText(head?.querySelector('.title_subject'));
    if (!identity || !writer || !title) return null;
    return { ...identity, title, gallery: doc.querySelector('#gallery_name')?.value || identity.galleryId,
      author: writer.getAttribute('data-nick') || plainText(writer.querySelector('.nickname')),
      authorUid: writer.getAttribute('data-uid') || '' };
  }
  function extractPost(doc, url) {
    const metadata = extractPostMetadata(doc, url);
    if (!metadata) return null;
    const identity = metadata;
    const comments = [];
    const wrap = doc.getElementById(`comment_wrap_${identity.no}`);
    for (const row of wrap?.querySelectorAll('.cmt_info[data-no], .reply_info[data-no]') || []) {
      if (row.querySelector('.del_reply') || row.closest('.dory, .dory_reply')) continue;
      if (row.dataset.articleNo && row.dataset.articleNo !== identity.no) continue;
      const body = row.querySelector('.cmt_txtbox');
      const author = row.querySelector('.cmt_nickbox .gall_writer');
      if (!body || !author) continue;
      const media = [...body.querySelectorAll('img, video, audio, source')].map(el => {
        let value = el.getAttribute('src') || el.getAttribute('data-src') || '';
        if (!value.trim()) return { url: '', alt: '' };
        try { value = new URL(value, url).href; } catch { value = ''; }
        return { url: root.DCArchive.safeMediaUrl(value), alt: el.getAttribute('alt') || el.getAttribute('title') || '디시콘 / 미디어' };
      }).filter(m => m.url);
      comments.push({ id: row.dataset.no, parentId: row.classList.contains('reply_info') ?
        (row.closest('.reply_list')?.getAttribute('p-no') || row.closest('.reply_list')?.id.replace('reply_list_', '') || '') : '',
        author: author.getAttribute('data-nick') || plainText(author.querySelector('.nickname')),
        text: plainText(body), date: plainText(row.querySelector('.date_time')), media });
    }
    return { ...metadata, comments };
  }
  root.DCExtractor = { extractPost, extractPostMetadata, plainText };
  if (typeof module !== 'undefined') module.exports = root.DCExtractor;
})(globalThis);
