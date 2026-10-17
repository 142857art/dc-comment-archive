(() => {
  'use strict';
  if (location.origin !== 'https://gall.dcinside.com') return;
  const seen = new Set();
  const queued = [];
  const targets = new Set();
  let running = false;
  let timer;
  let bootstrap;
  let bootstrapTimer;
  const anchorSelector = '#alarmList .notice_list a.notice_txt[href], .alarmPopup a.one_notice_txt[href]';
  const send = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '알림 댓글을 저장하지 못했습니다.');
    return response;
  };
  async function processNotice(notice) {
    await send({ type: 'NOTICE_SIGNAL', notice });
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queued.length) {
        // Serial collection per tab keeps a burst from starting many requests at once.
        try { await processNotice(queued.shift()); }
        catch (error) { console.warn('디시 댓글 보관함:', error.message); }
      }
    } finally { running = false; }
  }
  function scan(baseline = false) {
    for (const anchor of document.querySelectorAll(anchorSelector)) {
      const notice = DCNotifications.readNotice(anchor, location.href);
      if (!notice || seen.has(notice.fingerprint)) continue;
      seen.add(notice.fingerprint);
      if (seen.size > 2000) seen.delete(seen.values().next().value);
      if (!baseline) queued.push(notice);
    }
    if (!baseline) void drain();
  }
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => scan(), 400);
  });
  function connect() {
    for (const target of document.querySelectorAll('#alarmList .notice_list, .alarmPopup')) {
      if (targets.has(target)) continue;
      targets.add(target);
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    }
    if (document.querySelector('#alarmList .notice_list') && document.querySelector('.alarmPopup')) {
      bootstrap?.disconnect();
      clearTimeout(bootstrapTimer);
      return true;
    }
    return false;
  }
  // Existing displayed alarms are a baseline, not a reason to rescan old posts.
  scan(true);
  if (!connect()) {
    bootstrap = new MutationObserver(() => {
      const previousSize = targets.size;
      connect();
      if (targets.size > previousSize) scan();
    });
    bootstrap.observe(document.body, { childList: true, subtree: true });
    bootstrapTimer = setTimeout(() => bootstrap.disconnect(), 10000);
  }
  addEventListener('pagehide', event => {
    if (!event.persisted) {
      observer.disconnect(); bootstrap?.disconnect(); clearTimeout(timer); clearTimeout(bootstrapTimer);
      queued.length = 0;
    }
  });
})();
