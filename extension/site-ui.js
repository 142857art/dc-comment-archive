(function () {
  'use strict';
  if (window.top !== window) return;
  const shown = new Set();
  let pending = false;
  let again = false;
  let container;
  function send(message) {
    try { return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null); }
    catch { return Promise.resolve(null); }
  }
  function render(notice) {
    if (!notice?.key || shown.has(notice.key)) return;
    shown.add(notice.key);
    if (!container) {
      container = document.createElement('div');
      container.id = 'dca-deletion-notices';
      container.setAttribute('aria-live', 'polite');
      document.body.append(container);
    }
    const card = document.createElement('div');
    card.className = 'dca-one-noticewrap';
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'dca-one-notice-text';
    open.textContent = `삭제된 글 · ${notice.title || '제목 없음'} · 댓글 ${Number(notice.count) || 0}개`;
    open.addEventListener('click', async () => {
      open.disabled = true;
      const result = await send({ type: 'OPEN_ARCHIVE', key: notice.key });
      if (result?.ok) { await send({ type: 'ACK_DELETION', key: notice.key }); card.remove(); }
      else { open.disabled = false; }
    });
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'dca-notice-close'; close.textContent = '×';
    close.setAttribute('aria-label', '삭제 알림 닫기');
    close.addEventListener('click', () => { void send({ type: 'ACK_DELETION', key: notice.key }); card.remove(); });
    card.append(open, close); container.append(card);
  }
  async function check() {
    if (document.visibilityState === 'hidden') return;
    if (pending) { again = true; return; }
    pending = true;
    const result = await send({ type: 'GET_DELETION_NOTICES' });
    if (result?.ok) for (const notice of result.notices || []) render(notice);
    pending = false;
    if (again) { again = false; void check(); }
  }
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'DELETE_NOTICE_AVAILABLE') void check(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void check(); });
  void check();
})();
