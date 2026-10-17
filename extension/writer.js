(function () {
  'use strict';
  if (!/\/board\/write\/?$/.test(location.pathname) || new URL(location.href).searchParams.has('no')) return;
  let settings = {};
  let selected = false;
  let toggle;

  function send(message) {
    try { return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null); }
    catch { return Promise.resolve(null); }
  }
  function arm() {
    void send({ type: 'WRITE_ARM', enabled: settings.autoSave !== false && (settings.allOwnPosts === true || selected) });
  }
  function render() {
    const cancel = document.querySelector('#write_wrap .btn_box.write > .btn_grey.cancle');
    if (!cancel || !/\/board\/write\/?$/.test(location.pathname)) return;
    if (settings.allOwnPosts) { toggle?.remove(); toggle = null; return; }
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn_grey dca-backup-toggle';
      toggle.textContent = '댓글 백업';
      toggle.addEventListener('click', () => {
        selected = !selected;
        render();
        arm();
      });
      cancel.before(toggle);
    }
    toggle.disabled = settings.autoSave === false;
    toggle.classList.toggle('dca-selected', selected);
    toggle.setAttribute('aria-pressed', String(selected));
  }
  document.addEventListener('dc-comment-archive-write-success', event => {
    if (settings.autoSave === false || (!selected && !settings.allOwnPosts)) return;
    try {
      const data = JSON.parse(event.detail);
      const url = new URL(data.url);
      if (url.origin !== location.origin || !/\/board\/view\/?$/.test(url.pathname) || !/^\d+$/.test(url.searchParams.get('no') || '')) return;
      // Queue the extension message synchronously, before the site's redirect handler runs.
      void send({ type: 'WRITE_SUCCESS', url: url.href, title: String(data.title || '').slice(0, 500) });
    } catch { /* Ignore malformed page events. Background validates registration. */ }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings?.newValue) return;
    settings = changes.settings.newValue;
    render(); arm();
  });
  function refreshSettings() {
    return send({ type: 'GET_SETTINGS' }).then(result => {
      if (!result?.ok) return;
      settings = result.settings || {};
      render(); arm();
    });
  }
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message.type === 'CONFIG_CHANGED') void refreshSettings();
  });
  void refreshSettings();
})();
