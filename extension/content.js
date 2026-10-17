(() => {
  'use strict';
  const source = DCArchive.parsePostUrl(location.href);
  if (!source) return;
  let signature = '', lastError = '', timer, stopped = false;
  const send = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '확장 프로그램을 다시 불러온 뒤 페이지를 새로고침해 주세요.');
    return response;
  };
  function count() {
    const wrap = document.getElementById(`comment_wrap_${source.no}`);
    const loaded = wrap?.getAttribute('data-comment-cnt');
    const value = loaded != null ? loaded : document.querySelector('#comment_cnt')?.value;
    if (value != null && /^\d+$/.test(String(value))) return Number(value);
    const displayed = document.querySelector(`#comment_total_${source.no}`)?.textContent || document.querySelector('.gall_comment')?.textContent || '';
    const match = displayed.replace(/,/g, '').match(/\d+/);
    return match ? Number(match[0]) : null;
  }
  async function observePost() {
    const post = DCExtractor.extractPostMetadata(document, location.href);
    if (!post) return;
    const current = count(), next = JSON.stringify([post.url, post.authorUid, current]);
    if (signature === next) return;
    await send({ type: 'POST_SEEN', post, count: current });
    signature = next; lastError = '';
  }
  function schedule() {
    if (stopped) return;
    clearTimeout(timer); timer = setTimeout(() => { observePost().catch(error => { lastError = error.message; }); }, 400);
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'CONFIG_CHANGED') { signature = ''; schedule(); respond({ ok: true }); return; }
    if (message.type === 'CAPTURE_NOW') {
      const post = DCExtractor.extractPostMetadata(document, location.href);
      if (!post) { respond({ ok: false, error: '글을 읽을 수 없습니다.' }); return; }
      send({ type: 'REGISTER_TARGET', post, reason: 'manual' }).then(respond, error => respond({ ok: false, error: error.message })); return true;
    }
    if (message.type === 'PAGE_STATUS') {
      send({ type: 'GET_CONFIG' }).then(config => {
        const post = DCExtractor.extractPostMetadata(document, location.href);
        const labels = { active: '백그라운드 감시 중', expired: '무변화 시간 경과 · 감시 종료', stopped: '감시 중지됨', deleted: '삭제 확인됨' };
        respond({ ok: true, post, tracked: config.tracked, count: config.count,
          status: lastError || config.target?.lastError || labels[config.target?.status] || '백업 대상 아님' });
      }, error => respond({ ok: false, error: error.message })); return true;
    }
  });
  const observer = new MutationObserver(schedule);
  for (const node of [document.querySelector('.gallview_head'), document.getElementById(`comment_wrap_${source.no}`)]) {
    if (node) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-comment-cnt', 'data-uid'] });
  }
  addEventListener('pagehide', event => { stopped = true; clearTimeout(timer); if (!event.persisted) observer.disconnect(); });
  addEventListener('pageshow', event => { if (event.persisted) { stopped = false; schedule(); } });
  observePost().catch(error => { lastError = error.message; });
})();
