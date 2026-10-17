'use strict';
importScripts('core.js', 'notification-core.js');
const { normalizeSettings, parsePostUrl, parseWriteUrl, sanitizeSnapshot, isOwnPost, mergePost } = DCArchive;
const ALARM = 'dc-archive-monitor';
let queue = Promise.resolve(), creatingOffscreen, ticking = false, collecting = false, sequence = 0;
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const serial = task => {
  const result = queue.then(async () => { await ready; return task(); });
  queue = result.catch(() => {}); return result;
};
const tk = key => `target:${key}`;
const pk = key => `post:${key}`;
const validKey = key => typeof key === 'string' && /^(board|mgallery|mini|person):[a-zA-Z0-9_-]+:[1-9]\d*$/.test(key);
async function get(key) { return (await chrome.storage.local.get(key))[key]; }
async function settings() { return normalizeSettings(await get('settings')); }
async function targets() { return Object.entries(await chrome.storage.local.get(null)).filter(([key]) => key.startsWith('target:')).map(([, t]) => t); }
function siteSender(sender) {
  try { return sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && new URL(sender.url).origin === 'https://gall.dcinside.com'; }
  catch { return false; }
}
function uiSender(sender) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('')) &&
    !sender.url.startsWith(chrome.runtime.getURL('offscreen.html'));
}
async function broadcast(type) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type })));
}
async function synchronize() {
  const config = await settings(), all = await targets(), now = Date.now();
  const updates = {};
  for (const t of all) if (t.status === 'active' && now >= t.expiresAt) {
    t.status = 'expired'; t.inFlightUntil = 0; updates[tk(t.key)] = t;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  const active = all.filter(t => t.status === 'active');
  if (config.autoSave && active.length) {
    const alarm = await chrome.alarms.get(ALARM);
    if (!alarm || alarm.periodInMinutes !== config.pollSeconds / 60) await chrome.alarms.create(ALARM, { periodInMinutes: config.pollSeconds / 60 });
  } else {
    await chrome.alarms.clear(ALARM);
    if (!all.some(t => t.inFlightUntil > now)) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] });
      if (contexts.length) await chrome.offscreen.closeDocument();
    }
  }
  const unread = all.filter(t => t.status === 'deleted' && !t.noticeAck).length;
  await chrome.action.setBadgeText({ text: unread ? String(unread) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2456a6' });
  await chrome.action.setTitle({ title: `디시 댓글 보관함 · 감시 ${active.length}개${unread ? ` · 삭제 ${unread}개` : ''}` });
}
async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: '백업 대상의 댓글 수와 삭제 응답을 탭 없이 읽습니다.' });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}
async function register(post, config, { manual = false, newlyWritten = false } = {}) {
  const identity = parsePostUrl(post?.url);
  if (!identity) throw new Error('글 주소가 올바르지 않습니다.');
  const previous = await get(tk(identity.key)), excluded = await get(`excluded:${identity.key}`);
  if (previous?.status === 'active' || (!manual && (previous || excluded))) return previous || null;
  const now = Date.now();
  const target = { ...identity, title: String(post.title || `글 ${identity.no}`).slice(0, 500),
    expectedUid: newlyWritten ? '' : String(post.authorUid || ''), author: String(post.author || '').slice(0, 200),
    gallery: String(post.gallery || identity.galleryId).slice(0, 200), status: 'active', lastCount: newlyWritten ? 0 : null,
    createdAt: now, lastActivityAt: now, expiresAt: now + config.idleMinutes * 60000,
    nextCheckAt: now + config.pollSeconds * 1000, generation: `${now}:${++sequence}`, inFlightUntil: 0, lastError: '', needsCollection: false };
  await chrome.storage.local.set({ [tk(identity.key)]: target });
  if (manual) await chrome.storage.local.remove(`excluded:${identity.key}`);
  await synchronize(); return target;
}
async function runTarget(key, force = false, scheduledAt) {
  const claim = await serial(async () => {
    if (collecting) return null;
    const config = await settings(), t = await get(tk(key)), now = Date.now();
    if (!config.autoSave || !t || t.status !== 'active') return null;
    if (now >= t.expiresAt) { await synchronize(); return null; }
    if (t.inFlightUntil > now || (!force && t.nextCheckAt > now)) return null;
    if (force && t.lastAttemptAt && now - t.lastAttemptAt < Math.min(config.pollSeconds, 5) * 1000) return null;
    const archived = await get(pk(key));
    t.inFlightUntil = now + 120000; t.lastAttemptAt = now;
    await chrome.storage.local.set({ [tk(key)]: t });
    collecting = true;
    return { ...t, metadata: { ...identityMetadata(t),
      author: t.author || archived?.author || '', authorUid: t.expectedUid || archived?.authorUid || '' }, force: force || t.needsCollection,
      scheduleBase: Number.isFinite(scheduledAt) ? Math.min(scheduledAt, now) : now };
  });
  if (!claim) return;
  try {
    let response;
    try {
      await ensureOffscreen();
      response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'COLLECT_TARGET', job: {
        url: claim.url, key, lastCount: claim.lastCount, force: claim.force, expectedUid: claim.expectedUid,
        nextPage: claim.nextPage, collectionCount: claim.collectionCount,
        metadata: claim.metadata, monitorState: claim.monitorState,
        generation: claim.generation, attemptAt: claim.lastAttemptAt
      } });
      if (!response?.ok) throw new Error(response?.error || '글을 확인하지 못했습니다.');
    } catch (error) { response = { ok: false, error: error.message }; }
    await serial(async () => {
      const t = await get(tk(key)), config = await settings(), now = Date.now();
      if (!t || t.generation !== claim.generation || t.status !== 'active') return;
      t.inFlightUntil = 0;
      if (now >= t.expiresAt || !config.autoSave) {
        if (now >= t.expiresAt) t.status = 'expired';
        await chrome.storage.local.set({ [tk(key)]: t }); await synchronize(); return;
      }
      t.nextCheckAt = claim.scheduleBase + config.pollSeconds * 1000;
      let notice = false;
      try {
        if (!response.ok) throw new Error(response.error);
        const result = response.result;
        if (!['alive', 'deleted'].includes(result?.state)) throw new Error('댓글 수 응답이 올바르지 않습니다.');
        if (result.state === 'alive' && (!Number.isInteger(result.count) || result.count < 0)) throw new Error('댓글 수 응답이 올바르지 않습니다.');
        if (result.monitorState) t.monitorState = result.monitorState;
        if (result.resetDeletionProbe === true) t.deletionProbeUsed = false;
        if (Array.isArray(result.comments)) {
          const snapshot = sanitizeSnapshot({ ...result.metadata, url: t.url, comments: result.comments }, t.url);
          if (t.expectedUid && snapshot.authorUid !== t.expectedUid) throw new Error('글 작성자가 일치하지 않습니다.');
          await chrome.storage.local.set({ [pk(key)]: mergePost(await get(pk(key)), snapshot) });
        }
        if (result?.state === 'deleted') {
          t.status = 'deleted'; t.deletedAt = now; t.lastError = ''; notice = true;
          if (!await get(pk(key))) await chrome.storage.local.set({ [pk(key)]: mergePost(null, {
            ...parsePostUrl(t.url), title: t.title, author: '', authorUid: t.expectedUid, gallery: t.galleryId, comments: []
          }) });
        } else {
          if (result.count !== t.lastCount) { t.lastActivityAt = now; t.expiresAt = now + config.idleMinutes * 60000; }
          t.lastCount = result.count; t.title = result.metadata?.title || t.title; t.lastError = String(result.monitoringError || '').slice(0, 300); t.failures = 0;
          t.needsCollection = result.complete === false; t.nextPage = result.nextPage || 1; t.collectionCount = result.collectionCount ?? result.count;
        }
      } catch (error) {
        t.status = 'active'; notice = false; t.lastError = String(error.message).slice(0, 300);
        t.failures = (t.failures || 0) + 1;
        t.nextCheckAt = now + Math.min(config.pollSeconds * 1000 * 2 ** Math.min(t.failures - 1, 3), 300000);
      }
      await chrome.storage.local.set({ [tk(key)]: t, notificationStatus: {
        state: t.lastError ? 'error' : notice ? 'saved' : 'idle', message: t.lastError || (notice ? '삭제된 글의 댓글이 보관되어 있습니다.' : '백업 대상 확인 완료'), at: new Date(now).toISOString()
      } });
      await synchronize(); if (notice) void broadcast('DELETE_NOTICE_AVAILABLE').catch(() => {});
    });
  } finally { collecting = false; }
}
async function tick(scheduledAt = Date.now()) {
  if (ticking) return; ticking = true;
  try {
    await serial(synchronize);
    const due = await serial(async () => (await targets()).filter(t => t.status === 'active' && t.nextCheckAt <= Date.now()).map(t => t.key));
    for (const key of due) await runTarget(key, false, scheduledAt);
  } finally { ticking = false; }
}
function requestCheck(key, force) { void runTarget(key, force).catch(error => console.warn('디시 댓글 보관함:', error.message)); }
function identityMetadata(t) {
  return { ...parsePostUrl(t.url), title: t.title, gallery: t.gallery || t.galleryId };
}
async function handle(m, sender) {
  if (!m || typeof m.type !== 'string') throw new Error('올바르지 않은 요청입니다.');
  if (m.type === 'RESERVE_DELETION_PROBE') {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('offscreen.html') || !validKey(m.key)) {
      throw new Error('허용되지 않은 삭제 확인 요청입니다.');
    }
    const t = await get(tk(m.key)), config = await settings(), now = Date.now();
    if (!config.autoSave || !collecting || !t || t.status !== 'active' || now >= t.expiresAt ||
        t.inFlightUntil <= now || t.generation !== m.generation || t.lastAttemptAt !== m.attemptAt || t.deletionProbeUsed) {
      return { ok: true, reserved: false };
    }
    // Persist before authorizing the request: a failed fetch or worker restart must not repeat it.
    t.deletionProbeUsed = true;
    await chrome.storage.local.set({ [tk(t.key)]: t });
    return { ok: true, reserved: true };
  }
  const site = siteSender(sender), ui = uiSender(sender);
  if (!site && !ui) throw new Error('허용되지 않은 요청입니다.');
  const config = await settings();
  if (m.type === 'GET_SETTINGS') return { ok: true, settings: config };
  if (m.type === 'GET_STATE') {
    if (!ui) throw new Error('보관함에서만 사용할 수 있습니다.');
    await synchronize(); const all = await chrome.storage.local.get(null);
    return { ok: true, settings: config, posts: Object.entries(all).filter(([k]) => k.startsWith('post:')).map(([, p]) => p)
      .sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt)), targets: Object.entries(all).filter(([k]) => k.startsWith('target:')).map(([, t]) => t),
      notificationStatus: all.notificationStatus, bytes: await chrome.storage.local.getBytesInUse(null) };
  }
  if (m.type === 'SAVE_SETTINGS') {
    if (!ui) throw new Error('설정 화면에서만 사용할 수 있습니다.');
    const updated = normalizeSettings({ ...config, ...m.settings });
    await synchronize();
    await chrome.storage.local.set({ settings: updated });
    for (const t of await targets()) if (t.status === 'active') {
      t.expiresAt = t.lastActivityAt + updated.idleMinutes * 60000;
      t.nextCheckAt = Math.min(t.nextCheckAt, Date.now() + updated.pollSeconds * 1000);
      await chrome.storage.local.set({ [tk(t.key)]: t });
    }
    await synchronize(); void broadcast('CONFIG_CHANGED').catch(() => {}); return { ok: true };
  }
  if (['STOP_TARGET', 'DELETE_POST'].includes(m.type)) {
    if (!ui || !validKey(m.key)) throw new Error('보관함에서 올바른 글을 선택해 주세요.');
    const t = await get(tk(m.key));
    if (t) { t.status = 'stopped'; t.inFlightUntil = 0; await chrome.storage.local.set({ [tk(t.key)]: t }); }
    if (m.type === 'DELETE_POST') { await chrome.storage.local.set({ [`excluded:${m.key}`]: true }); await chrome.storage.local.remove(pk(m.key)); }
    await synchronize(); void broadcast('CONFIG_CHANGED').catch(() => {}); return { ok: true };
  }
  if (['GET_DELETION_NOTICES', 'ACK_DELETION', 'OPEN_ARCHIVE'].includes(m.type)) {
    if (m.type === 'GET_DELETION_NOTICES') {
      if (!site) throw new Error('디시 페이지에서만 알림을 표시합니다.');
      const notices = [];
      for (const t of await targets()) if (t.status === 'deleted' && !t.noticeDelivered && !t.noticeAck) {
        t.noticeDelivered = true; await chrome.storage.local.set({ [tk(t.key)]: t });
        notices.push({ key: t.key, title: t.title, count: (await get(pk(t.key)))?.comments.length || 0 });
      }
      return { ok: true, notices };
    }
    if (!validKey(m.key)) throw new Error('글 번호가 올바르지 않습니다.');
    if (m.type === 'OPEN_ARCHIVE') await chrome.tabs.create({ url: chrome.runtime.getURL('archive.html') + '#' + encodeURIComponent(m.key) });
    else { const t = await get(tk(m.key)); if (t) { t.noticeAck = true; await chrome.storage.local.set({ [tk(t.key)]: t }); await synchronize(); } }
    return { ok: true };
  }
  if (!site) throw new Error('디시 페이지에서만 사용할 수 있습니다.');
  if (m.type === 'WRITE_ARM' || m.type === 'WRITE_SUCCESS') {
    const write = parseWriteUrl(sender.url);
    if (!write) throw new Error('새 글 작성 화면이 아닙니다.');
    const armKey = `write:${sender.tab.id}`;
    if (m.type === 'WRITE_ARM') {
      await chrome.storage.local.set({ [armKey]: { url: sender.url, documentId: sender.documentId || '', enabled: m.enabled === true, at: Date.now() } }); return { ok: true };
    }
    const arm = await get(armKey), post = parsePostUrl(m.url);
    if (!config.autoSave || !arm?.enabled || arm.url !== sender.url || arm.documentId !== (sender.documentId || '') ||
      Date.now() - arm.at > 24 * 3600000 || !post || post.galleryId !== write.galleryId || post.key.split(':')[0] !== write.key.split(':')[0]) throw new Error('백업을 선택한 작성 화면과 일치하지 않습니다.');
    const target = await register({ ...post, title: m.title }, config, { newlyWritten: true });
    await chrome.storage.local.remove(armKey); return { ok: true, target };
  }
  const source = parsePostUrl(sender.url);
  if (m.type === 'GET_CONFIG') {
    if (!source) throw new Error('글 화면이 아닙니다.');
    const target = await get(tk(source.key)), post = await get(pk(source.key));
    return { ok: true, settings: config, target, tracked: target?.status === 'active', count: post?.comments.length || 0 };
  }
  if (m.type === 'REGISTER_TARGET' || m.type === 'POST_SEEN') {
    const identity = parsePostUrl(m.post?.url);
    if (!source || !identity || identity.key !== source.key) throw new Error('현재 글의 주소와 일치하지 않습니다.');
    const manual = m.type === 'REGISTER_TARGET' && m.reason === 'manual';
    let target = await get(tk(identity.key));
    if (config.autoSave && (manual || (config.allOwnPosts && isOwnPost(m.post, config)))) target = await register(m.post, config, { manual });
    if (target?.status === 'active' && Number.isInteger(m.count) && target.lastCount !== null && m.count !== target.lastCount) requestCheck(target.key, true);
    return { ok: true, target, count: 0 };
  }
  if (m.type === 'NOTICE_SIGNAL' || m.type === 'COUNT_CHANGED') {
    const notice = m.type === 'NOTICE_SIGNAL' ? DCNotifications.parseNotice(m.notice) : null;
    const key = notice?.key || m.key;
    if (!validKey(key)) return { ok: true, skipped: true };
    const target = await get(tk(key));
    if (config.autoSave && target?.status === 'active' && Date.now() < target.expiresAt &&
      (notice || (Number.isInteger(m.count) && m.count !== target.lastCount))) requestCheck(key, true);
    return { ok: true };
  }
  throw new Error('지원하지 않는 요청입니다.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === 'offscreen') return false;
  serial(() => handle(message, sender)).then(respond, error => respond({ ok: false, error: /quota/i.test(error.message) ? '저장 공간이 부족합니다. 백업을 내보낸 뒤 불필요한 보관 글을 삭제해 주세요.' : error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void tick(alarm.scheduledTime).catch(error => console.warn(error.message)); });
chrome.runtime.onStartup.addListener(() => { void serial(synchronize).catch(console.warn); });
chrome.runtime.onInstalled.addListener(() => { void serial(synchronize).catch(console.warn); });
void serial(synchronize).catch(error => console.warn(error.message));
