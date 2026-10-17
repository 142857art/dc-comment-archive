(function () {
  'use strict';
  const eventName = 'dc-comment-archive-write-success';
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();

  function metadata() {
    if (!/\/board\/write\/?$/.test(location.pathname)) return null;
    const form = document.querySelector('#write_wrap form#write');
    if (!form || form.querySelector('input[name="no"]')?.value) return null;
    const id = form.querySelector('input[name="id"]')?.value || new URL(location.href).searchParams.get('id');
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    return { id, title: String(form.querySelector('input[name="subject"]')?.value || '').slice(0, 500) };
  }

  function complete(xhr, record) {
    if (record.sent || !record.meta || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return;
    let response;
    try { response = xhr.responseText; } catch { return; }
    const parts = String(response).split('||');
    if (parts[0].trim() !== 'true' || !/^\d+$/.test(parts[1]?.trim() || '')) return;
    record.sent = true;
    const no = parts[1].trim();
    const url = new URL(location.pathname.replace(/\/write\/?$/, '/view/'), location.origin);
    url.searchParams.set('id', record.meta.id);
    url.searchParams.set('no', no);
    document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify({ ...record.meta, no, url: url.href }) }));
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let eligible = false;
    try {
      const target = new URL(url, location.href);
      eligible = String(method).toUpperCase() === 'POST' && target.origin === location.origin && target.pathname === '/board/forms/article_submit';
    } catch { /* Leave unrelated requests untouched. */ }
    const record = { eligible, meta: null, sent: false };
    requests.set(this, record);
    // Register before jQuery installs its completion handler. This also covers synchronous submissions.
    this.addEventListener('readystatechange', () => { if (requests.get(this) === record) complete(this, record); });
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const record = requests.get(this);
    if (record?.eligible) record.meta = metadata();
    const result = originalSend.apply(this, args);
    if (record?.eligible) complete(this, record);
    return result;
  };
})();
