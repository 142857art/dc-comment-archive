(() => {
  'use strict';
  let collecting = false;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'offscreen' || message.type !== 'COLLECT_TARGET') return;
    if (sender.id !== chrome.runtime.id || sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) {
      sendResponse({ ok: false, error: '허용되지 않은 수집 요청입니다.' });
      return;
    }
    if (collecting) {
      sendResponse({ ok: false, error: '다른 글의 댓글을 확인 중입니다.' });
      return;
    }
    collecting = true;
    DCCollector.collectTarget(message.job).then(
      result => { collecting = false; sendResponse({ ok: true, result }); },
      error => { collecting = false; sendResponse({ ok: false, error: error.message || '댓글을 수집하지 못했습니다.' }); }
    );
    return true;
  });
})();
