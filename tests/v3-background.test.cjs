const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { script } = require('./load-scripts.cjs');

const url = 'https://gall.dcinside.com/mgallery/board/view/?id=example&no=123';
const key = 'mgallery:example:123';
const writer = { id: 'extension-test', url: 'https://gall.dcinside.com/mgallery/board/write/?id=example', tab: { id: 1 }, frameId: 0, documentId: 'write-document-1' };
const page = { ...writer, url };
const ui = { id: 'extension-test', url: 'chrome-extension://extension-test/archive.html' };
const offscreen = { id: 'extension-test', url: 'chrome-extension://extension-test/offscreen.html' };
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function background(initial = {}, collector) {
  const data = structuredClone(initial);
  const alarms = new Map();
  const listeners = {};
  const calls = [];
  const collections = [];
  const notices = [];
  let now = Date.parse('2026-10-16T00:00:00Z');
  let failArchiveWrite = false;
  let failTargetWrite = false;
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const chrome = {
    runtime: { id: 'extension-test', getURL: p => `chrome-extension://extension-test/${p}`,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://extension-test/offscreen.html' }],
      sendMessage: async message => {
        assert.equal(message.target, 'offscreen');
        assert.equal(message.type, 'COLLECT_TARGET');
        collections.push(structuredClone(message.job));
        return collector ? collector(message.job) : { ok: true, result: { state: 'alive', metadata: { url, key, title: '내 글', authorUid: 'owner' }, count: 0, comments: null, complete: true } };
      },
      onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true, closeDocument: async () => {} },
    alarms: { create: async (name, config) => { alarms.set(name, config); }, clear: async name => alarms.delete(name),
      get: async name => alarms.get(name), getAll: async () => [...alarms].map(([name, details]) => ({ name, ...details })), onAlarm: event('alarm') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    tabs: { query: async () => [], sendMessage: async (id, value) => { notices.push({ id, value }); }, create: async () => {} },
    storage: { local: { setAccessLevel: async () => {},
      get: async keys => {
        if (typeof keys === 'string') keys = [keys];
        return structuredClone(keys == null ? data : Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])));
      },
      set: async values => {
        if (failArchiveWrite && Object.keys(values).some(k => k.startsWith('post:'))) { failArchiveWrite = false; throw new Error('QUOTA_BYTES quota exceeded'); }
        if (failTargetWrite && Object.keys(values).some(k => k.startsWith('target:'))) { failTargetWrite = false; throw new Error('target storage failed'); }
        Object.assign(data, structuredClone(values));
      },
      remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
      getBytesInUse: async () => JSON.stringify(data).length }
    }
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ chrome, URL, URLSearchParams, console, Date: Clock, AbortController,
    setTimeout, clearTimeout, fetch: async (...args) => { calls.push(args); throw new Error('Unexpected network request'); } });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(script(file), context, { filename: file }); };
  vm.runInContext(script('background.js'), context, { filename: 'background.js' });
  return { data, calls, collections, notices, alarms, listeners, context,
    failArchiveWrite: () => { failArchiveWrite = true; },
    failTargetWrite: () => { failTargetWrite = true; },
    advance: ms => { now += ms; },
    send: (message, sender = page) => new Promise(resolve => {
      assert.equal(listeners.message(message, sender, value => resolve(structuredClone(value))), true);
    }),
    alarm: async scheduledTime => { listeners.alarm({ name: alarms.keys().next().value, ...(scheduledTime === undefined ? {} : { scheduledTime }) }); await tick(); }
  };
}

const settings = { ownUid: 'owner', autoSave: true, allOwnPosts: false, idleMinutes: 10, pollSeconds: 30 };
const metadata = { url, key, title: '내 글', authorUid: 'owner', author: '작성자', gallery: '예시' };
const comment = id => ({ id: String(id), text: `댓글 ${id}`, media: [] });
const alive = (count, comments = null) => ({ ok: true, result: { state: 'alive', metadata, count, comments, complete: true } });
async function register(app) {
  assert.equal((await app.send({ type: 'WRITE_ARM', enabled: true }, writer)).ok, true);
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url, title: '내 글' }, writer)).ok, true);
  await tick();
  return app.data[`target:${key}`];
}

test('new installations use a three-second alarm and collect at that deadline', async () => {
  const app = background({}, () => alive(1, [comment(1)]));
  const target = await register(app);
  assert.equal((await app.send({ type: 'GET_SETTINGS' }, ui)).settings.pollSeconds, 3);
  assert.equal(app.alarms.get('dc-archive-monitor').periodInMinutes, 0.05);
  assert.equal(target.nextCheckAt - target.createdAt, 3000);
  assert.equal(target.expiresAt - target.createdAt, 600000);
  app.advance(2999); await app.alarm();
  assert.equal(app.collections.length, 0);
  app.advance(1); await app.alarm();
  assert.equal(app.collections.length, 1);
  assert.equal(app.data[`post:${key}`].comments.length, 1);
});

test('one-second setting is accepted and controls the next collection', async () => {
  const app = background({ settings });
  await register(app);
  const saved = await app.send({ type: 'SAVE_SETTINGS', settings: { pollSeconds: 1 } }, ui);
  assert.equal(saved.ok, true);
  assert.equal(app.data.settings.pollSeconds, 1);
  assert.equal(app.alarms.get('dc-archive-monitor').periodInMinutes, 1 / 60);
  app.advance(999); await app.alarm();
  assert.equal(app.collections.length, 0);
  app.advance(1); await app.alarm();
  assert.equal(app.collections.length, 1);
});

test('write success registers baseline zero without initial network; alarm collects without DC tabs', async () => {
  const app = background({ settings }, () => alive(1, [comment(1)]));
  const target = await register(app);
  assert.equal(target.status, 'active');
  assert.equal(target.lastCount, 0);
  assert.equal(app.collections.length, 0);
  assert.equal(app.calls.length, 0);
  assert.equal(app.data[`post:${key}`], undefined);
  assert.ok(app.alarms.has('dc-archive-monitor'));
  app.advance(30001);
  await app.alarm();
  assert.equal(app.collections.length, 1);
  assert.equal(app.collections[0].lastCount, 0);
  assert.equal(app.data[`post:${key}`].comments[0].text, '댓글 1');
});

test('only comment count changes reset idle deadline; expiry removes alarm and keeps archive', async () => {
  let result = alive(1, [comment(1)]);
  const app = background({ settings }, () => result);
  await register(app);
  app.advance(30001); await app.alarm();
  const changedDeadline = app.data[`target:${key}`].expiresAt;
  result = alive(1);
  app.advance(30001); await app.alarm();
  assert.equal(app.data[`target:${key}`].expiresAt, changedDeadline);
  assert.equal(app.collections.at(-1).lastCount, 1);
  app.advance(600001); await app.alarm();
  assert.equal(app.data[`target:${key}`].status, 'expired');
  assert.equal(app.collections.length, 2, 'expired targets must stop before a final network request');
  assert.equal(app.alarms.size, 0);
  assert.equal(app.data[`post:${key}`].comments.length, 1);
});

test('expired targets cannot be revived by a late notice or own-post rediscovery', async () => {
  const app = background({ settings: { ...settings, allOwnPosts: true } });
  await register(app);
  app.advance(600001); await app.alarm();
  await app.send({ type: 'NOTICE_SIGNAL', notice: { url: `${url}&fcno=77`, text: '내 글에 댓글이 등록되었습니다.' } });
  await app.send({ type: 'POST_SEEN', post: metadata, count: 2 });
  await app.send({ type: 'REGISTER_TARGET', post: metadata, reason: 'auto' });
  await tick();
  assert.equal(app.data[`target:${key}`].status, 'expired');
  assert.equal(app.collections.length, 0);
  assert.equal(app.alarms.size, 0);
});

test('post rediscovery after deadline before alarm cannot extend target or trigger collection', async () => {
  const app = background({ settings: { ...settings, allOwnPosts: true } });
  await register(app);
  const deadline = app.data[`target:${key}`].expiresAt;
  app.advance(600001);
  await app.send({ type: 'POST_SEEN', post: metadata, count: 1 });
  await tick();
  assert.equal(app.collections.length, 0);
  assert.equal(app.data[`target:${key}`].expiresAt, deadline);
  assert.equal(app.data[`target:${key}`].status, 'expired');
});

test('nonzero collection duration does not skip the next thirty-second alarm', async () => {
  let app;
  app = background({ settings }, () => { app.advance(100); return alive(0); });
  await register(app);
  app.advance(30000); await app.alarm();
  assert.equal(app.collections.length, 1);
  app.advance(29900); await app.alarm();
  assert.equal(app.collections.length, 2);
});

test('native alarm delivery jitter does not turn a three-second interval into six seconds', async () => {
  const app = background({ settings: { ...settings, pollSeconds: 3 } }, () => alive(0));
  const target = await register(app);
  app.advance(3010);
  await app.alarm(target.createdAt + 3000);
  assert.equal(app.collections.length, 1);
  app.advance(2995);
  await app.alarm(target.createdAt + 6000);
  assert.equal(app.collections.length, 2, 'the next scheduled check remains due when its dispatch is five milliseconds earlier than the prior dispatch');
});

test('sequential targets share the alarm schedule despite time spent collecting earlier targets', async () => {
  const secondUrl = url.replace('no=123', 'no=124');
  const secondKey = key.replace(':123', ':124');
  let app;
  app = background({ settings: { ...settings, pollSeconds: 3 } }, job => {
    app.advance(100);
    return { ok: true, result: { state: 'alive', metadata: { ...metadata, url: job.url, key: job.key }, count: 0, comments: null, complete: true } };
  });
  const target = await register(app);
  await app.send({ type: 'WRITE_ARM', enabled: true }, writer);
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url: secondUrl, title: '두 번째 글' }, writer)).ok, true);
  app.advance(3010);
  await app.alarm(target.createdAt + 3000);
  assert.deepEqual(app.collections.map(job => job.key), [key, secondKey]);
  app.advance(2795);
  await app.alarm(target.createdAt + 6000);
  assert.deepEqual(app.collections.map(job => job.key), [key, secondKey, key, secondKey]);
});

test('a website notice cannot enroll an unselected post when backing up all own posts is off', async () => {
  const app = background({ settings });
  const result = await app.send({ type: 'NOTICE_SIGNAL', notice: { url: `${url}&fcno=77`, text: '내 글에 댓글이 등록되었습니다.' } });
  assert.equal(result.ok, true);
  await tick();
  assert.equal(app.data[`target:${key}`], undefined);
  assert.equal(app.collections.length, 0);
});

test('worker restart preserves target deadline and polls via persisted target', async () => {
  const first = background({ settings });
  await register(first);
  const before = structuredClone(first.data[`target:${key}`]);
  const restarted = background(first.data, () => alive(0));
  await tick();
  restarted.advance(30001); await restarted.alarm();
  assert.equal(restarted.collections.length, 1);
  assert.equal(restarted.data[`target:${key}`].expiresAt, before.expiresAt);
  assert.equal(restarted.data[`target:${key}`].createdAt, before.createdAt);
});

test('network failure never means deletion and preserves saved comments', async () => {
  let fail = false;
  const app = background({ settings }, () => fail ? { ok: false, error: 'HTTP 503' } : alive(1, [comment(1)]));
  await register(app);
  app.advance(30001); await app.alarm();
  fail = true;
  app.advance(30001); await app.alarm();
  assert.equal(app.data[`target:${key}`].status, 'active');
  assert.match(app.data[`target:${key}`].lastError, /503/);
  assert.equal(app.data[`post:${key}`].comments.length, 1);
  assert.equal((await app.send({ type: 'GET_DELETION_NOTICES' })).notices?.length || 0, 0);
});

test('quota failure keeps prior archive and a later collection can recover', async () => {
  let result = alive(1, [comment(1)]);
  const app = background({ settings }, () => result);
  await register(app);
  app.advance(30001); await app.alarm();
  const before = structuredClone(app.data[`post:${key}`]);
  result = alive(2, [comment(2)]); app.failArchiveWrite();
  app.advance(30001); await app.alarm();
  assert.deepEqual(app.data[`post:${key}`], before);
  assert.match(app.data[`target:${key}`].lastError, /quota/i);
  app.advance(30001); await app.alarm();
  assert.deepEqual(app.data[`post:${key}`].comments.map(c => c.id), ['1', '2']);
});

test('confirmed deletion keeps archive and reserves its notification to one visible tab', async () => {
  let deleted = false;
  const app = background({ settings }, () => deleted ? { ok: true, result: { state: 'deleted' } } : alive(1, [comment(1)]));
  await register(app);
  app.advance(30001); await app.alarm();
  deleted = true;
  app.advance(30001); await app.alarm();
  assert.equal(app.data[`target:${key}`].status, 'deleted');
  assert.equal(app.data[`post:${key}`].comments.length, 1);
  const first = await app.send({ type: 'GET_DELETION_NOTICES' });
  const duplicate = await app.send({ type: 'GET_DELETION_NOTICES' }, { ...page, tab: { id: 2 } });
  assert.equal(first.notices.length, 1);
  assert.equal(duplicate.notices.length, 0);
  assert.equal(app.alarms.size, 0);
});

test('stop and delete while collection is pending prevent late results from reviving target', async () => {
  for (const type of ['STOP_TARGET', 'DELETE_POST']) {
    let release;
    const app = background({ settings }, () => new Promise(resolve => { release = resolve; }));
    await register(app);
    app.advance(30001);
    const running = app.alarm();
    await tick();
    assert.equal(typeof release, 'function');
    const stopped = await app.send({ type, key }, ui);
    assert.equal(stopped.ok, true);
    release(alive(1, [comment(1)]));
    await running; await tick();
    assert.notEqual(app.data[`target:${key}`].status, 'active');
    assert.equal(app.data[`post:${key}`], undefined);
  }
});

test('duplicate alarm delivery does not collect a target twice and late expiry drops the response', async () => {
  let release;
  const app = background({ settings }, () => new Promise(resolve => { release = resolve; }));
  await register(app);
  app.advance(30001);
  const first = app.alarm();
  await tick();
  await app.alarm();
  assert.equal(app.collections.length, 1);
  app.advance(600001);
  release(alive(1, [comment(1)]));
  await first; await tick();
  assert.equal(app.data[`target:${key}`].status, 'expired');
  assert.equal(app.data[`post:${key}`], undefined);
});

test('fast alarms and website notices cannot overlap a slow collection or extend its ten-minute deadline', async () => {
  let release;
  const app = background({ settings: { ...settings, pollSeconds: 1 } }, () => new Promise(resolve => { release = resolve; }));
  const target = await register(app);
  app.advance(1000); await app.alarm();
  assert.equal(typeof release, 'function');
  for (let i = 0; i < 5; i++) {
    app.advance(1000);
    await app.alarm();
    await app.send({ type: 'NOTICE_SIGNAL', notice: { url: `${url}&fcno=77`, text: '내 글에 댓글이 등록되었습니다.' } });
    await tick();
  }
  assert.equal(app.collections.length, 1);
  assert.equal(app.data[`target:${key}`].expiresAt, target.expiresAt);
  app.advance(600000 - 6000);
  await app.alarm();
  release(alive(1, [comment(1)]));
  await tick();
  assert.equal(app.data[`target:${key}`].status, 'expired');
  assert.equal(app.data[`post:${key}`], undefined);
  assert.equal(app.alarms.size, 0);
});

test('simultaneous notices for different targets share one collector request at a time', async () => {
  const secondUrl = url.replace('no=123', 'no=124');
  const secondKey = key.replace(':123', ':124');
  let active = 0, maximumActive = 0;
  const pending = [];
  const app = background({ settings: { ...settings, pollSeconds: 1 } }, job => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    return new Promise(resolve => pending.push(() => {
      active--;
      resolve({ ok: true, result: { state: 'alive', metadata: { ...metadata, url: job.url, key: job.key }, count: 0, comments: null, complete: true } });
    }));
  });
  await register(app);
  await app.send({ type: 'WRITE_ARM', enabled: true }, writer);
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url: secondUrl, title: '두 번째 글' }, writer)).ok, true);
  const notice = postUrl => ({ type: 'NOTICE_SIGNAL', notice: { url: `${postUrl}&fcno=77`, text: '내 글에 댓글이 등록되었습니다.' } });
  await Promise.all([app.send(notice(url)), app.send(notice(secondUrl))]);
  await tick();
  assert.equal(app.collections.length, 1);
  assert.equal(maximumActive, 1);
  app.advance(1000); await app.alarm();
  assert.equal(app.collections.length, 1);
  pending.shift()(); await tick();
  await app.send(notice(secondUrl));
  await tick(); await app.alarm();
  assert.equal(maximumActive, 1);
  assert.ok(app.collections.some(job => job.key === secondKey), 'the second target remains eligible for a later check');
  for (const release of pending.splice(0)) release();
  await tick();
});

test('a fall to zero comments resets deadline while previously captured comments remain', async () => {
  let result = alive(1, [comment(1)]);
  const app = background({ settings }, () => result);
  await register(app);
  app.advance(30001); await app.alarm();
  const before = app.data[`target:${key}`].expiresAt;
  result = alive(0, []);
  app.advance(30001); await app.alarm();
  assert.equal(app.data[`target:${key}`].lastCount, 0);
  assert.ok(app.data[`target:${key}`].expiresAt > before);
  assert.equal(app.data[`post:${key}`].comments.length, 1);
});

test('unarmed, mismatched-gallery and foreign source write successes cannot register a target', async () => {
  const app = background({ settings });
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url }, writer)).ok, false);
  await app.send({ type: 'WRITE_ARM', enabled: true }, writer);
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url: url.replace('id=example', 'id=other') }, writer)).ok, false);
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url }, { ...writer, frameId: 1 })).ok, false);
  assert.equal((await app.send({ type: 'WRITE_SUCCESS', url }, { ...writer, documentId: 'stale-document' })).ok, false);
  assert.equal(app.data[`target:${key}`], undefined);
});

test('settings reject invalid numeric limits and page callers cannot mutate settings or read archive', async () => {
  const app = background({ settings });
  for (const partial of [{ idleMinutes: 0 }, { idleMinutes: 'bad' }, { pollSeconds: 0 }, { pollSeconds: 0.5 }, { idleMinutes: Infinity }]) {
    assert.equal((await app.send({ type: 'SAVE_SETTINGS', settings: { ...settings, ...partial } }, ui)).ok, false);
  }
  assert.equal((await app.send({ type: 'SAVE_SETTINGS', settings })).ok, false);
  assert.equal((await app.send({ type: 'GET_STATE' })).ok, false);
});

test('increasing idle setting cannot revive a target whose deadline passed before settings save', async () => {
  const app = background({ settings });
  await register(app);
  app.advance(600001);
  const changed = await app.send({ type: 'SAVE_SETTINGS', settings: { ...settings, idleMinutes: 30 } }, ui);
  assert.equal(changed.ok, true);
  assert.equal(app.data[`target:${key}`].status, 'expired');
  assert.equal(app.alarms.size, 0);
  await app.alarm();
  assert.equal(app.collections.length, 0);
});

const probeRequest = job => ({ type: 'RESERVE_DELETION_PROBE', key: job.key, generation: job.generation, attemptAt: job.attemptAt });

test('collection jobs retain post metadata and identify their current claim', async () => {
  const app = background({ settings: { ...settings, allOwnPosts: true } }, () => alive(0));
  await app.send({ type: 'POST_SEEN', post: metadata, count: 0 });
  const target = app.data[`target:${key}`];
  app.advance(30001); await app.alarm();
  const job = app.collections[0];
  assert.equal(job.metadata.title, metadata.title);
  assert.equal(job.metadata.authorUid, metadata.authorUid);
  assert.equal(job.metadata.author, metadata.author);
  assert.equal(job.metadata.gallery, metadata.gallery);
  assert.equal(job.generation, target.generation);
  assert.equal(job.attemptAt, app.data[`target:${key}`].lastAttemptAt);
});

test('only the current offscreen claim can durably reserve one deletion probe', async () => {
  let release;
  const app = background({ settings }, () => new Promise(resolve => { release = resolve; }));
  await register(app);
  app.advance(30001); await app.alarm();
  const job = app.collections[0], request = probeRequest(job);
  for (const sender of [page, ui, { ...offscreen, tab: { id: 1 } }, { ...offscreen, id: 'another-extension' }, { ...offscreen, url: `${offscreen.url}?spoof=1` }]) {
    assert.notEqual((await app.send(request, sender)).reserved, true);
  }
  for (const stale of [{ generation: 'previous-generation' }, { attemptAt: job.attemptAt - 1 }, { key: key.replace(':123', ':124') }]) {
    assert.notEqual((await app.send({ ...request, ...stale }, offscreen)).reserved, true);
  }
  const reserved = await app.send(request, offscreen);
  assert.equal(reserved.ok, true);
  assert.equal(reserved.reserved, true);
  assert.equal(app.data[`target:${key}`].deletionProbeUsed, true, 'the persisted latch must exist before permission is returned');
  assert.equal((await app.send(request, offscreen)).reserved, false);
  release({ ok: false, error: 'HTTP 503 after reserving probe' }); await tick();
  assert.equal(app.data[`target:${key}`].deletionProbeUsed, true);
  assert.notEqual((await app.send(request, offscreen)).reserved, true, 'a completed collection no longer owns a running claim');
});

test('a failed collector and worker restart cannot spend the same deletion probe twice', async () => {
  let release;
  const first = background({ settings }, () => new Promise(resolve => { release = resolve; }));
  const target = await register(first);
  first.advance(30001); await first.alarm();
  assert.equal((await first.send(probeRequest(first.collections[0]), offscreen)).reserved, true);
  release({ ok: false, error: 'connection closed' }); await tick();
  assert.equal(first.data[`target:${key}`].expiresAt, target.expiresAt);
  let restartedRelease;
  const restarted = background(first.data, () => new Promise(resolve => { restartedRelease = resolve; }));
  await tick();
  restarted.advance(60002); await restarted.alarm();
  assert.equal(restarted.collections.length, 1);
  assert.equal((await restarted.send(probeRequest(restarted.collections[0]), offscreen)).reserved, false);
  assert.equal(restarted.data[`target:${key}`].expiresAt, target.expiresAt);
  restartedRelease(alive(0)); await tick();
});

test('failed reservation persistence grants no probe and concurrent retries grant only one', async () => {
  let release;
  const app = background({ settings }, () => new Promise(resolve => { release = resolve; }));
  await register(app);
  app.advance(30001); await app.alarm();
  const request = probeRequest(app.collections[0]);
  app.failTargetWrite();
  const failure = await app.send(request, offscreen);
  assert.equal(failure.ok, false);
  assert.notEqual(failure.reserved, true);
  assert.notEqual(app.data[`target:${key}`].deletionProbeUsed, true);
  const retries = await Promise.all([app.send(request, offscreen), app.send(request, offscreen)]);
  assert.deepEqual(retries.map(response => response.reserved), [true, false]);
  assert.equal(app.data[`target:${key}`].deletionProbeUsed, true);
  release(alive(0)); await tick();
});

test('stopped and expired targets cannot reserve a deletion confirmation request', async () => {
  for (const invalidation of ['stopped', 'expired', 'lease-expired']) {
    let release;
    const app = background({ settings }, () => new Promise(resolve => { release = resolve; }));
    await register(app);
    app.advance(30001); await app.alarm();
    const request = probeRequest(app.collections[0]);
    if (invalidation === 'stopped') await app.send({ type: 'STOP_TARGET', key }, ui);
    else app.advance(invalidation === 'expired' ? 600001 : 120001);
    assert.notEqual((await app.send(request, offscreen)).reserved, true, invalidation);
    assert.notEqual(app.data[`target:${key}`].deletionProbeUsed, true);
    release(alive(0)); await tick();
  }
});

test('fresh list presence resets the probe latch and monitoring state survives without extending idle time', async () => {
  let release;
  const app = background({ settings }, () => new Promise(resolve => { release = resolve; }));
  const target = await register(app);
  app.advance(30001); await app.alarm();
  assert.equal((await app.send(probeRequest(app.collections[0]), offscreen)).reserved, true);
  const monitorState = { listPage: 2, missing: 0, nextListCheckAt: target.createdAt + 90000 };
  release({ ...alive(0), result: { ...alive(0).result, resetDeletionProbe: true, monitorState } }); await tick();
  assert.equal(app.data[`target:${key}`].deletionProbeUsed, false);
  assert.deepEqual(app.data[`target:${key}`].monitorState, monitorState);
  assert.equal(app.data[`target:${key}`].expiresAt, target.expiresAt);
  app.advance(30001); await app.alarm();
  assert.deepEqual(app.collections[1].monitorState, monitorState);
  assert.equal((await app.send(probeRequest(app.collections[1]), offscreen)).reserved, true);
  release(alive(0)); await tick();
  assert.equal(app.data[`target:${key}`].expiresAt, target.expiresAt);
});

test('comments collected immediately before confirmed deletion are archived before its notification', async () => {
  let result = alive(1, [comment(1)]);
  const app = background({ settings }, () => result);
  await register(app);
  app.advance(30001); await app.alarm();
  result = { ok: true, result: { state: 'deleted', metadata, count: 2, comments: [comment(2)], complete: true } };
  app.advance(30001); await app.alarm();
  assert.equal(app.data[`target:${key}`].status, 'deleted');
  assert.deepEqual(app.data[`post:${key}`].comments.map(c => c.id), ['1', '2']);
  const notice = await app.send({ type: 'GET_DELETION_NOTICES' });
  assert.equal(notice.notices[0].count, 2);
});

test('listing monitoring errors preserve the three-second comment schedule and idle deadline', async () => {
  const app = background({}, () => ({ ok: true, result: { ...alive(0).result, monitoringError: '목록 확인 실패' } }));
  const target = await register(app);
  app.advance(3000); await app.alarm();
  assert.equal(app.data[`target:${key}`].lastError, '목록 확인 실패');
  assert.equal(app.data[`target:${key}`].nextCheckAt, target.createdAt + 6000);
  assert.equal(app.data[`target:${key}`].expiresAt, target.expiresAt);
  app.advance(3000); await app.alarm();
  assert.equal(app.collections.length, 2);
});
