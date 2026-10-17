/* Shared by the isolated content script, service worker and Node tests. */
(function (root) {
  'use strict';
  const DEFAULT_SETTINGS = { ownUid: '', autoSave: true, allOwnPosts: false, pollSeconds: 3, idleMinutes: 10 };
  function normalizeSettings(raw = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...raw, ownUid: normalizeUid(raw.ownUid || '') };
    if (!Number.isInteger(Number(settings.pollSeconds)) || settings.pollSeconds < 1 || settings.pollSeconds > 3600) throw new Error('확인 간격은 1~3600초로 입력해 주세요.');
    if (!Number.isInteger(Number(settings.idleMinutes)) || settings.idleMinutes < 1 || settings.idleMinutes > 1440) throw new Error('감시 종료 시간은 1~1440분으로 입력해 주세요.');
    return { ownUid: settings.ownUid, autoSave: settings.autoSave !== false, allOwnPosts: settings.allOwnPosts === true,
      pollSeconds: Number(settings.pollSeconds), idleMinutes: Number(settings.idleMinutes) };
  }
  function parseWriteUrl(value) {
    try {
      const url = new URL(value);
      if (!/^\/(?:mgallery\/|mini\/|person\/)?board\/write\/?$/.test(url.pathname) || url.searchParams.has('no')) return null;
      return parsePostUrl(value.replace(/\/write(?=\/|\?)/, '/view') + '&no=1');
    } catch { return null; }
  }
  const str = (value, max = 20000) => typeof value === 'string' ? value.slice(0, max).trim() : '';
  function normalizeUid(value) {
    const uid = str(value, 200).toLowerCase();
    if (!uid) return '';
    if (!/^[a-z0-9_-]{1,100}$/.test(uid)) throw new Error('내 갤로그 ID를 확인해 주세요. URL이나 닉네임은 입력할 수 없습니다.');
    return uid;
  }
  function parsePostUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://gall.dcinside.com') return null;
      const path = url.pathname.match(/^\/(?:((?:mgallery|mini|person))\/)?board\/view\/?$/);
      const gallery = url.searchParams.get('id');
      const no = url.searchParams.get('no');
      if (!path || !/^[a-zA-Z0-9_-]{1,100}$/.test(gallery || '') || !/^[1-9]\d{0,19}$/.test(no || '')) return null;
      const kind = path[1] || 'board';
      return { key: `${kind}:${gallery}:${no}`, galleryId: gallery, no,
        url: `https://gall.dcinside.com/${path[1] ? path[1] + '/' : ''}board/view/?id=${encodeURIComponent(gallery)}&no=${no}` };
    } catch { return null; }
  }
  function safeMediaUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      return url.hostname === 'dcinside.com' || url.hostname.endsWith('.dcinside.com') ? url.href : '';
    } catch { return ''; }
  }
  function sanitizeSnapshot(raw, sourceUrl) {
    const source = parsePostUrl(sourceUrl);
    const post = parsePostUrl(raw?.url);
    if (!source || !post || source.key !== post.key) throw new Error('글 주소를 확인할 수 없습니다.');
    if (!str(raw.title, 500)) throw new Error('글 제목을 읽을 수 없습니다.');
    if (!Array.isArray(raw.comments) || raw.comments.length > 10000) throw new Error('댓글 데이터가 올바르지 않습니다.');
    const comments = new Map();
    for (const item of raw.comments) {
      const id = str(item?.id, 30);
      if (!/^\d+$/.test(id) || item.deleted) continue;
      const media = (Array.isArray(item.media) ? item.media : []).slice(0, 20).map(m => ({
        url: safeMediaUrl(str(m?.url, 4000)), alt: str(m?.alt, 500) || '첨부 미디어'
      })).filter(m => m.url);
      const text = str(item.text);
      if (!text && !media.length) continue;
      comments.set(id, { id, parentId: /^\d+$/.test(item.parentId || '') ? item.parentId : '',
        author: str(item.author, 200) || '알 수 없음', text, date: str(item.date, 100), media });
    }
    return { ...post, title: str(raw.title, 500), gallery: str(raw.gallery, 200) || post.galleryId,
      author: str(raw.author, 200), authorUid: normalizeUid(raw.authorUid || ''), comments: [...comments.values()] };
  }
  function isOwnPost(post, settings) {
    return Boolean(settings.autoSave && settings.ownUid && post.authorUid &&
      normalizeUid(settings.ownUid) === normalizeUid(post.authorUid));
  }
  function mergePost(previous, snapshot, now = new Date().toISOString()) {
    const comments = new Map((previous?.comments || []).map(c => [c.id, c]));
    for (const item of snapshot.comments) {
      const old = comments.get(item.id);
      const changed = old && (old.text !== item.text || JSON.stringify(old.media) !== JSON.stringify(item.media));
      const history = old?.history ? [...old.history] : [];
      if (changed) history.push({ text: old.text, date: old.date, media: old.media, capturedAt: old.lastSeenAt });
      comments.set(item.id, { ...item, firstSeenAt: old?.firstSeenAt || now, lastSeenAt: now, history });
    }
    return { ...previous, ...snapshot, firstSavedAt: previous?.firstSavedAt || now,
      lastSavedAt: now, comments: [...comments.values()] };
  }
  const api = { DEFAULT_SETTINGS, normalizeSettings, normalizeUid, parsePostUrl, parseWriteUrl, safeMediaUrl, sanitizeSnapshot, isOwnPost, mergePost };
  root.DCArchive = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
