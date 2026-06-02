// === Theme (dark / light) ===
function initTheme() {
  const saved = localStorage.getItem('openclaw-theme');
  if (saved === 'light') applyTheme('light');
  else applyTheme('dark');
}

function applyTheme(mode) {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle-btn');
  const hljsDark = document.getElementById('hljs-dark');
  const hljsLight = document.getElementById('hljs-light');
  if (mode === 'light') {
    root.classList.add('light');
    if (btn) btn.textContent = '🌙';
    if (hljsDark) hljsDark.disabled = true;
    if (hljsLight) hljsLight.disabled = false;
    localStorage.setItem('openclaw-theme', 'light');
  } else {
    root.classList.remove('light');
    if (btn) btn.textContent = '☀️';
    if (hljsDark) hljsDark.disabled = false;
    if (hljsLight) hljsLight.disabled = true;
    localStorage.setItem('openclaw-theme', 'dark');
  }
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  applyTheme(isLight ? 'dark' : 'light');
}

// === Ding sound (Web Audio API) ===
function playDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => ctx.close();
  } catch (e) { /* audio not available */ }
}

// === Completion toast ===
function showCompletionToast(text) {
  let toast = document.getElementById('completion-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'completion-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text || '✓ Done';
  toast.className = 'completion-toast show';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// === Thinking messages ===
const THINKING_MSGS = [
  'Working on it…',
  'Pulling things together…',
  'Crunching that…',
  'On it…',
  'Thinking it through…',
  'Reading context…',
  'Almost there…',
  'Running the numbers…',
  'Checking sources…',
  'Putting it together…',
];
let thinkingMsgInterval = null;
let thinkingMsgIdx = 0;

function startThinkingCycle() {
  thinkingMsgIdx = Math.floor(Math.random() * THINKING_MSGS.length);
  thinkingMsgInterval = setInterval(() => {
    thinkingMsgIdx = (thinkingMsgIdx + 1) % THINKING_MSGS.length;
    document.querySelectorAll('.thinking-label').forEach(d => d.textContent = THINKING_MSGS[thinkingMsgIdx]);
  }, 2500);
}

function stopThinkingCycle() {
  if (thinkingMsgInterval) { clearInterval(thinkingMsgInterval); thinkingMsgInterval = null; }
}

// === State ===
let state = {
  authenticated: false,
  currentChat: null,
  currentTab: 'chats',
  currentView: 'chat',       // 'chat' | 'project'
  currentProject: null,
  chats: [],
  projects: [],
  // Multi-chat background polling: { [chatId]: { aiMsgId, interval } }
  pendingPolls: {},
  pendingFiles: [],
  messageQueue: {}, // keyed by chatId: { [chatId]: [] }
  artifacts: [],
  currentArtifactIdx: 0,
  mediaRecorder: null,
  recording: false,
  audioChunks: [],
  collapsedProjects: {},
};

// === Init ===
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  // Load instance name for tab title and sidebar logo
  try {
    const cfg = await api('/api/app-config');
    const name = cfg.instanceName || 'My Agent';
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = name;
    const sidebarName = document.getElementById('sidebar-instance-name');
    if (sidebarName) sidebarName.textContent = name;
    const loginName = document.getElementById('login-instance-name');
    if (loginName) loginName.textContent = name;
  } catch (e) { /* keep defaults */ }
  const res = await api('/api/me');
  if (res.authenticated) {
    state.authenticated = true;
    showApp();
  } else {
    document.getElementById('login-screen').style.display = 'flex';
  }
  setupDragDrop();
  setupMarked();
  setupPaste();
});

function setupMarked() {
  if (typeof marked !== 'undefined') {
    // Custom renderer: links open in new tab
    const renderer = new marked.Renderer();
    renderer.link = (href, title, text) => {
      const titleAttr = title ? ` title="${title}"` : '';
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    };
    marked.setOptions({
      renderer,
      highlight: (code, lang) => {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true,
    });
  }
}

// === Auth ===
async function doLogin() {
  const pw = document.getElementById('login-pw').value;
  const err = document.getElementById('login-error');
  try {
    const res = await api('/api/login', 'POST', { password: pw });
    if (res.ok) {
      err.style.display = 'none';
      document.getElementById('login-screen').style.display = 'none';
      state.authenticated = true;
      showApp();
    }
  } catch(e) {
    err.textContent = 'Wrong password';
    err.style.display = 'block';
  }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') {
    doLogin();
  }
});

async function showApp() {
  document.getElementById('app').style.display = 'flex';
  await loadSidebar();
  // Request browser notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  // Route to deep-linked chat/project from URL
  routeFromURL();
}

// === URL Routing ===
function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

function chatURL(chat) {
  if (chat.project_id) {
    const proj = state.projects.find(p => p.id === chat.project_id);
    const slug = proj ? slugify(proj.name) : 'project';
    return `/p/${slug}-${chat.project_id}/chat/${chat.id}`;
  }
  return `/chat/${chat.id}`;
}

function projectURL(proj) {
  return `/p/${slugify(proj.name)}-${proj.id}`;
}

function pushChatURL(chat) {
  const url = chatURL(chat);
  if (location.pathname !== url) history.pushState({ chatId: chat.id }, '', url);
}

function pushProjectURL(proj) {
  const url = projectURL(proj);
  if (location.pathname !== url) history.pushState({ projectId: proj.id }, '', url);
}

function routeFromURL() {
  const path = location.pathname;
  // /chat/:chatId
  const chatMatch = path.match(/^\/chat\/([\w-]+)$/);
  if (chatMatch) { openChat(chatMatch[1]); return; }
  // /p/:slug-:projectId/chat/:chatId
  const projChatMatch = path.match(/^\/p\/[^/]+-([\w-]+)\/chat\/([\w-]+)$/);
  if (projChatMatch) { openChat(projChatMatch[2]); return; }
  // /p/:slug-:projectId
  const projMatch = path.match(/^\/p\/[^/]+-([\w-]+)$/);
  if (projMatch) { openProject(projMatch[1]); return; }
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  if (!state.authenticated) return;
  if (e.state?.chatId) { openChat(e.state.chatId); return; }
  if (e.state?.projectId) { openProject(e.state.projectId); return; }
  routeFromURL();
});

// === Sidebar ===
async function loadSidebar() {
  const [chats, projects] = await Promise.all([
    api('/api/chats'),
    api('/api/projects'),
  ]);
  state.chats = chats;
  state.projects = projects;
  renderSidebar();
}

function renderSidebar() {
  const el = document.getElementById('sidebar-content');
  if (state.currentTab === 'chats') renderChats(el);
  else renderProjects(el);
}

function renderChats(el, filter = '') {
  let html = '';
  const projectMap = {};
  state.projects.forEach(p => projectMap[p.id] = p);

  // Flat list sorted by updated_at DESC
  let chats = [...state.chats];
  chats.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  if (filter) {
    const q = filter.toLowerCase();
    chats = chats.filter(c => {
      const proj = c.project_id ? projectMap[c.project_id] : null;
      return c.title.toLowerCase().includes(q) || (proj && proj.name.toLowerCase().includes(q));
    });
  }

  chats.forEach(c => {
    const proj = c.project_id ? projectMap[c.project_id] : null;
    html += chatItemHTML(c, proj);
  });

  if (!html) html = `<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">No chats yet</div>`;
  el.innerHTML = html;
}

// Track which background chats have new unread replies
const unreadReplies = new Set();

function markChatReplied(chatId) {
  unreadReplies.add(chatId);
  // Update just this item in the sidebar without full re-render
  const el = document.querySelector(`.chat-item[data-id="${chatId}"]`);
  if (el && !el.querySelector('.new-reply-badge')) {
    const badge = document.createElement('span');
    badge.className = 'new-reply-badge';
    badge.textContent = 'new';
    el.querySelector('.chat-item-title')?.after(badge);
  }
}

function chatItemHTML(c, proj) {
  const active = state.currentChat?.id === c.id ? 'active' : '';
  const hasUnread = unreadReplies.has(c.id) && state.currentChat?.id !== c.id;
  let titleHTML;
  if (proj) {
    titleHTML = `<span class="chat-item-title"><span class="chat-item-project-name" onclick="event.stopPropagation();openProject('${proj.id}')">${esc(proj.name)}</span><span class="chat-item-sep"> / </span>${esc(c.title)}</span>`;
  } else {
    titleHTML = `<span class="chat-item-title">${esc(c.title)}</span>`;
  }
  const badge = hasUnread ? `<span class="new-reply-badge">new</span>` : '';
  return `<div class="chat-item ${active}" onclick="openChat('${c.id}')" data-id="${c.id}">
    <span style="font-size:14px">💬</span>
    ${titleHTML}
    ${badge}
    <div class="chat-item-actions">
      <button class="action-btn" onclick="event.stopPropagation();moveChatToProject('${c.id}')" title="Move to project">📁</button>
      <button class="action-btn" onclick="event.stopPropagation();renameChat('${c.id}')" title="Rename">✏️</button>
      <button class="action-btn" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Delete">🗑</button>
    </div>
  </div>`;
}

function renderProjects(el) {
  let html = `<button class="new-chat-btn" style="width:100%;margin-bottom:8px" onclick="newProject()">+ New Project</button>`;
  if (!state.projects.length) {
    html += `<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">No projects yet</div>`;
  }
  state.projects.forEach(p => {
    const active = state.currentView === 'project' && state.currentProject?.id === p.id ? 'active' : '';
    const isCollapsed = state.collapsedProjects[p.id];
    const projectChats = state.chats.filter(c => c.project_id === p.id)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    const chevron = isCollapsed ? '▶' : '▼';
    html += `<div class="project-group">
      <div class="project-item ${active}">
        <span class="project-chevron" onclick="event.stopPropagation();toggleProjectCollapse('${p.id}')">${chevron}</span>
        <span style="font-size:14px">📁</span>
        <span class="project-item-name" onclick="openProject('${p.id}')">${esc(p.name)}</span>
        <div class="project-item-actions">
          <button class="action-btn" onclick="event.stopPropagation();editProject('${p.id}')" title="Edit">✏️</button>
          <button class="action-btn" onclick="event.stopPropagation();deleteProject('${p.id}')" title="Delete">🗑</button>
        </div>
      </div>
      ${!isCollapsed ? `<div class="project-chat-indent">${
        projectChats.length
          ? projectChats.map(c => {
              const chatActive = state.currentChat?.id === c.id ? 'active' : '';
              return `<div class="project-child-chat ${chatActive}" onclick="openChat('${c.id}')">
                <span style="font-size:12px;opacity:0.6">💬</span>
                <span class="project-child-chat-title">${esc(c.title)}</span>
              </div>`;
            }).join('')
          : `<div class="project-no-chats">No chats yet</div>`
      }</div>` : ''}
    </div>`;
  });
  el.innerHTML = html;
}

function showTab(tab, btn) {
  state.currentTab = tab;
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderSidebar();
}

// === Search (title + content) ===
let searchDebounceTimer = null;

function filterChats(val) {
  clearTimeout(searchDebounceTimer);
  const el = document.getElementById('sidebar-content');
  if (state.currentTab !== 'chats') return;

  if (!val || val.trim().length < 2) {
    // Hide spinner & reset to normal list
    setSearchSpinner(false);
    renderChats(el, val);
    return;
  }

  // Show spinner immediately
  setSearchSpinner(true);

  searchDebounceTimer = setTimeout(async () => {
    try {
      // Kick off both searches in parallel
      const [contentResults] = await Promise.all([
        api(`/api/chats/search?q=${encodeURIComponent(val)}`),
      ]);
      setSearchSpinner(false);
      renderChatsWithContentSearch(el, val, contentResults);
    } catch (e) {
      setSearchSpinner(false);
      renderChats(el, val); // fallback to title-only on error
    }
  }, 350);
}

function setSearchSpinner(on) {
  let spinner = document.getElementById('search-spinner');
  if (!spinner) {
    spinner = document.createElement('span');
    spinner.id = 'search-spinner';
    spinner.className = 'search-spinner';
    const input = document.getElementById('search-input');
    if (input && input.parentNode) {
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      wrap.style.width = '100%';
      wrap.style.marginTop = '8px';
      input.style.marginTop = '0';
      input.style.width = '100%';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      wrap.appendChild(spinner);
    }
  }
  spinner.style.display = on ? 'block' : 'none';
}

function renderChatsWithContentSearch(el, query, contentResults) {
  const projectMap = {};
  state.projects.forEach(p => projectMap[p.id] = p);
  const q = query.toLowerCase();

  // Title-matching chats (from state)
  const titleMatches = state.chats.filter(c => {
    const proj = c.project_id ? projectMap[c.project_id] : null;
    return c.title.toLowerCase().includes(q) || (proj && proj.name.toLowerCase().includes(q));
  });

  // Content-only matches (not already in title matches)
  const titleMatchIds = new Set(titleMatches.map(c => c.id));
  const contentOnly = contentResults.filter(r => !titleMatchIds.has(r.id));

  let html = '';

  if (titleMatches.length) {
    html += `<div class="search-section-label">Matching chats (${titleMatches.length})</div>`;
    titleMatches.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).forEach(c => {
      const proj = c.project_id ? projectMap[c.project_id] : null;
      html += chatItemHTML(c, proj);
    });
  }

  if (contentOnly.length) {
    html += `<div class="search-section-label" style="margin-top:${titleMatches.length ? 10 : 0}px">In conversation (${contentOnly.length})</div>`;
    contentOnly.forEach(r => {
      const proj = r.project_id ? projectMap[r.project_id] : null;
      html += chatItemWithSnippetHTML(r, proj, query);
    });
  }

  if (!html) html = `<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">No results</div>`;
  el.innerHTML = html;
}

function chatItemWithSnippetHTML(c, proj, query) {
  const active = state.currentChat?.id === c.id ? 'active' : '';
  let titleHTML;
  if (proj) {
    titleHTML = `<span class="chat-item-title"><span class="chat-item-project-name" onclick="event.stopPropagation();openProject('${proj.id}')">${esc(proj.name)}</span><span class="chat-item-sep"> / </span>${esc(c.title)}</span>`;
  } else {
    titleHTML = `<span class="chat-item-title">${esc(c.title)}</span>`;
  }
  const snippet = c.snippet ? highlightSnippet(c.snippet, query) : '';
  return `<div class="chat-item ${active}" onclick="openChat('${c.id}')" data-id="${c.id}">
    <span style="font-size:14px">💬</span>
    <div style="flex:1;min-width:0">
      ${titleHTML}
      ${snippet ? `<div class="search-snippet">${snippet}</div>` : ''}
    </div>
    <div class="chat-item-actions">
      <button class="action-btn" onclick="event.stopPropagation();moveChatToProject('${c.id}')" title="Move to project">📁</button>
      <button class="action-btn" onclick="event.stopPropagation();renameChat('${c.id}')" title="Rename">✏️</button>
      <button class="action-btn" onclick="event.stopPropagation();deleteChat('${c.id}')" title="Delete">🗑</button>
    </div>
  </div>`;
}

function highlightSnippet(text, query) {
  if (!query) return esc(text);
  const escaped = esc(text);
  const q = esc(query);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(re, m => `<mark class="search-highlight">${m}</mark>`);
}

// === Chat operations ===
async function newChat(projectId = null) {
  const chat = await api('/api/chats', 'POST', { project_id: projectId || state.currentProject?.id || null });
  state.chats.unshift(chat);
  // Reload projects so slugify has the latest names
  if (!state.projects.length) state.projects = await api('/api/projects');
  renderSidebar();
  await openChat(chat.id);
}

// Returns header HTML for the chat title — project name is a clickable link
function getChatDisplayTitleHTML(chat) {
  if (!chat) return 'Select or start a chat';
  const title = chat.title || 'Chat';
  if (chat.project_id) {
    const proj = state.projects.find(p => p.id === chat.project_id);
    if (proj) {
      return `<span class="header-project-link" onclick="openProject('${proj.id}')">${esc(proj.name)}</span><span class="header-title-sep"> / </span>${esc(title)}`;
    }
  }
  return esc(title);
}

async function openChat(id) {
  // Don't kill polls — background chats keep running
  // Only stop the thinking cycle for the view; polls continue in the background
  stopThinkingCycle();
  unreadReplies.delete(id); // clear badge when user opens the chat
  // Restart thinking cycle if the newly opened chat has an active poll
  if (hasPendingPoll(id)) startThinkingCycle();
  updateStopBtn(id);
  state.currentView = 'chat';
  state.currentProject = null;
  state.currentChat = state.chats.find(c => c.id === id);
  if (!state.currentChat) {
    const fresh = await api(`/api/chats`);
    state.chats = fresh;
    state.currentChat = state.chats.find(c => c.id === id);
  }
  renderSidebar();
  if (state.currentChat) pushChatURL(state.currentChat);
  document.getElementById('chat-title').innerHTML = getChatDisplayTitleHTML(state.currentChat);
  document.getElementById('header-actions').style.display = 'flex';
  document.getElementById('input-area').style.display = 'block';
  // Bump sort order when user opens a chat
  api(`/api/chats/${state.currentChat.id}/touch`, 'POST').catch(() => {});
  // Update queue display for the newly-selected chat
  renderQueue();
  // Clear messages immediately — prevents stale content flashing before fetch completes
  document.getElementById('messages-area').innerHTML = '';
  await loadMessages();
  // Auto-focus the input so the user can start typing immediately
  const msgInput = document.getElementById('msg-input');
  if (msgInput) msgInput.focus();
}

async function loadMessages() {
  if (!state.currentChat) return;
  const chatId = state.currentChat.id; // capture before async gap
  const messages = await api(`/api/chats/${chatId}/messages`);
  if (state.currentChat?.id !== chatId) return; // stale — chat switched mid-fetch
  renderMessages(messages);
  scrollToBottom();
}

function renderMessages(messages) {
  const area = document.getElementById('messages-area');
  if (!messages.length) {
    area.innerHTML = `<div class="empty-state" id="empty-state"><div class="empty-state-icon">🤖</div><div class="empty-state-text">Start the conversation</div></div>`;
    return;
  }

  state.artifacts = [];
  let html = '';
  messages.forEach(msg => {
    html += renderMessage(msg);
    // Extract artifacts from assistant messages
    if (msg.role === 'assistant' && msg.content !== '...thinking...') {
      extractArtifacts(msg.content);
    }
  });
  area.innerHTML = html;

  // Add copy buttons to code blocks
  area.querySelectorAll('pre code').forEach(block => {
    const pre = block.parentElement;
    const btn = document.createElement('button');
    btn.className = 'copy-code-btn';
    btn.textContent = 'Copy';
    btn.onclick = () => { navigator.clipboard.writeText(block.textContent); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); };
    pre.appendChild(btn);
  });

  // Refresh artifact panel if it's open
  refreshArtifactPanelIfOpen();
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderMessage(msg) {
  const isUser = msg.role === 'user';
  const avatar = isUser ? 'A' : '🤖';
  const thinking = msg.content === '...thinking...';

  let content = '';
  if (thinking) {
    // Show live thinking animation if we are actively polling for this message in any chat
    const chatPoll = Object.values(state.pendingPolls).find(p => p.aiMsgId === msg.id);
    const isActivePoll = !!chatPoll;
    if (isActivePoll) {
      const thinkingText = THINKING_MSGS[thinkingMsgIdx] || 'Working on it…';
      content = `<div class="message-bubble thinking"><span class="spinner"></span> <span class="thinking-label">${thinkingText}</span></div>`;
    } else {
      // Stale thinking message — response was lost (server restart, error, etc.)
      content = `<div class="message-bubble thinking-stale"><span style="opacity:0.5">⚠️</span> <span style="opacity:0.7;font-size:13px">Response was lost. Please try again.</span></div>`;
    }
  } else {
    const rendered = isUser ? esc(msg.content).replace(/\n/g, '<br>') : renderMarkdown(msg.content);
    content = `<div class="message-bubble">${rendered}</div>`;
  }

  // Attachments
  let atts = '';
  const attachments = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : (msg.attachments || []);
  if (attachments.length) {
    const voiceAtt = attachments.find(a => a.isVoice);
    const otherAtts = attachments.filter(a => !a.isVoice);
    if (voiceAtt) {
      const audioUrl = `/api/audio/${encodeURIComponent(voiceAtt.name)}`;
      atts += `<div class="voice-message-player">`;
      atts += `<audio controls preload="none" src="${audioUrl}" style="width:100%;max-width:320px;height:36px"></audio>`;
      atts += `<div class="voice-transcript-label">🎤 Voice message</div>`;
      atts += `</div>`;
    }
    if (otherAtts.length) {
      atts += `<div class="message-attachments">${otherAtts.map(a => `<div class="attachment-chip">📎 ${esc(a.name)}</div>`).join('')}</div>`;
    }
  }

  const ts = formatTimestamp(msg.created_at);
  const tsHTML = ts ? `<div class="message-timestamp">${ts}</div>` : '';

  const actionsHTML = (isUser && !thinking)
    ? `<div class="message-actions">
        <button class="msg-action-btn" onclick="copyMsgContent(this)" data-content="${esc(msg.content)}" title="Copy message">Copy</button>
        <button class="msg-action-btn" onclick="retryMsg(this)" data-content="${esc(msg.content)}" title="Retry this message">↺ Retry</button>
       </div>`
    : '';

  return `<div class="message ${msg.role}" data-id="${msg.id}">
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">${atts}${content}${actionsHTML}${tsHTML}</div>
  </div>`;
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return esc(text).replace(/\n/g, '<br>');
  try { return marked.parse(text); } catch { return esc(text).replace(/\n/g, '<br>'); }
}

function extractArtifacts(content) {
  const codeRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = codeRegex.exec(content)) !== null) {
    state.artifacts.push({ type: 'code', lang: match[1] || 'text', content: match[2].trim() });
  }
}

// After renderMessages, refresh the artifact panel tabs if it's open
function refreshArtifactPanelIfOpen() {
  const panel = document.getElementById('artifact-panel');
  if (!panel.classList.contains('open')) return;
  if (state.artifacts.length) {
    // Keep current idx in range
    if (state.currentArtifactIdx >= state.artifacts.length) state.currentArtifactIdx = state.artifacts.length - 1;
    showArtifact(state.currentArtifactIdx);
  } else {
    document.getElementById('artifact-tabs').innerHTML = '';
    document.getElementById('artifact-body').innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">No artifacts in this chat</div>';
    document.getElementById('artifact-title').textContent = 'Artifacts';
  }
}

// === Send message ===
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && !state.pendingFiles.length) return;
  if (!state.currentChat) return;

  const chatId = state.currentChat.id;

  // If already pending: queue the message
  if (hasPendingPoll(chatId)) {
    if (text.toLowerCase().trim() === 'stop') {
      input.value = ''; autoResize(input);
      await stopGeneration(); return;
    }
    const files = [...state.pendingFiles];
    state.pendingFiles = [];
    document.getElementById('input-attachments').innerHTML = '';
    input.value = ''; autoResize(input);
    if (!state.messageQueue[chatId]) state.messageQueue[chatId] = [];
    state.messageQueue[chatId].push({ id: `q_${Date.now()}`, text, files });
    renderQueue(); return;
  }

  clearPollInterval(chatId);

  const btn = document.getElementById('send-btn');
  btn.disabled = true;
  input.value = ''; autoResize(input);

  const files = [...state.pendingFiles];
  state.pendingFiles = [];
  document.getElementById('input-attachments').innerHTML = '';

  let res;
  if (files.length > 0) {
    const formData = new FormData();
    formData.append('message', text);
    files.forEach(f => formData.append('files', f));
    res = await fetch(`/api/chats/${chatId}/send`, { method: 'POST', body: formData }).then(r => r.json());
  } else {
    res = await api(`/api/chats/${chatId}/send`, 'POST', { message: text });
  }

  btn.disabled = false;
  startLegacyPoll(chatId, res.aiMsgId);
}

// Legacy poll fallback (used for file uploads and SSE errors)
function startLegacyPoll(chatId, aiMsgId) {
  startThinkingCycle();
  const interval = setInterval(async () => {
    if (!state.pendingPolls[chatId]) return;
    let msg;
    try { msg = await api(`/api/messages/${aiMsgId}`); } catch { return; }
    if (msg.content !== '...thinking...' && msg.content !== '') {
      clearPollInterval(chatId);
      playDing();
      stopThinkingCycle();
      const isViewing = state.currentChat?.id === chatId;
      const chatTitle = state.chats.find(c => c.id === chatId)?.title || 'Chat';
      showCompletionToast(isViewing ? '✓ Replied' : `✓ Reply ready in "${chatTitle}"`);
      if (!isViewing && Notification.permission === 'granted') {
        const preview = msg.content.replace(/[#*`_~]/g, '').slice(0, 100);
        const notif = new Notification(`Reply ready in "${chatTitle}"`, {
          body: preview,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>',
          tag: `reply-${chatId}`, requireInteraction: false,
        });
        notif.onclick = () => { window.focus(); notif.close(); openChat(chatId); };
      }
      await new Promise(r => setTimeout(r, 700));
      const fresh = await api('/api/chats');
      state.chats = fresh; renderSidebar();
      if (state.currentChat?.id === chatId) {
        state.currentChat = state.chats.find(c => c.id === chatId) || state.currentChat;
        pushChatURL(state.currentChat);
        document.getElementById('chat-title').innerHTML = getChatDisplayTitleHTML(state.currentChat);
        await loadMessages(); scrollToBottom();
        updateStopBtn(chatId); processNextQueueItem(chatId);
      } else { markChatReplied(chatId); updateStopBtn(chatId); }
    }
  }, 1500);
  state.pendingPolls[chatId] = { aiMsgId, interval };
  updateStopBtn(chatId);
  if (state.currentChat?.id === chatId) { loadMessages().then(scrollToBottom); }
}

// Stop poll for a specific chat (or all chats if no id given)
function clearPollInterval(chatId) {
  if (chatId) {
    const p = state.pendingPolls[chatId];
    if (p) {
      // SSE stream: close EventSource
      if (p.evtSource) { try { p.evtSource.close(); } catch {} }
      if (p.abort) { try { p.abort(); } catch {} }
      // Legacy poll: clear interval
      if (p.interval) clearInterval(p.interval);
      delete state.pendingPolls[chatId];
    }
    if (state.currentChat?.id === chatId) updateStopBtn(chatId);
  } else {
    Object.values(state.pendingPolls).forEach(p => {
      if (p.evtSource) { try { p.evtSource.close(); } catch {} }
      if (p.abort) { try { p.abort(); } catch {} }
      if (p.interval) clearInterval(p.interval);
    });
    state.pendingPolls = {};
    updateStopBtn(null);
  }
}

function hasPendingPoll(chatId) {
  return !!state.pendingPolls[chatId];
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  area.scrollTop = area.scrollHeight;
}

// === File handling ===
function setupDragDrop() {
  const area = document.getElementById('input-area');
  if (!area) return;
  area.addEventListener('dragover', e => { e.preventDefault(); area.style.outline = '2px dashed var(--accent)'; });
  area.addEventListener('dragleave', () => { area.style.outline = ''; });
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.style.outline = '';
    handleFiles(e.dataTransfer.files);
  });
  // Document-level drag-drop: catches drops anywhere on the page
  document.addEventListener('dragover', e => {
    const editActive = !!document.querySelector('.msg-edit-container');
    if (editActive || document.getElementById('input-area').style.display !== 'none') e.preventDefault();
  });
  document.addEventListener('drop', e => {
    const editActive = !!document.querySelector('.msg-edit-container');
    if (document.getElementById('input-area').style.display === 'none' && !editActive) return;
    e.preventDefault();
    area.style.outline = '';
    handleFiles(e.dataTransfer.files);
  });
}

function setupPaste() {
  document.addEventListener('paste', e => {
    const inputAreaHidden = document.getElementById('input-area').style.display === 'none';
    const editActive = !!document.querySelector('.msg-edit-container');
    if (inputAreaHidden && !editActive) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) handleFiles(files);
  });
}

function handleFiles(files) {
  // If edit mode is active, route files there instead
  const editContainer = document.querySelector('.msg-edit-container');
  if (editContainer) {
    const msgId = editContainer.getAttribute('data-msg-id');
    if (msgId) { handleEditFiles(msgId, files); return; }
  }
  Array.from(files).forEach(f => {
    state.pendingFiles.push(f);
    const el = document.getElementById('input-attachments');
    const chip = document.createElement('div');
    chip.className = 'input-attachment';
    chip.dataset.name = f.name;
    chip.innerHTML = `📎 ${esc(f.name)} <button class="input-attachment-remove" onclick="removeFile('${esc(f.name)}',this)">×</button>`;
    el.appendChild(chip);
  });
}

function removeFile(name, btn) {
  state.pendingFiles = state.pendingFiles.filter(f => f.name !== name);
  btn.parentElement.remove();
}

// === Voice recording ===
function resetRecordBtn() {
  const btn = document.getElementById('record-btn');
  const cancelBtn = document.getElementById('cancel-record-btn');
  if (btn) { btn.textContent = '🎤'; btn.title = 'Voice message'; btn.classList.remove('recording'); }
  if (cancelBtn) cancelBtn.style.display = 'none';
  state.recording = false;
  // NOTE: do NOT clear _recordCancelled here — onstop fires async after cancel,
  // so the flag must survive until onstop reads it. It gets cleared at next recording start.
}

function stopRecordStream() {
  if (state._recordStream) {
    state._recordStream.getTracks().forEach(t => t.stop());
    state._recordStream = null;
  }
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
}

function cancelRecord() {
  state._recordCancelled = true;
  stopRecordStream();
  resetRecordBtn();
}

async function toggleRecord() {
  const btn = document.getElementById('record-btn');
  const cancelBtn = document.getElementById('cancel-record-btn');

  // --- Stop recording (send) ---
  if (state.recording) {
    state.recording = false;
    // Kill the stream tracks IMMEDIATELY — mic off right now, before any async work
    if (state._recordStream) {
      state._recordStream.getTracks().forEach(t => t.stop());
      state._recordStream = null;
    }
    // Show transcribing state on the button
    if (btn) { btn.textContent = '⏳'; btn.title = 'Transcribing…'; btn.classList.remove('recording'); }
    if (cancelBtn) cancelBtn.style.display = 'none';
    // Stop recorder — onstop will fire and handle transcription/send
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      state.mediaRecorder.stop();
    }
    return;
  }

  // --- Start recording ---
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state._recordStream = stream;
    state._recordCancelled = false; // clear here — start of fresh recording
    state.audioChunks = [];

    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg',''].find(m => !m || MediaRecorder.isTypeSupported(m));
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.mediaRecorder = recorder;

    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) state.audioChunks.push(e.data); };

    recorder.onstop = async () => {
      // Ensure stream is dead (stop click already kills it, this is belt-and-suspenders)
      if (state._recordStream) {
        state._recordStream.getTracks().forEach(t => t.stop());
        state._recordStream = null;
      }

      // If user cancelled, bail — don't send anything
      if (state._recordCancelled) {
        resetRecordBtn();
        return;
      }

      const blob = new Blob(state.audioChunks, { type: recorder.mimeType || 'audio/webm' });
      if (!blob.size) { resetRecordBtn(); return; }

      if (!state.currentChat) {
        // No chat open — just transcribe and drop into input
        resetRecordBtn();
        try {
          const formData = new FormData();
          formData.append('audio', blob, 'voice.webm');
          const transcribeRes = await fetchWithTimeout('/api/transcribe', { method: 'POST', body: formData }, 120000);
          const data = await transcribeRes.json();
          if (data.text) { document.getElementById('msg-input').value = data.text; autoResize(document.getElementById('msg-input')); }
        } catch (e) { alert('Transcription failed: ' + e.message); }
        return;
      }

      // --- Full voice message flow ---
      const localAudioUrl = URL.createObjectURL(blob);
      const chatId = state.currentChat.id;
      let userMsgId, aiMsgId;
      try {
        // Step 1: Create message rows only — agent does NOT run yet
        const initRes = await api(`/api/chats/${chatId}/send-voice-init`, 'POST');
        userMsgId = initRes.userMsgId;
        aiMsgId = initRes.aiMsgId;
        await loadMessages(); scrollToBottom();

        // Inject local audio player immediately so user can play it back right away
        renderLocalAudioOnMessage(userMsgId, localAudioUrl);

        // Step 2: Upload audio + transcribe (with timeout)
        const formData = new FormData();
        formData.append('audio', blob, 'voice.webm');
        let transcribeRes;
        try {
          const resp = await fetchWithTimeout('/api/transcribe', { method: 'POST', body: formData }, 180000);
          transcribeRes = await resp.json();
        } catch (e) {
          // Transcription failed — update placeholder with error, delete AI placeholder
          await api(`/api/messages/${userMsgId}`, 'PATCH', { content: '🎤 [Transcription failed — ' + e.message + ']' }).catch(() => {});
          await api(`/api/messages/${aiMsgId}`, 'DELETE').catch(() => {});
          await loadMessages().catch(() => {}); scrollToBottom();
          resetRecordBtn();
          return;
        }
        if (transcribeRes.error) {
          await api(`/api/messages/${userMsgId}`, 'PATCH', { content: '🎤 [Transcription failed — ' + transcribeRes.error + ']' }).catch(() => {});
          await api(`/api/messages/${aiMsgId}`, 'DELETE').catch(() => {});
          await loadMessages().catch(() => {}); scrollToBottom();
          resetRecordBtn();
          return;
        }
        const transcript = transcribeRes.text;

        // Step 3: Update user message with real transcript
        await api(`/api/messages/${userMsgId}`, 'PATCH', { content: transcript });
        await loadMessages(); scrollToBottom();

        // Step 4: Now kick the AI with the real transcript
        // The AI placeholder was already created — send transcript as the agent message
        await fetch(`/api/chats/${chatId}/send-voice-reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript,
            aiMsgId,
            audioPath: transcribeRes.audioPath,
            audioFilename: transcribeRes.audioFilename,
          })
        });
        startLegacyPoll(chatId, aiMsgId);
      } catch (e) {
        alert('Voice message failed: ' + e.message);
      } finally {
        resetRecordBtn();
        URL.revokeObjectURL(localAudioUrl);
      }
    };

    recorder.onerror = () => {
      if (state._recordStream) { state._recordStream.getTracks().forEach(t => t.stop()); state._recordStream = null; }
      resetRecordBtn();
      alert('Recording error — please try again.');
    };

    recorder.start();
    state.recording = true;
    btn.textContent = '🔴';
    btn.classList.add('recording');
    btn.title = 'Stop & send';
    if (cancelBtn) cancelBtn.style.display = 'inline-flex';

  } catch (e) {
    resetRecordBtn();
    alert('Microphone access denied: ' + e.message);
  }
}

// Fetch with timeout (ms)
function fetchWithTimeout(url, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out')); }, timeoutMs);
    fetch(url, { ...opts, signal: controller.signal })
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

// Inject a local blob audio player directly into a rendered user message bubble
function renderLocalAudioOnMessage(msgId, blobUrl) {
  const el = document.querySelector(`.message[data-id="${msgId}"]`);
  if (!el) return;
  const existing = el.querySelector('.voice-message-player');
  if (existing) return;
  const player = document.createElement('div');
  player.className = 'voice-message-player';
  player.innerHTML = `<audio controls preload="auto" src="${blobUrl}" style="width:100%;max-width:320px;height:36px"></audio><div class="voice-transcript-label">🎤 Voice message</div>`;
  const content = el.querySelector('.message-content');
  if (content) content.prepend(player); else el.prepend(player);
}

// === Projects ===
async function newProject() {
  showModal(`<h3>New Project</h3>
    <input class="modal-input" id="m-name" placeholder="Project name" autofocus/>
    <textarea class="modal-input modal-textarea" id="m-inst" placeholder="Instructions (optional) — prepended to every message in this project"></textarea>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="createProject()">Create</button>
    </div>`);
}

async function createProject() {
  const name = document.getElementById('m-name').value.trim();
  if (!name) return;
  const instructions = document.getElementById('m-inst').value.trim();
  const proj = await api('/api/projects', 'POST', { name, instructions });
  state.projects.unshift(proj);
  closeModal();
  renderSidebar();
}

async function editProject(id) {
  const proj = state.projects.find(p => p.id === id);
  if (!proj) return;
  showModal(`<h3>Edit Project</h3>
    <input class="modal-input" id="m-name" value="${esc(proj.name)}" autofocus/>
    <textarea class="modal-input modal-textarea" id="m-inst" placeholder="Instructions">${esc(proj.instructions || '')}</textarea>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="saveProject('${id}')">Save</button>
    </div>`);
}

async function saveProject(id) {
  const name = document.getElementById('m-name').value.trim();
  const instructions = document.getElementById('m-inst').value.trim();
  const proj = await api(`/api/projects/${id}`, 'PUT', { name, instructions });
  const idx = state.projects.findIndex(p => p.id === id);
  if (idx >= 0) state.projects[idx] = proj;
  closeModal();
  renderSidebar();
}

async function deleteProject(id) {
  if (!confirm('Delete this project? Chats inside will not be deleted.')) return;
  await api(`/api/projects/${id}`, 'DELETE');
  state.projects = state.projects.filter(p => p.id !== id);
  renderSidebar();
}

function toggleProjectCollapse(id) {
  state.collapsedProjects[id] = !state.collapsedProjects[id];
  renderSidebar();
}

async function openProject(id) {
  stopThinkingCycle();
  let project = state.projects.find(p => p.id === id);
  if (!project) {
    const fresh = await api('/api/projects');
    state.projects = fresh;
    project = state.projects.find(p => p.id === id);
  }
  if (!project) return;
  state.currentView = 'project';
  state.currentProject = project;
  state.currentChat = null;
  renderSidebar();
  pushProjectURL(project);
  document.getElementById('chat-title').textContent = project.name;
  document.getElementById('header-actions').style.display = 'none';
  document.getElementById('input-area').style.display = 'none';
  await renderProjectPage(project);
}

async function renderProjectPage(project) {
  const area = document.getElementById('messages-area');
  area.innerHTML = `<div class="project-page"><div class="project-page-spinner">Loading...</div></div>`;

  // Load files and chats in parallel
  let files = [], chats = [];
  try {
    [files, chats] = await Promise.all([
      api(`/api/projects/${project.id}/files`),
      api(`/api/chats?project_id=${project.id}`),
    ]);
  } catch (e) {
    area.innerHTML = `<div class="project-page"><p style="color:var(--danger)">Failed to load project: ${esc(e.message)}</p></div>`;
    return;
  }

  const filesHTML = files.map(f => {
    const size = f.size > 1024 * 1024
      ? (f.size / 1024 / 1024).toFixed(1) + ' MB'
      : Math.round(f.size / 1024) + ' KB';
    return `<div class="project-file-item" data-id="${f.id}">
      <span class="project-file-icon">📄</span>
      <span class="project-file-name">${esc(f.name)}</span>
      <span class="project-file-size">${size}</span>
      <button class="action-btn" onclick="deleteProjectFile('${project.id}','${f.id}')" title="Delete">🗑</button>
    </div>`;
  }).join('');

  const chatsHTML = chats.map(c => {
    return `<div class="project-chat-item" onclick="openChat('${c.id}')">
      <span style="font-size:14px">💬</span>
      <span class="project-chat-title">${esc(c.title)}</span>
      <span class="project-chat-date">${new Date(c.updated_at).toLocaleDateString()}</span>
    </div>`;
  }).join('');

  area.innerHTML = `
    <div class="project-page">
      <div class="project-page-header">
        <div class="project-page-title">${esc(project.name)}</div>
        <div class="project-page-header-actions">
          <button class="modal-btn secondary" onclick="editProject('${project.id}')">✏️ Edit</button>
          <button class="modal-btn secondary" style="color:var(--danger)" onclick="deleteProjectFromPage('${project.id}')">🗑 Delete</button>
        </div>
      </div>

      <div class="project-page-section">
        <div class="project-section-title">Instructions</div>
        <div class="project-instructions-text">${project.instructions ? esc(project.instructions).replace(/\n/g,'<br>') : '<span style="color:var(--text-muted)">No instructions set. Click Edit to add context for AI.</span>'}</div>
      </div>

      <div class="project-page-section">
        <div class="project-section-title">Files <span style="color:var(--text-muted);font-size:12px;font-weight:400">(added to every chat in this project)</span></div>
        <div class="project-files-drop" id="proj-drop-${project.id}" ondragover="event.preventDefault();this.classList.add('dragover')" ondragleave="this.classList.remove('dragover')" ondrop="handleProjectFileDrop(event,'${project.id}')">
          <div class="project-files-drop-hint">📎 Drop files here or <label style="color:var(--accent);cursor:pointer"><input type="file" multiple style="display:none" onchange="uploadProjectFiles('${project.id}',this.files)">browse</label></div>
        </div>
        <div class="project-files-list" id="proj-files-${project.id}">
          ${filesHTML || '<div class="project-files-empty">No files yet</div>'}
        </div>
      </div>

      <div class="project-page-section">
        <div class="project-section-title" style="display:flex;align-items:center;justify-content:space-between">
          Chats
          <button class="modal-btn primary" style="font-size:12px;padding:6px 12px" onclick="newChat('${project.id}')">+ New Chat</button>
        </div>
        <div class="project-chats-list">
          ${chatsHTML || '<div class="project-files-empty">No chats yet. Start one above.</div>'}
        </div>
      </div>
    </div>
  `;
}

async function deleteProjectFromPage(id) {
  if (!confirm('Delete this project? Chats inside will not be deleted.')) return;
  await api(`/api/projects/${id}`, 'DELETE');
  state.projects = state.projects.filter(p => p.id !== id);
  state.currentView = 'chat';
  state.currentProject = null;
  document.getElementById('chat-title').innerHTML = 'Select or start a chat';
  document.getElementById('header-actions').style.display = 'none';
  document.getElementById('input-area').style.display = 'none';
  document.getElementById('messages-area').innerHTML = `<div class="empty-state"><div class="empty-state-icon">🤖</div><div class="empty-state-text">Start a new chat or select one from the sidebar</div></div>`;
  renderSidebar();
}

function handleProjectFileDrop(e, projectId) {
  e.preventDefault();
  const drop = document.getElementById(`proj-drop-${projectId}`);
  if (drop) drop.classList.remove('dragover');
  uploadProjectFiles(projectId, e.dataTransfer.files);
}

async function uploadProjectFiles(projectId, files) {
  if (!files || !files.length) return;
  const formData = new FormData();
  Array.from(files).forEach(f => formData.append('files', f));
  try {
    await fetch(`/api/projects/${projectId}/files`, { method: 'POST', body: formData }).then(r => r.json());
    // Re-render project page to show new files
    const project = state.projects.find(p => p.id === projectId);
    if (project) await renderProjectPage(project);
  } catch (e) {
    alert('Upload failed: ' + e.message);
  }
}

async function deleteProjectFile(projectId, fileId) {
  if (!confirm('Remove this file from the project?')) return;
  await api(`/api/projects/${projectId}/files/${fileId}`, 'DELETE');
  const project = state.projects.find(p => p.id === projectId);
  if (project) await renderProjectPage(project);
}

async function moveChatToProject(chatId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat) return;
  const optionsHTML = state.projects.map(p =>
    `<div class="move-project-option" onclick="selectMoveProject('${p.id}',this)" data-id="${p.id}" style="padding:10px 12px;border-radius:8px;cursor:pointer;border:2px solid ${chat.project_id===p.id?'var(--accent)':'var(--border)'};background:${chat.project_id===p.id?'var(--surface2)':'transparent'};margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <span>📁</span> ${esc(p.name)}
    </div>`
  ).join('');
  showModal(`<h3>Move Chat to Project</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Select a project for "${esc(chat.title)}"</p>
    <div id="move-project-list">
      <div class="move-project-option" onclick="selectMoveProject(null,this)" data-id="" style="padding:10px 12px;border-radius:8px;cursor:pointer;border:2px solid ${!chat.project_id?'var(--accent)':'var(--border)'};background:${!chat.project_id?'var(--surface2)':'transparent'};margin-bottom:6px;display:flex;align-items:center;gap:8px">
        <span>🚫</span> No Project
      </div>
      ${optionsHTML}
    </div>
    <div style="margin-top:4px;font-size:12px;color:var(--text-muted)">Currently in: ${chat.project_id ? esc(state.projects.find(p=>p.id===chat.project_id)?.name||'Unknown') : 'No project'}</div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="confirmMoveChat('${chatId}')">Move</button>
    </div>`);
  // Store selected project id on the list
  const list = document.getElementById('move-project-list');
  list.dataset.selectedId = chat.project_id || '';
}

function selectMoveProject(projectId, el) {
  const list = document.getElementById('move-project-list');
  list.querySelectorAll('.move-project-option').forEach(opt => {
    opt.style.borderColor = 'var(--border)';
    opt.style.background = 'transparent';
  });
  el.style.borderColor = 'var(--accent)';
  el.style.background = 'var(--surface2)';
  list.dataset.selectedId = projectId || '';
}

async function confirmMoveChat(chatId) {
  const list = document.getElementById('move-project-list');
  const projectId = list.dataset.selectedId || null;
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat) return;
  const updated = await api(`/api/chats/${chatId}`, 'PUT', {
    title: chat.title,
    project_id: projectId || null,
    telegram_session_key: chat.telegram_session_key || null,
  });
  const idx = state.chats.findIndex(c => c.id === chatId);
  if (idx >= 0) state.chats[idx] = updated;
  closeModal();
  renderSidebar();
}

// === Rename/delete chat ===
async function renameChat(id) {
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  showModal(`<h3>Rename Chat</h3>
    <input class="modal-input" id="m-title" value="${esc(chat.title)}" autofocus/>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="saveChatTitle('${id}')">Save</button>
    </div>`);
}

async function saveChatTitle(id) {
  const title = document.getElementById('m-title').value.trim();
  if (!title) return;
  // Optimistic update: rename immediately in sidebar & header before API round-trip
  const idx = state.chats.findIndex(c => c.id === id);
  if (idx >= 0) state.chats[idx] = { ...state.chats[idx], title };
  if (state.currentChat?.id === id) {
    state.currentChat = { ...state.currentChat, title };
    document.getElementById('chat-title').innerHTML = getChatDisplayTitleHTML(state.currentChat);
  }
  closeModal();
  renderSidebar();
  // Persist to server
  const chat = await api(`/api/chats/${id}`, 'PUT', { title });
  if (idx >= 0) state.chats[idx] = chat;
  if (state.currentChat?.id === id) state.currentChat = chat;
}

async function deleteChat(id) {
  if (!confirm('Delete this chat?')) return;
  await api(`/api/chats/${id}`, 'DELETE');
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.currentChat?.id === id) {
    state.currentChat = null;
    document.getElementById('chat-title').innerHTML = 'Select or start a chat';
    document.getElementById('header-actions').style.display = 'none';
    document.getElementById('input-area').style.display = 'none';
    document.getElementById('messages-area').innerHTML = `<div class="empty-state"><div class="empty-state-icon">🤖</div><div class="empty-state-text">Start a new chat or select one from the sidebar</div></div>`;
  }
  renderSidebar();
}

// === Panel-open class on #app (drives full-width chat when panels are closed) ===
function updatePanelOpenClass() {
  const artifactOpen = document.getElementById('artifact-panel').classList.contains('open');
  const skillsOpen = document.getElementById('skills-panel').classList.contains('open');
  const workflowsOpen = document.getElementById('workflows-panel').classList.contains('open');
  document.getElementById('app').classList.toggle('panel-open', artifactOpen || skillsOpen || workflowsOpen);
}

// === Artifacts ===
function toggleArtifactPanel() {
  const panel = document.getElementById('artifact-panel');
  const willOpen = !panel.classList.contains('open');
  panel.classList.toggle('open');
  // Close other panels if opening artifact panel (avoid double-panel on smaller screens)
  if (willOpen) document.getElementById('skills-panel').classList.remove('open');
  if (willOpen) document.getElementById('workflows-panel').classList.remove('open');
  if (willOpen) {
    if (state.artifacts.length) {
      showArtifact(state.currentArtifactIdx >= 0 && state.currentArtifactIdx < state.artifacts.length ? state.currentArtifactIdx : 0);
    } else {
      document.getElementById('artifact-tabs').innerHTML = '';
      document.getElementById('artifact-body').innerHTML = '<div style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">No artifacts in this chat yet.<br><br><span style="font-size:12px;opacity:0.7">Code blocks from responses will appear here.</span></div>';
      document.getElementById('artifact-title').textContent = 'Artifacts';
    }
  }
  updatePanelOpenClass();
}

function closeArtifactPanel() {
  document.getElementById('artifact-panel').classList.remove('open');
  updatePanelOpenClass();
}

function showArtifact(idx) {
  if (!state.artifacts[idx]) return;
  state.currentArtifactIdx = idx;
  const art = state.artifacts[idx];

  document.getElementById('artifact-title').textContent = art.lang || 'Artifact';

  // Tabs
  const tabs = state.artifacts.map((a, i) =>
    `<button class="artifact-tab ${i===idx?'active':''}" onclick="showArtifact(${i})">${a.lang || 'code'}</button>`
  ).join('');
  document.getElementById('artifact-tabs').innerHTML = tabs;

  // Body
  const body = document.getElementById('artifact-body');
  if (art.type === 'code') {
    const highlighted = hljs.highlightAuto(art.content).value;
    body.innerHTML = `<pre><code class="hljs">${highlighted}</code></pre>`;
  } else if (art.lang === 'html') {
    body.innerHTML = `<iframe sandbox="allow-scripts" srcdoc="${esc(art.content)}" style="width:100%;height:100%;border:none;background:white;border-radius:4px;min-height:300px"></iframe>`;
  } else {
    body.innerHTML = renderMarkdown(art.content);
  }
}

function copyArtifact() {
  const art = state.artifacts[state.currentArtifactIdx];
  if (art) navigator.clipboard.writeText(art.content);
}

function downloadArtifact() {
  const art = state.artifacts[state.currentArtifactIdx];
  if (!art) return;
  const ext = art.lang === 'javascript' ? 'js' : art.lang === 'python' ? 'py' : art.lang === 'html' ? 'html' : art.lang === 'css' ? 'css' : 'txt';
  const blob = new Blob([art.content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `artifact.${ext}`;
  a.click();
}

// === Share ===
async function showShareModal() {
  if (!state.currentChat) return;
  showModal(`<h3>Share this chat</h3>
    <p style="font-size:13px;color:var(--text-muted)">Generate a shareable link. Optionally protect with a password.</p>
    <input class="modal-input" id="m-share-pw" type="password" placeholder="Password (optional)"/>
    <div id="share-result" style="display:none">
      <input class="modal-input" id="share-url" readonly onclick="this.select()"/>
    </div>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Close</button>
      <button class="modal-btn primary" onclick="createShare()">Generate Link</button>
    </div>`);
}

async function createShare() {
  const pw = document.getElementById('m-share-pw').value;
  const res = await api('/api/shares', 'POST', {
    resource_type: 'chat',
    resource_id: state.currentChat.id,
    password: pw || null,
  });
  const url = `${location.origin}${res.url}`;
  document.getElementById('share-result').style.display = 'block';
  document.getElementById('share-url').value = url;
}

// === Modal ===
function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
  setTimeout(() => {
    const first = document.querySelector('#modal-content input, #modal-content textarea');
    if (first) first.focus();
  }, 50);
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}

// === Helpers ===
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// === Admin: rename all chats ===
async function renameAllChats() {
  const btn = document.getElementById('rename-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Renaming...'; }
  try {
    const res = await api('/api/admin/rename-all', 'POST');
    showCompletionToast(`✓ Renamed ${res.renamed} of ${res.total} chats`);
    // Reload sidebar with fresh titles
    await loadSidebar();
    // Update current chat header too
    if (state.currentChat) {
      state.currentChat = state.chats.find(c => c.id === state.currentChat.id) || state.currentChat;
      document.getElementById('chat-title').innerHTML = getChatDisplayTitleHTML(state.currentChat);
    }
  } catch (e) {
    alert('Rename failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Rename All Chats'; }
  }
}

// === Workflows Panel ===
let workflowsLoaded = false;
let allWorkflows = [];
let activeWorkflowPath = null;

// --- Workflow Folders (localStorage-based) ---
const WORKFLOWS_STORAGE_KEY = 'openclaw-workflows-folders-v1';

function loadWorkflowFolderState() {
  try {
    const raw = localStorage.getItem(WORKFLOWS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { folders: [], assignments: {}, collapsed: {} };
}

function saveWorkflowFolderState(st) {
  localStorage.setItem(WORKFLOWS_STORAGE_KEY, JSON.stringify(st));
}

// --- Panel open/close ---
function toggleWorkflowsPanel() {
  const panel = document.getElementById('workflows-panel');
  const willOpen = !panel.classList.contains('open');
  panel.classList.toggle('open');
  if (willOpen) {
    document.getElementById('artifact-panel').classList.remove('open');
    document.getElementById('skills-panel').classList.remove('open');
  }
  if (willOpen && !workflowsLoaded) loadWorkflows();
  updatePanelOpenClass();
}

function closeWorkflowsPanel() {
  document.getElementById('workflows-panel').classList.remove('open');
  updatePanelOpenClass();
}

// --- Load workflows from API ---
async function loadWorkflows() {
  try {
    allWorkflows = await api('/api/workflows');
    workflowsLoaded = true;
    renderWorkflowsList(allWorkflows);
  } catch (e) {
    document.getElementById('workflows-list').innerHTML =
      `<div class="skills-loading" style="color:var(--danger)">Failed to load workflows: ${esc(e.message)}</div>`;
  }
}

// --- Render workflows list with folders ---
function renderWorkflowsList(workflows) {
  const el = document.getElementById('workflows-list');
  if (!workflows.length) {
    el.innerHTML = '<div class="skills-loading">No workflows found.<br><span style="font-size:12px;opacity:0.6">Add .md files to ~/.openclaw/workspace/workflows/</span></div>';
    return;
  }

  const fs = loadWorkflowFolderState();
  const isFiltered = workflows.length < allWorkflows.length;

  if (isFiltered) {
    let html = '';
    workflows.forEach(w => {
      const idx = allWorkflows.indexOf(w);
      html += workflowItemHTML(w, idx);
    });
    el.innerHTML = html;
    setupWorkflowDropZone();
    return;
  }

  // Group server-side folders (from filesystem subdirs) + localStorage folders
  // Server-side folder groups first
  const serverFolders = [...new Set(allWorkflows.filter(w => w.folder).map(w => w.folder))].sort();
  const unfoldered = workflows.filter(w => !w.folder && !fs.assignments[w.path]);
  const lsFolderAssigned = workflows.filter(w => !w.folder && fs.assignments[w.path]);

  let html = `<div class="skills-toolbar">
    <button class="skills-add-folder-btn" onclick="newWorkflowFolder()">+ New Folder</button>
  </div>`;

  // Server-side filesystem folders (from subdirectories)
  serverFolders.forEach(folderName => {
    const folderWorkflows = workflows.filter(w => w.folder === folderName);
    const folderId = 'sf_dir_' + folderName;
    const isCollapsed = fs.collapsed[folderId];
    const chevron = isCollapsed ? '&#9654;' : '&#9660;';
    html += `<div class="skills-folder" data-folder-id="${esc(folderId)}">
      <div class="skills-folder-header"
           ondragover="workflowFolderDragOver(event,'${esc(folderId)}')"
           ondragleave="workflowFolderDragLeave(event)"
           ondrop="workflowDropIntoFolder(event,'${esc(folderId)}')">
        <span class="skills-folder-chevron" onclick="toggleWorkflowFolder('${esc(folderId)}')">${chevron}</span>
        <span class="skills-folder-icon">&#128194;</span>
        <span class="skills-folder-name" onclick="toggleWorkflowFolder('${esc(folderId)}')">${esc(folderName)}</span>
        <span class="skills-folder-count">${folderWorkflows.length}</span>
        <div class="skills-folder-actions">
          <button class="skills-folder-btn" onclick="event.stopPropagation();toggleWorkflowFolder('${esc(folderId)}')" title="Toggle">&#9650;</button>
        </div>
      </div>
      ${!isCollapsed ? `<div class="skills-folder-contents">
        ${folderWorkflows.length
          ? folderWorkflows.map(w => { const idx = allWorkflows.indexOf(w); return workflowItemHTML(w, idx); }).join('')
          : `<div class="skills-folder-empty">Empty folder</div>`
        }
      </div>` : ''}
    </div>`;
  });

  // localStorage-based folders
  fs.folders.forEach(folder => {
    const folderWorkflows = lsFolderAssigned.filter(w => fs.assignments[w.path] === folder.id);
    const isCollapsed = fs.collapsed[folder.id];
    const chevron = isCollapsed ? '&#9654;' : '&#9660;';
    html += `<div class="skills-folder" data-folder-id="${esc(folder.id)}">
      <div class="skills-folder-header"
           ondragover="workflowFolderDragOver(event,'${esc(folder.id)}')"
           ondragleave="workflowFolderDragLeave(event)"
           ondrop="workflowDropIntoFolder(event,'${esc(folder.id)}')">
        <span class="skills-folder-chevron" onclick="toggleWorkflowFolder('${esc(folder.id)}')">${chevron}</span>
        <span class="skills-folder-icon">&#128194;</span>
        <span class="skills-folder-name" onclick="toggleWorkflowFolder('${esc(folder.id)}')">${esc(folder.name)}</span>
        <span class="skills-folder-count">${folderWorkflows.length}</span>
        <div class="skills-folder-actions">
          <button class="skills-folder-btn" onclick="event.stopPropagation();renameWorkflowFolder('${esc(folder.id)}')" title="Rename">&#9998;</button>
          <button class="skills-folder-btn" onclick="event.stopPropagation();deleteWorkflowFolder('${esc(folder.id)}')" title="Delete folder">&#128465;</button>
        </div>
      </div>
      ${!isCollapsed ? `<div class="skills-folder-contents">
        ${folderWorkflows.length
          ? folderWorkflows.map(w => { const idx = allWorkflows.indexOf(w); return workflowItemHTML(w, idx); }).join('')
          : `<div class="skills-folder-empty">Drop workflows here</div>`
        }
      </div>` : ''}
    </div>`;
  });

  // Ungrouped (no server folder, no ls folder)
  if (unfoldered.length) {
    if (serverFolders.length || fs.folders.length) {
      html += `<div class="skills-source-label" style="margin-top:6px">Ungrouped</div>`;
    }
    unfoldered.forEach(w => { const idx = allWorkflows.indexOf(w); html += workflowItemHTML(w, idx); });
  }

  el.innerHTML = html;
  setupWorkflowDropZone();
}

function workflowItemHTML(w, idx) {
  const active = activeWorkflowPath === w.path ? 'active' : '';
  return `<div class="skill-item ${active}" data-workflow-idx="${idx}"
    draggable="true"
    ondragstart="workflowDragStart(event,${idx})"
    ondragend="workflowDragEnd(event)"
    onclick="openWorkflowByIdx(this)">
    <div class="skill-item-name">${esc(w.name)}</div>
    ${w.description ? `<div class="skill-item-desc">${esc(w.description)}</div>` : ''}
    <div class="skill-item-footer">
      <span class="skill-item-badge workspace">workflow</span>
      ${!w.folder ? `<button class="skill-move-btn" onclick="event.stopPropagation();moveWorkflowToFolder(${idx})" title="Move to folder">&#128196;</button>` : ''}
    </div>
  </div>`;
}

// --- Drop zone on list background (moves workflow out of ls folder) ---
function setupWorkflowDropZone() {
  const list = document.getElementById('workflows-list');
  list.ondragover = (e) => { e.preventDefault(); };
  list.ondrop = (e) => {
    if (e.target.closest('.skills-folder-header') || e.target.closest('.skills-folder-contents')) return;
    e.preventDefault();
    if (dragWorkflowIdx === null) return;
    const w = allWorkflows[dragWorkflowIdx];
    if (!w || w.folder) return; // can't drag out of filesystem folders
    const fs = loadWorkflowFolderState();
    delete fs.assignments[w.path];
    saveWorkflowFolderState(fs);
    renderWorkflowsList(allWorkflows);
  };
}

// --- Drag & Drop ---
let dragWorkflowIdx = null;

function workflowDragStart(e, idx) {
  dragWorkflowIdx = idx;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function workflowDragEnd(e) {
  dragWorkflowIdx = null;
  document.querySelectorAll('.skill-item.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.skills-folder-header.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function workflowFolderDragOver(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('drag-over');
}

function workflowFolderDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function workflowDropIntoFolder(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  if (dragWorkflowIdx === null) return;
  const w = allWorkflows[dragWorkflowIdx];
  if (!w || w.folder) return; // filesystem-folder workflows can't be reassigned via UI
  const fs = loadWorkflowFolderState();
  fs.assignments[w.path] = folderId;
  saveWorkflowFolderState(fs);
  renderWorkflowsList(allWorkflows);
}

// --- Folder CRUD ---
function toggleWorkflowFolder(folderId) {
  const fs = loadWorkflowFolderState();
  fs.collapsed[folderId] = !fs.collapsed[folderId];
  saveWorkflowFolderState(fs);
  renderWorkflowsList(allWorkflows);
}

function newWorkflowFolder() {
  showModal(`<h3>New Workflows Folder</h3>
    <input class="modal-input" id="m-folder-name" placeholder="Folder name" autofocus/>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="createWorkflowFolder()">Create</button>
    </div>`);
}

function createWorkflowFolder() {
  const name = document.getElementById('m-folder-name').value.trim();
  if (!name) return;
  const fs = loadWorkflowFolderState();
  const id = 'wf_' + Date.now();
  fs.folders.push({ id, name });
  saveWorkflowFolderState(fs);
  closeModal();
  renderWorkflowsList(allWorkflows);
}

function renameWorkflowFolder(folderId) {
  const fs = loadWorkflowFolderState();
  const folder = fs.folders.find(f => f.id === folderId);
  if (!folder) return;
  showModal(`<h3>Rename Folder</h3>
    <input class="modal-input" id="m-folder-name" value="${esc(folder.name)}" autofocus/>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="saveWorkflowFolderName('${esc(folderId)}')">Save</button>
    </div>`);
}

function saveWorkflowFolderName(folderId) {
  const name = document.getElementById('m-folder-name').value.trim();
  if (!name) return;
  const fs = loadWorkflowFolderState();
  const folder = fs.folders.find(f => f.id === folderId);
  if (folder) folder.name = name;
  saveWorkflowFolderState(fs);
  closeModal();
  renderWorkflowsList(allWorkflows);
}

function deleteWorkflowFolder(folderId) {
  if (!confirm('Delete this folder? Workflows inside will be moved to ungrouped.')) return;
  const fs = loadWorkflowFolderState();
  fs.folders = fs.folders.filter(f => f.id !== folderId);
  Object.keys(fs.assignments).forEach(path => {
    if (fs.assignments[path] === folderId) delete fs.assignments[path];
  });
  delete fs.collapsed[folderId];
  saveWorkflowFolderState(fs);
  renderWorkflowsList(allWorkflows);
}

// --- Move workflow via modal ---
function moveWorkflowToFolder(idx) {
  const w = allWorkflows[idx];
  if (!w || w.folder) return;
  const fs = loadWorkflowFolderState();
  const currentFolder = fs.assignments[w.path] || null;
  const optionsHTML = fs.folders.map(f =>
    `<div class="move-project-option" onclick="selectWorkflowMoveFolder('${esc(f.id)}',this)" data-id="${esc(f.id)}"
      style="padding:10px 12px;border-radius:8px;cursor:pointer;border:2px solid ${currentFolder===f.id?'var(--accent)':'var(--border)'};background:${currentFolder===f.id?'var(--surface2)':'transparent'};margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <span>&#128194;</span> ${esc(f.name)}
    </div>`
  ).join('');
  const noFolderSelected = !currentFolder;
  showModal(`<h3>Move to Folder</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">"${esc(w.name)}"</p>
    <div id="workflow-move-list">
      <div class="move-project-option" onclick="selectWorkflowMoveFolder('',this)" data-id=""
        style="padding:10px 12px;border-radius:8px;cursor:pointer;border:2px solid ${noFolderSelected?'var(--accent)':'var(--border)'};background:${noFolderSelected?'var(--surface2)':'transparent'};margin-bottom:6px;display:flex;align-items:center;gap:8px">
        <span>&#128683;</span> No Folder
      </div>
      ${optionsHTML || '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No folders yet.</div>'}
    </div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="confirmWorkflowMove(${idx})">Move</button>
    </div>`);
  const list = document.getElementById('workflow-move-list');
  if (list) list.dataset.selectedId = currentFolder || '';
}

function selectWorkflowMoveFolder(folderId, el) {
  const list = document.getElementById('workflow-move-list');
  list.querySelectorAll('.move-project-option').forEach(opt => {
    opt.style.borderColor = 'var(--border)';
    opt.style.background = 'transparent';
  });
  el.style.borderColor = 'var(--accent)';
  el.style.background = 'var(--surface2)';
  list.dataset.selectedId = folderId || '';
}

function confirmWorkflowMove(idx) {
  const w = allWorkflows[idx];
  if (!w) return;
  const list = document.getElementById('workflow-move-list');
  const folderId = list ? (list.dataset.selectedId || '') : '';
  const fs = loadWorkflowFolderState();
  if (folderId) fs.assignments[w.path] = folderId;
  else delete fs.assignments[w.path];
  saveWorkflowFolderState(fs);
  closeModal();
  renderWorkflowsList(allWorkflows);
}

// --- Open workflow content ---
function openWorkflowByIdx(el) {
  const item = el.closest('.skill-item');
  if (!item) return;
  const idx = parseInt(item.getAttribute('data-workflow-idx'), 10);
  const w = allWorkflows[idx];
  if (w) openWorkflow(w.path, w.name, item);
}

async function openWorkflow(workflowPath, workflowName, el) {
  activeWorkflowPath = workflowPath;
  document.querySelectorAll('[data-workflow-idx]').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  const viewer = document.getElementById('workflows-viewer');
  const body = document.getElementById('workflows-viewer-body');
  const nameEl = document.getElementById('workflows-viewer-name');

  // Hide list + search, show viewer (same pattern as skills)
  document.getElementById('workflows-list').style.display = 'none';
  document.getElementById('workflows-search').parentElement.style.display = 'none';
  viewer.style.display = 'flex';

  nameEl.textContent = workflowName;
  body.innerHTML = '<div class="skills-loading">Loading...</div>';

  try {
    const res = await api(`/api/workflows/content?workflowPath=${encodeURIComponent(workflowPath)}`);
    body.innerHTML = renderMarkdown(res.content);
    body.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  } catch (e) {
    body.innerHTML = `<div style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

function closeWorkflowViewer() {
  document.getElementById('workflows-viewer').style.display = 'none';
  document.getElementById('workflows-list').style.display = '';
  document.getElementById('workflows-search').parentElement.style.display = '';
  activeWorkflowPath = null;
  document.querySelectorAll('[data-workflow-idx]').forEach(i => i.classList.remove('active'));
}

// --- Search ---
function filterWorkflows(query) {
  if (!workflowsLoaded) return;
  const q = query.toLowerCase();
  const filtered = q ? allWorkflows.filter(w =>
    w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q) || (w.folder || '').toLowerCase().includes(q)
  ) : allWorkflows;
  renderWorkflowsList(filtered);
}

// === Skills Panel ===
let skillsLoaded = false;
let allSkills = [];
let activeSkillPath = null;

// --- Skill Folders (localStorage-based) ---
// Structure: { folders: [{id, name}], assignments: {skillPath: folderId}, collapsed: {folderId: bool} }
const SKILLS_STORAGE_KEY = 'openclaw-skills-folders-v1';

function loadSkillFolderState() {
  try {
    const raw = localStorage.getItem(SKILLS_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { folders: [], assignments: {}, collapsed: {} };
}

function saveSkillFolderState(st) {
  localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(st));
}

// --- Panel open/close ---
function toggleSkillsPanel() {
  const panel = document.getElementById('skills-panel');
  const willOpen = !panel.classList.contains('open');
  panel.classList.toggle('open');
  if (willOpen) document.getElementById('artifact-panel').classList.remove('open');
  if (willOpen) document.getElementById('workflows-panel').classList.remove('open');
  if (willOpen && !skillsLoaded) loadSkills();
  updatePanelOpenClass();
}

function closeSkillsPanel() {
  document.getElementById('skills-panel').classList.remove('open');
  updatePanelOpenClass();
}

// --- Load skills from API ---
async function loadSkills() {
  try {
    allSkills = await api('/api/skills');
    skillsLoaded = true;
    renderSkillsList(allSkills);
  } catch (e) {
    document.getElementById('skills-list').innerHTML =
      `<div class="skills-loading" style="color:var(--danger)">Failed to load skills: ${esc(e.message)}</div>`;
  }
}

// --- Render skills list with folders ---
function renderSkillsList(skills) {
  const el = document.getElementById('skills-list');
  if (!skills.length) {
    el.innerHTML = '<div class="skills-loading">No skills found</div>';
    return;
  }

  const fs = loadSkillFolderState();
  const isFiltered = skills.length < allSkills.length; // search active

  if (isFiltered) {
    // Flat list when searching — no folder structure
    let html = '';
    skills.forEach(s => {
      const idx = allSkills.indexOf(s);
      html += skillItemHTML(s, idx, false);
    });
    el.innerHTML = html;
    setupSkillDropZone();
    return;
  }

  // Build folder view
  const unassigned = skills.filter(s => !fs.assignments[s.path]);

  let html = `<div class="skills-toolbar">
    <button class="skills-add-folder-btn" onclick="newSkillFolder()">+ New Folder</button>
  </div>`;

  // Render each folder
  fs.folders.forEach(folder => {
    const folderSkills = skills.filter(s => fs.assignments[s.path] === folder.id);
    const isCollapsed = fs.collapsed[folder.id];
    const chevron = isCollapsed ? '&#9654;' : '&#9660;';
    html += `<div class="skills-folder" data-folder-id="${esc(folder.id)}">
      <div class="skills-folder-header"
           ondragover="skillFolderDragOver(event,'${esc(folder.id)}')"
           ondragleave="skillFolderDragLeave(event)"
           ondrop="skillDropIntoFolder(event,'${esc(folder.id)}')">
        <span class="skills-folder-chevron" onclick="toggleSkillFolder('${esc(folder.id)}')">${chevron}</span>
        <span class="skills-folder-icon">&#128194;</span>
        <span class="skills-folder-name" onclick="toggleSkillFolder('${esc(folder.id)}')">${esc(folder.name)}</span>
        <span class="skills-folder-count">${folderSkills.length}</span>
        <div class="skills-folder-actions">
          <button class="skills-folder-btn" onclick="event.stopPropagation();renameSkillFolder('${esc(folder.id)}')" title="Rename">&#9998;</button>
          <button class="skills-folder-btn" onclick="event.stopPropagation();deleteSkillFolder('${esc(folder.id)}')" title="Delete folder">&#128465;</button>
        </div>
      </div>
      ${!isCollapsed ? `<div class="skills-folder-contents">
        ${folderSkills.length
          ? folderSkills.map(s => { const idx = allSkills.indexOf(s); return skillItemHTML(s, idx, true, folder.id); }).join('')
          : `<div class="skills-folder-empty">Drop skills here</div>`
        }
      </div>` : ''}
    </div>`;
  });

  // Ungrouped skills
  if (unassigned.length) {
    if (fs.folders.length) {
      html += `<div class="skills-source-label" style="margin-top:6px">Ungrouped</div>`;
    } else {
      // No folders at all — show by source
      const workspaceUn = unassigned.filter(s => s.source === 'workspace');
      const systemUn = unassigned.filter(s => s.source === 'system');
      if (workspaceUn.length) {
        html += `<div class="skills-source-label">&#128193; Workspace</div>`;
        workspaceUn.forEach(s => { const idx = allSkills.indexOf(s); html += skillItemHTML(s, idx, false); });
      }
      if (systemUn.length) {
        html += `<div class="skills-source-label">&#9881; System</div>`;
        systemUn.forEach(s => { const idx = allSkills.indexOf(s); html += skillItemHTML(s, idx, false); });
      }
      el.innerHTML = html;
      setupSkillDropZone();
      return;
    }
    unassigned.forEach(s => { const idx = allSkills.indexOf(s); html += skillItemHTML(s, idx, false); });
  }

  el.innerHTML = html;
  setupSkillDropZone();
}

function skillItemHTML(s, idx, inFolder, folderId) {
  const active = activeSkillPath === s.path ? 'active' : '';
  return `<div class="skill-item ${active}" data-skill-idx="${idx}"
    draggable="true"
    ondragstart="skillDragStart(event,${idx})"
    ondragend="skillDragEnd(event)"
    onclick="openSkillByIdx(this)">
    <div class="skill-item-name">${esc(s.name)}</div>
    ${s.description ? `<div class="skill-item-desc">${esc(s.description)}</div>` : ''}
    <div class="skill-item-footer">
      <span class="skill-item-badge ${s.source}">${s.source}</span>
      <button class="skill-move-btn" onclick="event.stopPropagation();moveSkillToFolder(${idx})" title="Move to folder">&#128196;</button>
    </div>
  </div>`;
}

// --- Drop zone on list background (moves skill out of folder) ---
function setupSkillDropZone() {
  const list = document.getElementById('skills-list');
  list.ondragover = (e) => { e.preventDefault(); };
  list.ondrop = (e) => {
    if (e.target.closest('.skills-folder-header') || e.target.closest('.skills-folder-contents')) return;
    e.preventDefault();
    if (dragSkillIdx === null) return;
    const s = allSkills[dragSkillIdx];
    if (!s) return;
    const fs = loadSkillFolderState();
    delete fs.assignments[s.path];
    saveSkillFolderState(fs);
    renderSkillsList(allSkills);
  };
}

// --- Drag & Drop ---
let dragSkillIdx = null;

function skillDragStart(e, idx) {
  dragSkillIdx = idx;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function skillDragEnd(e) {
  dragSkillIdx = null;
  document.querySelectorAll('.skill-item.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.skills-folder-header.drag-over').forEach(el => el.classList.remove('drag-over'));
}

function skillFolderDragOver(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.add('drag-over');
}

function skillFolderDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function skillDropIntoFolder(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('drag-over');
  if (dragSkillIdx === null) return;
  const s = allSkills[dragSkillIdx];
  if (!s) return;
  const fs = loadSkillFolderState();
  fs.assignments[s.path] = folderId;
  saveSkillFolderState(fs);
  renderSkillsList(allSkills);
}

// --- Folder CRUD ---
function toggleSkillFolder(folderId) {
  const fs = loadSkillFolderState();
  fs.collapsed[folderId] = !fs.collapsed[folderId];
  saveSkillFolderState(fs);
  renderSkillsList(allSkills);
}

function newSkillFolder() {
  showModal(`<h3>New Skills Folder</h3>
    <input class="modal-input" id="m-folder-name" placeholder="Folder name" autofocus/>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="createSkillFolder()">Create</button>
    </div>`);
}

function createSkillFolder() {
  const name = document.getElementById('m-folder-name').value.trim();
  if (!name) return;
  const fs = loadSkillFolderState();
  const id = 'sf_' + Date.now();
  fs.folders.push({ id, name });
  saveSkillFolderState(fs);
  closeModal();
  renderSkillsList(allSkills);
}

function renameSkillFolder(folderId) {
  const fs = loadSkillFolderState();
  const folder = fs.folders.find(f => f.id === folderId);
  if (!folder) return;
  showModal(`<h3>Rename Folder</h3>
    <input class="modal-input" id="m-folder-name" value="${esc(folder.name)}" autofocus/>
    <div class="modal-actions">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="saveSkillFolderName('${esc(folderId)}')">Save</button>
    </div>`);
}

function saveSkillFolderName(folderId) {
  const name = document.getElementById('m-folder-name').value.trim();
  if (!name) return;
  const fs = loadSkillFolderState();
  const folder = fs.folders.find(f => f.id === folderId);
  if (folder) folder.name = name;
  saveSkillFolderState(fs);
  closeModal();
  renderSkillsList(allSkills);
}

function deleteSkillFolder(folderId) {
  if (!confirm('Delete this folder? Skills inside will be moved to ungrouped.')) return;
  const fs = loadSkillFolderState();
  fs.folders = fs.folders.filter(f => f.id !== folderId);
  Object.keys(fs.assignments).forEach(path => {
    if (fs.assignments[path] === folderId) delete fs.assignments[path];
  });
  delete fs.collapsed[folderId];
  saveSkillFolderState(fs);
  renderSkillsList(allSkills);
}

// --- Move skill via modal ---
function moveSkillToFolder(idx) {
  const s = allSkills[idx];
  if (!s) return;
  const fs = loadSkillFolderState();
  const currentFolder = fs.assignments[s.path] || null;
  const optionsHTML = fs.folders.map(f =>
    `<div class="move-project-option" onclick="selectSkillMoveFolder('${esc(f.id)}',this)" data-id="${esc(f.id)}"
      style="padding:10px 12px;border-radius:8px;cursor:pointer;border:2px solid ${currentFolder===f.id?'var(--accent)':'var(--border)'};background:${currentFolder===f.id?'var(--surface2)':'transparent'};margin-bottom:6px;display:flex;align-items:center;gap:8px">
      <span>&#128194;</span> ${esc(f.name)}
    </div>`
  ).join('');
  const noFolderSelected = !currentFolder;
  showModal(`<h3>Move to Folder</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">"${esc(s.name)}"</p>
    <div id="skill-move-list">
      <div class="move-project-option" onclick="selectSkillMoveFolder('',this)" data-id=""
        style="padding:10px 12px;border-radius:8px;cursor:pointer;border:2px solid ${noFolderSelected?'var(--accent)':'var(--border)'};background:${noFolderSelected?'var(--surface2)':'transparent'};margin-bottom:6px;display:flex;align-items:center;gap:8px">
        <span>&#128683;</span> No Folder
      </div>
      ${optionsHTML || '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No folders yet.</div>'}
    </div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="confirmSkillMove(${idx})">Move</button>
    </div>`);
  const list = document.getElementById('skill-move-list');
  if (list) list.dataset.selectedId = currentFolder || '';
}

function selectSkillMoveFolder(folderId, el) {
  const list = document.getElementById('skill-move-list');
  list.querySelectorAll('.move-project-option').forEach(opt => {
    opt.style.borderColor = 'var(--border)';
    opt.style.background = 'transparent';
  });
  el.style.borderColor = 'var(--accent)';
  el.style.background = 'var(--surface2)';
  list.dataset.selectedId = folderId || '';
}

function confirmSkillMove(idx) {
  const s = allSkills[idx];
  if (!s) return;
  const list = document.getElementById('skill-move-list');
  const folderId = list ? (list.dataset.selectedId || '') : '';
  const fs = loadSkillFolderState();
  if (folderId) fs.assignments[s.path] = folderId;
  else delete fs.assignments[s.path];
  saveSkillFolderState(fs);
  closeModal();
  renderSkillsList(allSkills);
}

// --- Open skill content ---
function openSkillByIdx(el) {
  const item = el.closest('.skill-item');
  if (!item) return;
  const idx = parseInt(item.getAttribute('data-skill-idx'), 10);
  const s = allSkills[idx];
  if (s) openSkill(s.path, s.name, item);
}

async function openSkill(skillPath, skillName, el) {
  activeSkillPath = skillPath;
  document.querySelectorAll('.skill-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  const viewer = document.getElementById('skills-viewer');
  const body = document.getElementById('skills-viewer-body');
  const nameEl = document.getElementById('skills-viewer-name');

  nameEl.textContent = skillName;
  body.innerHTML = '<div class="skills-viewer-loading"><span class="spinner"></span> Loading...</div>';
  viewer.style.display = 'flex';

  try {
    const res = await api(`/api/skills/content?skillPath=${encodeURIComponent(skillPath)}`);
    body.innerHTML = renderMarkdown(res.content);
    body.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  } catch (e) {
    body.innerHTML = `<div style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

function closeSkillViewer() {
  document.getElementById('skills-viewer').style.display = 'none';
  activeSkillPath = null;
  document.querySelectorAll('.skill-item').forEach(i => i.classList.remove('active'));
}

// --- Search ---
function filterSkills(query) {
  if (!skillsLoaded) return;
  const q = query.toLowerCase();
  const filtered = q ? allSkills.filter(s =>
    s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
  ) : allSkills;
  renderSkillsList(filtered);
}

// === Copy / Retry on user messages ===
function copyMsgContent(btn) {
  const text = btn.getAttribute('data-content');
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  }).catch(() => {});
}

function retryMsg(btn) {
  const text = btn.getAttribute('data-content');
  if (!text) return;
  const input = document.getElementById('msg-input');
  input.value = text;
  autoResize(input);
  sendMessage();
}

// === Message queue (per-chat) ===
function getChatQueue(chatId) {
  if (!state.messageQueue[chatId]) state.messageQueue[chatId] = [];
  return state.messageQueue[chatId];
}

function renderQueue() {
  let container = document.getElementById('message-queue');
  if (!container) {
    container = document.createElement('div');
    container.id = 'message-queue';
    const inputArea = document.getElementById('input-area');
    if (inputArea) inputArea.prepend(container);
  }
  const chatId = state.currentChat?.id;
  const queue = chatId ? getChatQueue(chatId) : [];
  if (!queue.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'block';
  let html = `<div class="queue-header">
    <span class="queue-title">⏳ Queued (${queue.length})</span>
    <button class="queue-clear-all" onclick="clearQueue()">Clear all</button>
  </div>`;
  queue.forEach((item, idx) => {
    html += `<div class="queue-item">
      <span class="queue-idx">${idx + 1}</span>
      <span class="queue-item-text">${esc(item.text.length > 80 ? item.text.slice(0, 80) + '…' : item.text)}</span>
      <div class="queue-item-actions">
        <button class="queue-btn" onclick="editQueueItem('${item.id}')">Edit</button>
        <button class="queue-btn danger" onclick="removeQueueItem('${item.id}')">✕</button>
      </div>
    </div>`;
  });
  container.innerHTML = html;
}

function clearQueue() {
  const chatId = state.currentChat?.id;
  if (chatId) state.messageQueue[chatId] = [];
  renderQueue();
}

function removeQueueItem(id) {
  const chatId = state.currentChat?.id;
  if (!chatId) return;
  state.messageQueue[chatId] = getChatQueue(chatId).filter(i => i.id !== id);
  renderQueue();
}

function editQueueItem(id) {
  const chatId = state.currentChat?.id;
  if (!chatId) return;
  const queue = getChatQueue(chatId);
  const item = queue.find(i => i.id === id);
  if (!item) return;
  state.messageQueue[chatId] = queue.filter(i => i.id !== id);
  state.pendingFiles = item.files || [];
  renderQueue();
  const input = document.getElementById('msg-input');
  input.value = item.text;
  autoResize(input);
  input.focus();
}

async function processNextQueueItem(chatId) {
  const queue = getChatQueue(chatId);
  if (!queue.length) return;
  if (!state.currentChat || state.currentChat.id !== chatId) return;
  const item = queue.shift();
  renderQueue();
  state.pendingFiles = item.files || [];
  const input = document.getElementById('msg-input');
  input.value = item.text;
  autoResize(input);
  await sendMessage();
}

async function stopGeneration() {
  if (!state.currentChat) return;
  const chatId = state.currentChat.id;
  // For SSE streams, abort() closes the EventSource which triggers the server-side req.close event
  clearPollInterval(chatId);
  clearQueue(); // clears only current chat's queue
  // Also hit abort endpoint in case server-side cleanup is needed
  try { await api(`/api/chats/${chatId}/abort`, 'POST'); } catch {}
  stopThinkingCycle();
  updateStopBtn(chatId);
  await loadMessages();
  activateLastUserMessageEdit();
}

// === Edit-after-stop ===

function activateLastUserMessageEdit() {
  const area = document.getElementById('messages-area');
  // Find the last user message that has a data-id
  const userMsgs = area.querySelectorAll('.message.user[data-id]');
  if (!userMsgs.length) return;
  const lastUserMsg = userMsgs[userMsgs.length - 1];
  const msgId = lastUserMsg.getAttribute('data-id');
  enterMessageEditMode(lastUserMsg, msgId);
}

function enterMessageEditMode(msgEl, msgId) {
  // Grab existing text from the bubble
  const bubble = msgEl.querySelector('.message-bubble');
  // decode HTML entities back to plain text
  const raw = bubble ? bubble.innerText : '';

  // Grab existing attachments
  const attChips = msgEl.querySelectorAll('.attachment-chip');
  const existingAttNames = Array.from(attChips).map(c => {
    const txt = c.textContent.trim().replace(/^📎\s*/, '');
    return txt;
  });

  // Replace message content with inline editor
  const contentEl = msgEl.querySelector('.message-content');
  if (!contentEl) return;

  // Mark message as being edited
  msgEl.classList.add('editing');

  const existingAttHTML = existingAttNames.length
    ? `<div class="edit-existing-atts">${existingAttNames.map(n => `<span class="edit-att-chip">📎 ${esc(n)}</span>`).join('')}<span class="edit-att-note">(existing attachments will be re-sent)</span></div>`
    : '';

  contentEl.innerHTML = `
    <div class="msg-edit-container" data-msg-id="${msgId}">
      <textarea class="msg-edit-textarea" id="msg-edit-${msgId}" rows="3">${esc(raw)}</textarea>
      ${existingAttHTML}
      <div class="msg-edit-new-atts" id="msg-edit-atts-${msgId}"></div>
      <div class="msg-edit-toolbar">
        <label class="msg-edit-file-btn" title="Add files or images">
          📎 Add files
          <input type="file" multiple style="display:none" onchange="handleEditFiles('${msgId}',this.files)">
        </label>
        <div style="flex:1"></div>
        <button class="msg-action-btn" onclick="cancelMessageEdit('${msgId}')">Cancel</button>
        <button class="msg-action-btn primary" onclick="submitMessageEdit('${msgId}')">↩ Resend</button>
      </div>
    </div>`;

  // Auto-resize textarea
  const ta = document.getElementById(`msg-edit-${msgId}`);
  if (ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
    });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitMessageEdit(msgId); }
      if (e.key === 'Escape') cancelMessageEdit(msgId);
    });
  }

  // Store pending new files for this edit
  state._editFiles = state._editFiles || {};
  state._editFiles[msgId] = [];
}

function handleEditFiles(msgId, files) {
  state._editFiles = state._editFiles || {};
  state._editFiles[msgId] = state._editFiles[msgId] || [];
  const container = document.getElementById(`msg-edit-atts-${msgId}`);
  Array.from(files).forEach(f => {
    state._editFiles[msgId].push(f);
    if (container) {
      const chip = document.createElement('div');
      chip.className = 'input-attachment';
      chip.dataset.editMsgId = msgId;
      chip.dataset.name = f.name;
      chip.innerHTML = `📎 ${esc(f.name)} <button class="input-attachment-remove" onclick="removeEditFile('${msgId}','${esc(f.name)}',this)">×</button>`;
      container.appendChild(chip);
    }
  });
}

function removeEditFile(msgId, name, btn) {
  state._editFiles = state._editFiles || {};
  if (state._editFiles[msgId]) {
    state._editFiles[msgId] = state._editFiles[msgId].filter(f => f.name !== name);
  }
  if (btn) btn.parentElement.remove();
}

async function cancelMessageEdit(msgId) {
  // Just reload messages to restore original view
  await loadMessages();
}

async function submitMessageEdit(msgId) {
  if (!state.currentChat) return;
  const ta = document.getElementById(`msg-edit-${msgId}`);
  const text = ta ? ta.value.trim() : '';
  const newFiles = (state._editFiles && state._editFiles[msgId]) || [];

  if (!text && !newFiles.length) return;

  const chatId = state.currentChat.id;

  // Disable UI during submission
  const btn = document.querySelector(`.msg-edit-container[data-msg-id="${msgId}"] .msg-action-btn.primary`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    // Delete the stopped AI reply (the message right after this user msg)
    // and delete the original user message, then send fresh
    const area = document.getElementById('messages-area');
    const userMsgEl = area.querySelector(`.message.user[data-id="${msgId}"]`);
    let aiMsgToDelete = null;
    if (userMsgEl) {
      // Walk siblings to find the next assistant message
      let sib = userMsgEl.nextElementSibling;
      while (sib) {
        if (sib.classList.contains('message') && sib.classList.contains('assistant')) {
          aiMsgToDelete = sib.getAttribute('data-id');
          break;
        }
        sib = sib.nextElementSibling;
      }
    }

    // Delete the stopped AI message if found
    if (aiMsgToDelete) {
      await api(`/api/messages/${aiMsgToDelete}`, 'DELETE');
    }
    // Delete the original user message
    await api(`/api/messages/${msgId}`, 'DELETE');

    // Now send fresh message (reusing existing send machinery)
    // Temporarily set pendingFiles to the new files and trigger send
    state.pendingFiles = newFiles;
    // Re-render the attachments preview (just in case)
    const attEl = document.getElementById('input-attachments');
    if (attEl) attEl.innerHTML = '';
    newFiles.forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'input-attachment';
      chip.dataset.name = f.name;
      chip.innerHTML = `📎 ${esc(f.name)}`;
      if (attEl) attEl.appendChild(chip);
    });

    // Put text in input and fire send
    const input = document.getElementById('msg-input');
    if (input) { input.value = text; autoResize(input); }

    // Clear edit state
    if (state._editFiles) delete state._editFiles[msgId];

    await sendMessage();
  } catch (e) {
    alert('Failed to resend: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '↩ Resend'; }
  }
}

function updateStopBtn(chatId) {
  const btn = document.getElementById('stop-btn');
  if (!btn) return;
  const active = !!(chatId && hasPendingPoll(chatId));
  btn.style.display = active ? 'flex' : 'none';
}
