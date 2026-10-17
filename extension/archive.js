'use strict';

const byId = (id) => document.getElementById(id);
let state = { posts: [], settings: {} };
let selectedKey = hashKey();
let refreshTimer;
const acknowledged = new Set();

function hashKey() {
  try { return decodeURIComponent((globalThis.location?.hash || '').slice(1)) || null; } catch { return null; }
}

function targetLabel(key) {
  const target = state.targets?.find(item => item.key === key);
  return { active: '확인 중', expired: '확인 종료', stopped: '확인 중지', deleted: '원글 삭제됨' }[target?.status] || '';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function time(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR');
}

function safeUrl(value, original = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (original && url.hostname !== 'dcinside.com' && !url.hostname.endsWith('.dcinside.com')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function link(label, url) {
  const anchor = element('a', '', label);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '요청을 처리하지 못했습니다.');
  return result;
}

function showError(error) {
  byId('feedback').textContent = error.message || String(error);
  byId('feedback').classList.add('error');
}

function matches(post, query) {
  return [post.title, post.gallery, post.author, ...post.comments.flatMap((comment) => [comment.author, comment.text, ...(comment.history || []).map((version) => version.text)])]
    .some((value) => String(value || '').toLocaleLowerCase('ko-KR').includes(query));
}

function render() {
  const query = byId('search').value.trim().toLocaleLowerCase('ko-KR');
  const posts = state.posts.filter((post) => !query || matches(post, query))
    .sort((a, b) => String(b.lastSavedAt).localeCompare(String(a.lastSavedAt)));
  if (!posts.some((post) => post.key === selectedKey)) selectedKey = posts[0]?.key || null;
  const comments = state.posts.reduce((total, post) => total + post.comments.length, 0);
  byId('summary').textContent = `${state.posts.length}개 글 · 댓글 ${comments}개 · ${((state.bytes || 0) / 1024).toFixed(1)} KB`;
  byId('resultsCount').textContent = query ? `검색 결과 ${posts.length}개` : `저장한 글 ${posts.length}개`;
  byId('export').disabled = !state.posts.length;
  const list = byId('postList');
  list.replaceChildren();
  for (const post of posts) {
    const button = element('button', `post-item${post.key === selectedKey ? ' selected' : ''}`);
    button.setAttribute('aria-pressed', String(post.key === selectedKey));
    button.append(element('strong', '', post.title || '제목 없음'));
    button.append(element('span', 'muted', [post.gallery || '갤러리', `댓글 ${post.comments.length}개`, targetLabel(post.key)].filter(Boolean).join(' · ')));
    button.append(element('span', 'muted small', time(post.lastSavedAt)));
    button.addEventListener('click', () => { selectedKey = post.key; history.replaceState(null, '', `#${encodeURIComponent(post.key)}`); render(); });
    list.append(button);
  }
  if (!posts.length) list.append(element('p', 'empty-state', query ? '검색 결과가 없습니다.' : '저장한 글이 없습니다.'));
  renderDetail(posts.find((post) => post.key === selectedKey));
}

function appendMedia(container, media) {
  if (!Array.isArray(media) || !media.length) return;
  const list = element('ul', 'media-links');
  media.forEach((item, index) => {
    const url = safeUrl(item.url);
    const row = element('li');
    row.append(url ? link(`${item.alt || `첨부 ${index + 1}`} · 원본 링크`, url) : element('span', 'muted', item.alt || '첨부 링크 없음'));
    list.append(row);
  });
  container.append(list);
}

function groupedComments(comments) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const children = new Map();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    if (!children.has(comment.parentId)) children.set(comment.parentId, []);
    children.get(comment.parentId).push(comment);
  }
  const ordered = [];
  const seen = new Set();
  function appendThread(root, orphan) {
    const stack = [{ comment: root, orphan }];
    while (stack.length) {
      const item = stack.pop();
      if (seen.has(item.comment.id)) continue;
      seen.add(item.comment.id);
      ordered.push(item);
      const replies = children.get(item.comment.id) || [];
      for (let index = replies.length - 1; index >= 0; index--) {
        stack.push({ comment: replies[index], orphan: false });
      }
    }
  }
  for (const comment of comments) {
    if (!comment.parentId || !byId.has(comment.parentId)) appendThread(comment, Boolean(comment.parentId));
  }
  // Keep all records visible even if an incomplete parent chain forms a cycle.
  for (const comment of comments) if (!seen.has(comment.id)) appendThread(comment, Boolean(comment.parentId));
  return ordered;
}

function renderComment(comment, orphan) {
  const article = element('article', `comment${comment.parentId && !orphan ? ' reply' : ''}`);
  const header = element('div', 'comment-meta');
  header.append(element('strong', '', comment.author || '작성자 없음'));
  if (comment.parentId) header.append(element('span', 'badge', orphan ? `답글 · 원댓글 #${comment.parentId}` : '답글'));
  header.append(element('span', 'muted', comment.date || ''));
  article.append(header, element('p', 'comment-text', comment.text || ''));
  appendMedia(article, comment.media);
  const history = Array.isArray(comment.history) ? comment.history : [];
  if (history.length) {
    const details = element('details', 'comment-history');
    details.append(element('summary', '', `이전 기록 ${history.length}개`));
    for (const version of [...history].reverse()) {
      const item = element('div', 'history-item');
      item.append(element('p', 'muted small', `${time(version.capturedAt)}${version.date ? ` · ${version.date}` : ''}`));
      item.append(element('p', 'comment-text', version.text || ''));
      appendMedia(item, version.media);
      details.append(item);
    }
    article.append(details);
  }
  return article;
}

function renderDetail(post) {
  const detail = byId('postDetail');
  detail.replaceChildren();
  if (!post) {
    detail.append(element('p', 'empty-state', state.posts.length ? '검색 결과가 없습니다.' : '저장한 글이 없습니다.'));
    return;
  }
  const target = state.targets?.find(item => item.key === post.key);
  if (target?.status === 'deleted' && !target.noticeAck && !acknowledged.has(post.key)) {
    acknowledged.add(post.key);
    void request({ type: 'ACK_DELETION', key: post.key }).catch(error => {
      acknowledged.delete(post.key);
      showError(error);
    });
  }
  const header = element('header', 'detail-header');
  header.append(element('p', 'muted small', [post.gallery, post.author].filter(Boolean).join(' · ')), element('h2', '', post.title || '제목 없음'));
  header.append(element('p', 'muted small', `최초 저장 ${time(post.firstSavedAt)} · 마지막 저장 ${time(post.lastSavedAt)}`));
  if (targetLabel(post.key)) header.append(element('p', 'muted small', targetLabel(post.key)));
  const actions = element('div', 'detail-actions');
  const original = safeUrl(post.url, true);
  if (original) actions.append(link('원문 열기', original));
  const remove = element('button', 'danger', '보관 삭제');
  remove.addEventListener('click', async () => {
    if (!confirm(`“${post.title || '제목 없음'}”의 저장한 댓글을 삭제하시겠습니까?`)) return;
    remove.disabled = true;
    try {
      await request({ type: 'DELETE_POST', key: post.key });
      byId('feedback').textContent = '보관 삭제됨';
      byId('feedback').classList.remove('error');
      await refresh();
    } catch (error) {
      showError(error);
      remove.disabled = false;
    }
  });
  actions.append(remove);
  header.append(actions);
  detail.append(header, element('h3', 'comments-heading', `저장한 댓글 ${post.comments.length}개`));
  const list = element('div', 'comments');
  if (!post.comments.length) list.append(element('p', 'empty-state', '저장한 댓글이 없습니다.'));
  for (const { comment, orphan } of groupedComments(post.comments)) list.append(renderComment(comment, orphan));
  detail.append(list);
}

async function refresh() {
  try {
    state = await request({ type: 'GET_STATE' });
    render();
  } catch (error) {
    showError(error);
  }
}

byId('search').addEventListener('input', render);
globalThis.addEventListener?.('hashchange', () => { selectedKey = hashKey(); byId('search').value = ''; render(); });
byId('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), settings: state.settings, posts: state.posts }, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = url;
  anchor.download = `dc-comments-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
});
void refresh();
