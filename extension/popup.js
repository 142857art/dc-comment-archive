'use strict';

const byId = (id) => document.getElementById(id);
let stateLoaded = false;

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '요청을 처리하지 못했습니다.');
  return result;
}

function feedback(text, error = false) {
  byId('feedback').textContent = text;
  byId('feedback').classList.toggle('error', error);
}

async function loadState() {
  try {
    const state = await request({ type: 'GET_STATE' });
    if (!stateLoaded) {
      byId('ownUid').value = state.settings.ownUid || '';
      byId('autoSave').checked = state.settings.autoSave !== false;
      byId('allOwnPosts').checked = state.settings.allOwnPosts === true;
      byId('pollSeconds').value = state.settings.pollSeconds || 3;
      byId('idleMinutes').value = state.settings.idleMinutes || 10;
      stateLoaded = true;
    }
    byId('uidStatus').textContent = !state.settings.autoSave ? '댓글 백업 꺼짐' : state.settings.ownUid ? '내 글 자동 판별 사용 중' : '갤로그 ID 미설정';
    const count = state.posts.reduce((sum, post) => sum + post.comments.length, 0);
    byId('storageSummary').textContent = `${state.posts.length}개 글 · 댓글 ${count}개 · ${(state.bytes / 1024).toFixed(1)} KB`;
    renderTargets(state.targets || []);
  } catch (error) {
    feedback(error.message, true);
  }
}

function renderTargets(targets) {
  const list = byId('targetList');
  list.replaceChildren();
  for (const target of targets.filter(item => item.status === 'active')) {
    const row = document.createElement('div'); row.className = 'target-row';
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = target.title || '제목 없음';
    const status = document.createElement('span'); status.className = 'muted small';
    const expires = new Date(target.expiresAt);
    status.textContent = target.lastError || `댓글 ${target.lastCount || 0}개 · ${Number.isNaN(expires.getTime()) ? '종료 대기' : `${expires.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 종료`}`;
    status.classList.toggle('error', Boolean(target.lastError));
    const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = '중지';
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try { await request({ type: 'STOP_TARGET', key: target.key }); await loadState(); }
      catch (error) { feedback(error.message, true); stop.disabled = false; }
    });
    info.append(title, status); row.append(info, stop); list.append(row);
  }
  if (!list.childNodes.length) { const empty = document.createElement('p'); empty.className = 'muted small'; empty.textContent = '확인 중인 글이 없습니다.'; list.append(empty); }
}

byId('openArchive').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('archive.html') });
});

byId('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter || byId('settingsForm').querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request({ type: 'SAVE_SETTINGS', settings: {
      ownUid: byId('ownUid').value.trim(), autoSave: byId('autoSave').checked,
      allOwnPosts: byId('allOwnPosts').checked,
      pollSeconds: Number(byId('pollSeconds').value), idleMinutes: Number(byId('idleMinutes').value)
    } });
    feedback('설정 저장됨');
    await loadState();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    button.disabled = false;
  }
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void loadState();
});
void loadState();
