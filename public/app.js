window.currentUser = null;

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
    if (btn) btn.textContent = '🌙 Dark mode';
    if (hljsDark) hljsDark.disabled = true;
    if (hljsLight) hljsLight.disabled = false;
    localStorage.setItem('openclaw-theme', 'light');
  } else {
    root.classList.remove('light');
    if (btn) btn.textContent = '☀️ Light mode';
    if (hljsDark) hljsDark.disabled = false;
    if (hljsLight) hljsLight.disabled = true;
    localStorage.setItem('openclaw-theme', 'dark');
  }
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  applyTheme(isLight ? 'dark' : 'light');
}

// === Tools menu ===
function toggleToolsMenu() {
  const dd = document.getElementById('tools-menu-dropdown');
  if (!dd) return;
  const open = dd.style.display === 'none';
  if (open) {
    // For guest users: hide all items except Theme
    const isGuest = document.documentElement.dataset.guestMode === '1';
    dd.querySelectorAll('.tools-menu-item, .tools-menu-divider').forEach(el => {
      if (isGuest) {
        el.style.display = el.id === 'theme-toggle-btn' ? '' : 'none';
      } else {
        el.style.display = '';
      }
    });
  }
  dd.style.display = open ? 'flex' : 'none';
}
function closeToolsMenu() {
  const dd = document.getElementById('tools-menu-dropdown');
  if (dd) dd.style.display = 'none';
}
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('tools-menu-wrap');
  if (wrap && !wrap.contains(e.target)) closeToolsMenu();
});

// === Mobile sidebar toggle ===
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const open = sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('active', open);
}
function closeSidebarMobile() {
  if (window.innerWidth > 768) return;
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
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
  // Server-reported agent busy status per chat (synced via SSE)
  chatAgentBusy: {}, // { [chatId]: bool }
  chatThinkingMsgId: {}, // { [chatId]: string|null } — the specific aiMsgId currently in-flight
  // Server-reported shared queue per chat (synced via SSE)
  chatSharedQueue: {}, // { [chatId]: Array<{id, senderName, preview, enqueuedAt}> }
  pendingFiles: [],
  messageQueue: {}, // keyed by chatId: { [chatId]: [] }
  drafts: JSON.parse(localStorage.getItem('openclaw-drafts') || '{}'),
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
  // Load instance name for tab title, sidebar logo, and input placeholder
  try {
    const cfg = await api('/api/app-config');
    const name = cfg.instanceName || 'My Agent';
    window._instanceName = name;
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = name;
    const sidebarName = document.getElementById('sidebar-instance-name');
    if (sidebarName) sidebarName.textContent = name;
    const loginName = document.getElementById('login-instance-name');
    if (loginName) loginName.textContent = name;
    const msgInput = document.getElementById('msg-input');
    if (msgInput) msgInput.placeholder = `Message ${name}...`;
  } catch (e) { /* keep defaults */ }
  // Handle /reset-password SPA route
  if (window.location.pathname === '/reset-password') {
    document.getElementById('reset-password-screen').style.display = 'flex';
    setupMarked();
    return;
  }
  // Handle /admin SPA route
  if (window.location.pathname === '/admin') {
    const res2 = await api('/api/me');
    if (res2.authenticated && (res2.user?.role === 'admin' || res2.user?.role === 'accord')) {
      state.authenticated = true;
      window.currentUser = res2.user;
      setupMarked();
      showAdminPanel();
      return;
    } else {
      window.location.href = '/';
      return;
    }
  }

  const res = await api('/api/me');
  if (res.authenticated) {
    state.authenticated = true;
    window.currentUser = res.user || null;
    if (window.currentUser) setupUserMenu(window.currentUser);
    showApp();
  } else {
    // Check for ?reset=1 success message
    const params = new URLSearchParams(window.location.search);
    const loginScreen = document.getElementById('login-screen');
    loginScreen.style.display = 'flex';
    if (params.get('reset') === '1') {
      const errEl = document.getElementById('login-error');
      if (errEl) {
        errEl.style.display = 'block';
        errEl.style.color = '#6ee7b7';
        errEl.textContent = 'Password reset successfully. Please sign in.';
      }
    }
  }
  setupDragDrop();
  setupMarked();
  setupPaste();

  // Clicking anywhere on the input-row always focuses the textarea
  const inputRow = document.getElementById('input-row');
  if (inputRow) {
    inputRow.addEventListener('click', (e) => {
      const msgInput = document.getElementById('msg-input');
      if (msgInput && e.target !== msgInput) msgInput.focus();
    });
  }
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
  const email = (document.getElementById('login-email')?.value || '').trim();
  const password = document.getElementById('login-pw').value;
  const rememberMe = !!(document.getElementById('login-remember')?.checked);
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe })
    });
    const data = await res.json();
    if (data.ok) {
      window.currentUser = data.user;
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      state.authenticated = true;
      setupUserMenu(data.user);
      showApp();
    } else {
      errEl.textContent = data.error || 'Login failed';
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Network error';
    errEl.style.display = 'block';
  }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.currentUser = null;
  window.location.reload();
}

function showForgotForm() {
  document.getElementById('login-form-view').style.display = 'none';
  document.getElementById('forgot-form-view').style.display = 'block';
}
function showLoginForm() {
  document.getElementById('forgot-form-view').style.display = 'none';
  document.getElementById('login-form-view').style.display = 'block';
}
async function doForgotPassword() {
  const email = document.getElementById('forgot-email').value.trim();
  const msg = document.getElementById('forgot-msg');
  msg.style.display = 'none';
  await fetch('/api/auth/forgot-password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
  msg.style.display = 'block';
  msg.style.color = '#6ee7b7';
  msg.textContent = 'If that email exists, a reset link has been sent.';
}
async function doResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token');
  const pw = document.getElementById('reset-pw').value;
  const pw2 = document.getElementById('reset-pw2').value;
  const msg = document.getElementById('reset-msg');
  msg.style.display = 'none';
  if (pw !== pw2) { msg.style.display='block'; msg.textContent='Passwords do not match'; return; }
  if (pw.length < 8) { msg.style.display='block'; msg.textContent='Minimum 8 characters'; return; }
  const res = await fetch('/api/auth/reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, password: pw }) });
  const data = await res.json();
  if (data.ok) {
    window.location.href = '/?reset=1';
  } else {
    msg.style.display='block'; msg.textContent = data.error || 'Error resetting password';
  }
}
function setupUserMenu(user) {
  if (!user) return;
  const wrap = document.getElementById('user-menu-wrap');
  if (wrap) wrap.style.display = 'block';
  const initial = document.getElementById('user-avatar-initial');
  if (initial) initial.textContent = (user.display_name || user.email || 'A')[0].toUpperCase();
  const emailEl = document.getElementById('user-menu-email-display');
  if (emailEl) emailEl.textContent = user.email || '';
  // Show Admin Panel link for admin and accord users
  const adminBtn = document.getElementById('admin-panel-btn');
  if (adminBtn && (user.role === 'admin' || user.role === 'accord')) {
    adminBtn.style.display = 'block';
  }
  const updateBtn = document.getElementById('update-check-btn');
  if (updateBtn && (user.role === 'admin' || user.role === 'accord')) {
    updateBtn.style.display = 'block';
  }
  // Guest restrictions
  if (user.role === 'guest') {
    applyGuestUI();
  }
}

function applyGuestUI() {
  // Hide sidebar "+ New Chat" button (guests can't create project-less chats)
  const newChatBtn = document.querySelector('.new-chat-btn');
  if (newChatBtn) newChatBtn.style.display = 'none';
  // Tools menu: hide all items except Theme
  // We flag this so toggleToolsMenu can re-apply it after DOM changes
  document.documentElement.dataset.guestMode = '1';
}
function toggleUserMenu() {
  const dd = document.getElementById('user-menu-dropdown');
  if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}
async function showSettingsModal() {
  const user = window.currentUser || {};
  showModal(`
    <h3 style="margin:0 0 16px">Settings</h3>
    <label style="display:block;margin-bottom:4px;font-size:13px;opacity:.7">Display name</label>
    <input type="text" id="settings-display-name" class="modal-input" value="${(user.display_name || '').replace(/"/g,'&quot;')}" placeholder="Display name" style="width:100%;margin-bottom:12px"/>
    <button class="modal-btn primary" onclick="saveDisplayName()">Save name</button>
    <hr style="margin:16px 0;opacity:.2"/>
    <label style="display:block;margin-bottom:4px;font-size:13px;opacity:.7">Change password</label>
    <input type="password" id="settings-current-pw" class="modal-input" placeholder="Current password" style="width:100%;margin-bottom:8px"/>
    <input type="password" id="settings-new-pw" class="modal-input" placeholder="New password (min 8)" style="width:100%;margin-bottom:8px"/>
    <input type="password" id="settings-new-pw2" class="modal-input" placeholder="Confirm new password" style="width:100%;margin-bottom:12px"/>
    <button class="modal-btn primary" onclick="saveNewPassword()">Change password</button>
    <div id="settings-msg" style="margin-top:8px;font-size:13px;display:none"></div>
  `);
}
async function saveDisplayName() {
  const name = document.getElementById('settings-display-name').value.trim();
  const msg = document.getElementById('settings-msg');
  const res = await fetch('/api/settings/profile', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ display_name: name }) });
  const data = await res.json();
  msg.style.display = 'block';
  if (data.ok) {
    msg.style.color = '#6ee7b7'; msg.textContent = 'Name updated!';
    if (window.currentUser) window.currentUser.display_name = name;
    const initial = document.getElementById('user-avatar-initial');
    if (initial) initial.textContent = (name || 'A')[0].toUpperCase();
  } else { msg.style.color = '#f87171'; msg.textContent = data.error || 'Error'; }
}
async function saveNewPassword() {
  const curr = document.getElementById('settings-current-pw').value;
  const np = document.getElementById('settings-new-pw').value;
  const np2 = document.getElementById('settings-new-pw2').value;
  const msg = document.getElementById('settings-msg');
  msg.style.display = 'none';
  if (np !== np2) { msg.style.display='block'; msg.style.color='#f87171'; msg.textContent='Passwords do not match'; return; }
  if (np.length < 8) { msg.style.display='block'; msg.style.color='#f87171'; msg.textContent='Min 8 characters'; return; }
  const res = await fetch('/api/settings/password', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ current_password: curr, new_password: np }) });
  const data = await res.json();
  msg.style.display = 'block';
  if (data.ok) { msg.style.color='#6ee7b7'; msg.textContent='Password updated!'; }
  else { msg.style.color='#f87171'; msg.textContent=data.error||'Error'; }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('login-screen').style.display !== 'none') {
    doLogin();
  }
});

// --- Global user-event SSE ---
let globalEventSource = null;
function startGlobalEventStream() {
  if (globalEventSource) { globalEventSource.close(); globalEventSource = null; }
  const es = new EventSource('/api/events');
  globalEventSource = es;

  es.addEventListener('chat_created', e => {
    try {
      const { chat } = JSON.parse(e.data);
      // Only inject if this user didn't create it (they already have it in state)
      // and it's not already in state.chats
      if (chat && !state.chats.find(c => c.id === chat.id)) {
        state.chats.unshift(chat);
        renderSidebar();
      }
    } catch {}
  });

  es.onerror = () => {
    // Auto-reconnect: browser handles it for EventSource, but close and reopen on error
    setTimeout(() => {
      if (globalEventSource === es) startGlobalEventStream();
    }, 5000);
  };
}

async function showApp() {
  document.getElementById('app').style.display = 'flex';
  await loadSidebar();
  // Start global event stream for real-time sidebar updates
  startGlobalEventStream();
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
  // /join/:token (Phase 3)
  const joinMatch = path.match(/^\/join\/([^/]+)$/);
  if (joinMatch) { handleJoinRoute(); return; }
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

  // Flat list sorted by updated_at DESC — deduplicate by id defensively
  const seenIds = new Set();
  let chats = state.chats.filter(c => { if (seenIds.has(c.id)) return false; seenIds.add(c.id); return true; });
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
  const hasDraft = !!(state.drafts[c.id] && state.currentChat?.id !== c.id);
  let titleHTML;
  if (proj) {
    titleHTML = `<span class="chat-item-title"><span class="chat-item-project-name" onclick="event.stopPropagation();openProject('${proj.id}')">${esc(proj.name)}</span><span class="chat-item-sep"> / </span>${esc(c.title)}</span>`;
  } else {
    titleHTML = `<span class="chat-item-title">${esc(c.title)}</span>`;
  }
  const badge = hasUnread ? `<span class="new-reply-badge">new</span>` : '';
  const draftBadge = hasDraft ? `<span class="chat-draft-badge">draft</span>` : '';
  return `<div class="chat-item ${active}" onclick="openChat('${c.id}')" data-id="${c.id}">
    <span style="font-size:14px">💬</span>
    ${titleHTML}
    ${badge}
    ${draftBadge}
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
          ${(window.currentUser?.role === 'admin' || window.currentUser?.role === 'accord') ? `<button class="action-btn" onclick="event.stopPropagation();showProjectSettings('${p.id}')" title="Project Settings">⚙️</button>` : ''}
          ${window.currentUser?.role !== 'guest' ? `<button class="action-btn" onclick="event.stopPropagation();editProject('${p.id}')" title="Edit">✏️</button>` : ''}
          ${window.currentUser?.role !== 'guest' ? `<button class="action-btn" onclick="event.stopPropagation();deleteProject('${p.id}')" title="Delete">🗑</button>` : ''}
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
  // SSE chat_created may have already added it before the HTTP response returned — guard against duplicate
  if (!state.chats.find(c => c.id === chat.id)) {
    state.chats.unshift(chat);
  }
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
  closeSidebarMobile();
  // Save draft for the chat we're leaving
  const leavingChatId = state.currentChat?.id;
  if (leavingChatId && leavingChatId !== id) {
    const inputEl = document.getElementById('msg-input');
    const draftText = inputEl ? inputEl.value : '';
    if (draftText.trim()) {
      state.drafts[leavingChatId] = draftText;
    } else {
      delete state.drafts[leavingChatId];
    }
    localStorage.setItem('openclaw-drafts', JSON.stringify(state.drafts));
    // Clear the input immediately so it doesn't bleed into the new chat
    if (inputEl) { inputEl.value = ''; autoResize(inputEl); }
  }
  // Clear typing indicator from previous chat
  const typingEl = document.getElementById('typing-indicator');
  if (typingEl) typingEl.innerHTML = '';
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
  const titleWrap = document.getElementById('chat-title-wrap');
  if (titleWrap) titleWrap.style.cursor = 'pointer';
  // Bump sort order when user opens a chat
  api(`/api/chats/${state.currentChat.id}/touch`, 'POST').catch(() => {});
  // Update queue display for the newly-selected chat
  renderQueue();
  // Clear messages immediately — prevents stale content flashing before fetch completes
  document.getElementById('messages-area').innerHTML = '';
  await loadMessages();
  // Connect SSE stream for this chat (Phase 3)
  connectChatSSE(state.currentChat.id);
  // Sync agent status from server (so non-senders see correct thinking state)
  syncAgentStatus(state.currentChat.id);
  // Update collab UI (Phase 3)
  updateCollabUI();
  // Show/hide "+ New chat in [Project]" button
  updateProjectChatBtn();
  // Restore draft for this chat
  const msgInput = document.getElementById('msg-input');
  if (msgInput) {
    const savedDraft = state.drafts[id] || '';
    msgInput.value = savedDraft;
    autoResize(msgInput);
    msgInput.focus();
    // Position cursor at end of restored draft
    if (savedDraft) msgInput.setSelectionRange(savedDraft.length, savedDraft.length);
  }
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
  // Pre-compute: which ...thinking... messages have a real message after them?
  // Those are definitively stale regardless of poll state.
  const staleThinkingIds = new Set();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].content === '...thinking...') {
      // If any subsequent message exists (user or assistant with real content), it's stale
      const hasFollower = messages.slice(i + 1).some(m => m.content !== '...thinking...');
      if (hasFollower) staleThinkingIds.add(messages[i].id);
    }
  }
  let html = '';
  messages.forEach(msg => {
    html += renderMessage(msg, staleThinkingIds);
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

function renderMessage(msg, staleThinkingIds) {
  const isUser = msg.role === 'user';

  // Phase 4: system messages for approval flow
  if (msg.role === 'system') {
    const reqMatch = msg.content.match(/^\[APPROVAL_REQUEST:([^\]]+)\]$/);
    const resMatch = msg.content.match(/^\[APPROVAL_RESULT:([^:]+):(approved|denied)\]$/);
    const msgId = msg.id || ('sys-' + Math.random().toString(36).slice(2));

    if (reqMatch) {
      const approvalId = reqMatch[1];
      // Render placeholder, then async-fill it
      setTimeout(() => {
        const el = document.querySelector(`[data-sys-id="${msgId}"] .approval-placeholder`);
        if (el) renderApprovalCard(approvalId, el);
      }, 0);
      return `<div class="message system" data-id="${msg.id}" data-sys-id="${msgId}">
        <div class="avatar-col"><div class="message-avatar" style="font-size:18px">🔐</div></div>
        <div class="message-content"><div class="approval-placeholder"><div style="color:var(--text-muted);font-size:13px">Loading request...</div></div></div>
      </div>`;
    }

    if (resMatch) {
      const approvalId = resMatch[1];
      const status = resMatch[2];
      const cardClass = status === 'approved' ? 'approved' : 'denied';
      const badge = status === 'approved'
        ? `<div class="approval-status-badge approved">✅ Approved</div>`
        : `<div class="approval-status-badge denied">❌ Denied</div>`;
      // Async-load name
      setTimeout(() => {
        const el = document.querySelector(`[data-sys-id="${msgId}"] .approval-placeholder`);
        if (el) {
          api(`/api/approvals/${approvalId}`).then(approval => {
            el.innerHTML = `<div class="approval-card ${cardClass}" data-approval-id="${esc(approvalId)}">
              <div class="approval-card-title">🔐 Permission Request</div>
              <div class="approval-card-sub">${esc(approval.guest_display_name)} — <strong>${esc(approval.action_name)}</strong></div>
              ${badge}
            </div>`;
          }).catch(() => {
            el.innerHTML = `<div class="approval-card ${cardClass}">
              <div class="approval-card-title">🔐 Permission Request</div>
              ${badge}
            </div>`;
          });
        }
      }, 0);
      return `<div class="message system" data-id="${msg.id}" data-sys-id="${msgId}">
        <div class="avatar-col"><div class="message-avatar" style="font-size:18px">🔐</div></div>
        <div class="message-content"><div class="approval-placeholder"><div style="color:var(--text-muted);font-size:13px">Loading...</div></div></div>
      </div>`;
    }

    // Generic system message
    return `<div class="message system" data-id="${msg.id}">
      <div class="avatar-col"><div class="message-avatar" style="font-size:18px">ℹ️</div></div>
      <div class="message-content"><div class="message-bubble" style="font-size:13px;color:var(--text-muted)">${esc(msg.content)}</div></div>
    </div>`;
  }

  // In collaborative chats, show the sender's initial instead of generic 'A'
  const senderInitial = msg.display_name ? msg.display_name.charAt(0).toUpperCase() : 'A';
  const avatar = isUser ? senderInitial : '🤖';
  const avatarColor = isUser && msg.display_name ? getAvatarColor(msg.display_name) : null;
  const thinking = msg.content === '...thinking...';

  let content = '';
  if (thinking) {
    // A ...thinking... message is definitively stale if a real message follows it
    // (pre-computed by renderMessages to avoid DOM query per message)
    const definitelyStale = staleThinkingIds instanceof Set && staleThinkingIds.has(msg.id);

    // Show live thinking animation if NOT definitively stale AND:
    // - we have a local pending poll for this message, OR
    // - the server reports the agent is busy working on this specific message
    const chatPoll = !definitelyStale && Object.values(state.pendingPolls).find(p => p.aiMsgId === msg.id);
    const chatId = state.currentChat?.id;
    const serverActiveForThisMsg = !definitelyStale && chatId && state.chatThinkingMsgId[chatId] === msg.id;
    const isActivePoll = !definitelyStale && (!!chatPoll || serverActiveForThisMsg);
    if (isActivePoll) {
      const thinkingText = THINKING_MSGS[thinkingMsgIdx] || 'Working on it…';
      content = `<div class="message-bubble thinking"><span class="spinner"></span> <span class="thinking-label">${thinkingText}</span></div>`;
    } else {
      // Stale thinking message — response was lost (server restart, error, etc.)
      content = `<div class="message-bubble thinking-stale"><span style="opacity:0.5">⚠️</span> <span style="opacity:0.7;font-size:13px">Response was lost. Please try again.</span></div>`;
    }
  } else {
    const rendered = isUser ? esc(msg.content).replace(/\n/g, '<br>') : renderMarkdown(msg.content);
    const dirAttr = containsArabic(msg.content) ? ' dir="rtl"' : '';
    content = `<div class="message-bubble"${dirAttr}>${rendered}</div>`;
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

  const actionsHTML = !thinking
    ? `<div class="message-actions">
        <button class="msg-action-btn" onclick="copyMsgContent(this)" data-content="${esc(msg.content)}" title="Copy message">Copy</button>
        ${isUser ? `<button class="msg-action-btn" onclick="retryMsg(this)" data-content="${esc(msg.content)}" title="Retry this message">↺ Retry</button>` : ''}
       </div>`
    : '';

  // Show sender label in collaborative chats (when display_name present and not current user)
  const senderLabel = (isUser && msg.display_name && msg.display_name !== window.currentUser?.display_name)
    ? `<div class="message-sender-label">${esc(msg.display_name)}</div>` : '';
  const avatarStyle = avatarColor ? ` style="background:${avatarColor}"` : '';

  // Name shown under avatar: use display_name for user messages
  const avatarName = isUser ? (msg.display_name || window.currentUser?.display_name || '') : '';
  const avatarNameHTML = avatarName ? `<div class="avatar-name">${esc(avatarName)}</div>` : '';

  return `<div class="message ${msg.role}" data-id="${msg.id}">
    <div class="avatar-col">
      <div class="message-avatar coloured"${avatarStyle}>${avatar}</div>
      ${avatarNameHTML}
    </div>
    <div class="message-content">${senderLabel}${atts}${content}${actionsHTML}${tsHTML}</div>
  </div>`;
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined') return esc(text).replace(/\n/g, '<br>');
  try { return marked.parse(text); } catch { return esc(text).replace(/\n/g, '<br>'); }
}

function containsArabic(text) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text || '');
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

  // Clear draft on send
  delete state.drafts[chatId];
  localStorage.setItem('openclaw-drafts', JSON.stringify(state.drafts));

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
  state.chatThinkingMsgId[chatId] = aiMsgId; // track which message is in-flight
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
  // Watchdog: if SSE misses the busy=false event, recover after 150s
  const watchdog = setTimeout(async function tickWatchdog() {
    const p = state.pendingPolls[chatId];
    if (!p || p.aiMsgId !== aiMsgId) return; // already cleared
    try {
      const msg = await api(`/api/messages/${aiMsgId}`);
      if (msg && msg.content !== '...thinking...' && msg.content !== '') {
        // Response already written — SSE missed the done signal
        clearPollInterval(chatId);
        playDing();
        stopThinkingCycle();
        const isViewing = state.currentChat?.id === chatId;
        const chatTitle = state.chats.find(c => c.id === chatId)?.title || 'Chat';
        showCompletionToast(isViewing ? '✓ Replied' : `✓ Reply ready in "${chatTitle}"`);
        if (isViewing) { await loadMessages(); scrollToBottom(); }
        else { markChatReplied(chatId); }
        return;
      }
    } catch {}
    // Still thinking — extend by 30s and check again
    const pp = state.pendingPolls[chatId];
    if (pp && pp.aiMsgId === aiMsgId) pp.watchdog = setTimeout(tickWatchdog, 30000);
  }, 150000);
  state.pendingPolls[chatId] = { aiMsgId, interval, watchdog };
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
      // Watchdog: cancel pending recovery timer
      if (p.watchdog) clearTimeout(p.watchdog);
      delete state.pendingPolls[chatId];
      state.chatThinkingMsgId[chatId] = null; // clear in-flight tracking
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

function sendFollowUp() {
  const input = document.getElementById('msg-input');
  input.value = 'Done? if yes, resend last message';
  autoResize(input);
  sendMessage();
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
  // Fire typing ping for collaborative chats (Phase 3)
  if (state.currentChat) pingTyping(state.currentChat.id);
}

function autoResize(el) {
  el.style.height = 'auto';
  // Cap lower on narrow/mobile screens
  const maxH = window.innerWidth < 768 ? 100 : 150;
  el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
}

// === Per-chat draft persistence ===
// Wires up a live input listener on #msg-input so the current draft is always saved
(function setupDraftListener() {
  let _draftSaveTimer = null;
  document.addEventListener('DOMContentLoaded', () => {
    const inputEl = document.getElementById('msg-input');
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      const chatId = state.currentChat?.id;
      if (!chatId) return;
      const text = inputEl.value;
      if (text.trim()) {
        state.drafts[chatId] = text;
      } else {
        delete state.drafts[chatId];
      }
      // Debounce localStorage write
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = setTimeout(() => {
        localStorage.setItem('openclaw-drafts', JSON.stringify(state.drafts));
        renderSidebar(); // update draft badges
      }, 300);
    });
  });
})();

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

  const isAdminOrAccord = window.currentUser?.role === 'admin' || window.currentUser?.role === 'accord';

  // Load files, links, chats (and members for admin/accord) in parallel
  let files = [], links = [], chats = [], members = [], allUsers = [];
  try {
    const base = [
      api(`/api/projects/${project.id}/files`),
      api(`/api/projects/${project.id}/links`),
      api(`/api/chats?project_id=${project.id}`),
    ];
    if (isAdminOrAccord) {
      base.push(api(`/api/projects/${project.id}/members`));
      base.push(api('/api/admin/users'));
    }
    const results = await Promise.all(base);
    [files, links, chats] = results;
    if (isAdminOrAccord) { members = results[3]; allUsers = results[4]; }
  } catch (e) {
    area.innerHTML = `<div class="project-page"><p style="color:var(--danger)">Failed to load project: ${esc(e.message)}</p></div>`;
    return;
  }

  const LINK_ICONS = { doc: '📝', sheet: '📊', slide: '📑', folder: '📁' };
  const LINK_LABELS = { doc: 'Google Doc', sheet: 'Google Sheet', slide: 'Google Slides', folder: 'Drive Folder' };

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

  const linksHTML = links.map(l => {
    const icon = LINK_ICONS[l.link_type] || '🔗';
    const label = LINK_LABELS[l.link_type] || 'Link';
    return `<div class="project-file-item" data-id="${l.id}">
      <span class="project-file-icon">${icon}</span>
      <a class="project-file-name project-link-name" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <span class="project-file-size" style="color:var(--text-muted)">${label}</span>
      <button class="action-btn" onclick="deleteProjectLink('${project.id}','${l.id}')" title="Remove">🗑</button>
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
          ${window.currentUser?.role !== 'guest' ? `<button class="modal-btn secondary" onclick="editProject('${project.id}')">✏️ Edit</button>` : ''}
          ${window.currentUser?.role !== 'guest' ? `<button class="modal-btn secondary" style="color:var(--danger)" onclick="deleteProjectFromPage('${project.id}')">🗑 Delete</button>` : ''}
        </div>
      </div>

      <div class="project-page-section">
        <div class="project-section-title">Instructions</div>
        <div class="project-instructions-text">${project.instructions ? esc(project.instructions).replace(/\n/g,'<br>') : '<span style="color:var(--text-muted)">No instructions set. Click Edit to add context for AI.</span>'}</div>
      </div>

      <div class="project-page-section">
        <div class="project-section-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>Links <span style="color:var(--text-muted);font-size:12px;font-weight:400">(Google Docs, Sheets, Slides, Drive folders)</span></span>
          <button class="modal-btn secondary" style="font-size:12px;padding:5px 10px" onclick="showAddLinkModal('${project.id}')">+ Add Link</button>
        </div>
        <div class="project-files-list" id="proj-links-${project.id}">
          ${linksHTML || '<div class="project-files-empty">No links yet</div>'}
        </div>
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

      ${isAdminOrAccord ? `
      <div class="project-page-section" id="proj-members-section-${project.id}">
        <div class="project-section-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>Members <span style="color:var(--text-muted);font-size:12px;font-weight:400">(who can access this project)</span></span>
          <button class="modal-btn primary" style="font-size:12px;padding:6px 12px" onclick="showInviteToProject('${project.id}')">+ Invite</button>
        </div>
        <div id="proj-members-list-${project.id}">
          ${renderMembersHTML(members, project.id)}
        </div>
        <div id="proj-invite-form-${project.id}" style="display:none;margin-top:12px;padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">Invite guest to this project</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <input class="modal-input" id="proj-invite-email-${project.id}" placeholder="Email address" type="email" style="margin:0"/>
            <input class="modal-input" id="proj-invite-name-${project.id}" placeholder="Display name (optional)" style="margin:0"/>
            <div style="display:flex;gap:8px">
              <select id="proj-invite-existing-${project.id}" style="flex:1;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">
                <option value="">-- Or add existing user --</option>
                ${allUsers.filter(u => !members.find(m => m.id === u.id)).map(u => `<option value="${u.id}">${esc(u.email)} (${u.role})</option>`).join('')}
              </select>
            </div>
            <div style="display:flex;gap:8px;margin-top:2px">
              <button class="modal-btn primary" style="flex:1" onclick="submitProjectInvite('${project.id}')">Send Invite</button>
              <button class="modal-btn secondary" onclick="hideInviteForm('${project.id}')">Cancel</button>
            </div>
            <div id="proj-invite-msg-${project.id}" style="font-size:12px;margin-top:2px"></div>
          </div>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

function renderMembersHTML(members, projectId) {
  if (!members || members.length === 0) {
    return '<div class="project-files-empty">No members assigned yet.</div>';
  }
  return members.map(m => `
    <div class="project-member-item" data-id="${m.id}">
      <span class="project-member-avatar">${esc((m.display_name||m.email)[0].toUpperCase())}</span>
      <span class="project-member-info">
        <span class="project-member-name">${esc(m.display_name || m.email)}</span>
        <span class="project-member-email">${esc(m.email)}</span>
      </span>
      <span class="role-badge ${m.role}">${m.role}</span>
      <button class="action-btn" style="color:var(--danger)" onclick="removeProjectMemberFromPage('${projectId}','${m.id}')" title="Remove">✕</button>
    </div>
  `).join('');
}

function showInviteToProject(projectId) {
  const form = document.getElementById(`proj-invite-form-${projectId}`);
  if (form) form.style.display = 'block';
  document.getElementById(`proj-invite-email-${projectId}`)?.focus();
}

function hideInviteForm(projectId) {
  const form = document.getElementById(`proj-invite-form-${projectId}`);
  if (form) form.style.display = 'none';
}

async function submitProjectInvite(projectId) {
  const msg = document.getElementById(`proj-invite-msg-${projectId}`);
  const emailEl = document.getElementById(`proj-invite-email-${projectId}`);
  const nameEl = document.getElementById(`proj-invite-name-${projectId}`);
  const existingEl = document.getElementById(`proj-invite-existing-${projectId}`);

  const existingUserId = existingEl?.value;
  const email = emailEl?.value?.trim();
  const displayName = nameEl?.value?.trim();

  msg.style.color = 'var(--text-muted)';
  msg.textContent = 'Saving...';

  try {
    if (existingUserId) {
      // Add existing user to project
      const res = await fetch('/api/admin/project-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, user_id: existingUserId })
      });
      const data = await res.json();
      if (!data.ok) { msg.style.color = 'var(--danger)'; msg.textContent = data.error || 'Error'; return; }
      msg.style.color = '#4ade80'; msg.textContent = '✓ Access granted';
    } else if (email) {
      // Invite new or existing user by email
      const res = await fetch(`/api/projects/${projectId}/invite-guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, display_name: displayName, role: 'guest' })
      });
      const data = await res.json();
      if (!data.ok) { msg.style.color = 'var(--danger)'; msg.textContent = data.error || 'Error'; return; }
      msg.style.color = '#4ade80';
      msg.textContent = data.isNew ? `✓ Invited ${email} — credentials emailed` : `✓ ${email} added to project`;
    } else {
      msg.style.color = 'var(--danger)'; msg.textContent = 'Enter an email or select an existing user';
      return;
    }

    // Refresh members list
    setTimeout(async () => {
      const updated = await api(`/api/projects/${projectId}/members`).catch(() => null);
      if (updated) {
        const listEl = document.getElementById(`proj-members-list-${projectId}`);
        if (listEl) listEl.innerHTML = renderMembersHTML(updated, projectId);
      }
      hideInviteForm(projectId);
      if (emailEl) emailEl.value = '';
      if (nameEl) nameEl.value = '';
      if (existingEl) existingEl.value = '';
    }, 1200);
  } catch (e) {
    msg.style.color = 'var(--danger)'; msg.textContent = e.message;
  }
}

async function removeProjectMemberFromPage(projectId, userId) {
  if (!confirm('Remove this member from the project?')) return;
  try {
    const res = await fetch(`/api/admin/project-access/${projectId}/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      const updated = await api(`/api/projects/${projectId}/members`).catch(() => []);
      const listEl = document.getElementById(`proj-members-list-${projectId}`);
      if (listEl) listEl.innerHTML = renderMembersHTML(updated, projectId);
    }
  } catch (e) { console.error('removeProjectMemberFromPage:', e.message); }
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

function detectLinkType(url) {
  if (/docs\.google\.com\/spreadsheets/.test(url)) return 'sheet';
  if (/docs\.google\.com\/presentation/.test(url)) return 'slide';
  if (/drive\.google\.com\/drive/.test(url)) return 'folder';
  if (/docs\.google\.com\/document/.test(url)) return 'doc';
  return 'doc';
}

function showAddLinkModal(projectId) {
  showModal(`
    <h3>Add Google Link</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Paste a Google Doc, Sheet, Slides, or Drive folder link. It will be included as context in every chat in this project.</p>
    <div style="margin-bottom:12px">
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">URL</label>
      <input id="add-link-url" type="url" placeholder="https://docs.google.com/..." style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:14px;outline:none" oninput="autoDetectLinkType(this.value)">
    </div>
    <div style="margin-bottom:12px">
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px">Name / Label</label>
      <input id="add-link-title" type="text" placeholder="e.g. Q2 Roadmap" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:14px;outline:none">
    </div>
    <div style="margin-bottom:20px">
      <label style="display:block;font-size:12px;color:var(--text-muted);margin-bottom:6px">Type</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label id="lt-doc" class="link-type-chip active" onclick="selectLinkType('doc')"><input type="radio" name="link_type" value="doc" checked style="display:none">📝 Doc</label>
        <label id="lt-sheet" class="link-type-chip" onclick="selectLinkType('sheet')"><input type="radio" name="link_type" value="sheet" style="display:none">📊 Sheet</label>
        <label id="lt-slide" class="link-type-chip" onclick="selectLinkType('slide')"><input type="radio" name="link_type" value="slide" style="display:none">📑 Slides</label>
        <label id="lt-folder" class="link-type-chip" onclick="selectLinkType('folder')"><input type="radio" name="link_type" value="folder" style="display:none">📁 Folder</label>
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="modal-btn secondary" onclick="closeModal()">Cancel</button>
      <button class="modal-btn primary" onclick="addProjectLink('${projectId}')">Add Link</button>
    </div>
  `);
}

function selectLinkType(type) {
  ['doc','sheet','slide','folder'].forEach(t => {
    const el = document.getElementById(`lt-${t}`);
    if (el) el.classList.toggle('active', t === type);
    const radio = el && el.querySelector('input[type=radio]');
    if (radio) radio.checked = (t === type);
  });
}

function autoDetectLinkType(url) {
  if (!url) return;
  const detected = detectLinkType(url);
  selectLinkType(detected);
}

async function addProjectLink(projectId) {
  const url = document.getElementById('add-link-url')?.value?.trim();
  const title = document.getElementById('add-link-title')?.value?.trim();
  const typeRadio = document.querySelector('input[name=link_type]:checked');
  const link_type = typeRadio ? typeRadio.value : 'doc';
  if (!url) { alert('Please enter a URL.'); return; }
  try {
    await api(`/api/projects/${projectId}/links`, 'POST', { url, title: title || url, link_type });
    closeModal();
    const project = state.projects.find(p => p.id === projectId);
    if (project) await renderProjectPage(project);
  } catch (e) {
    alert('Failed to add link: ' + e.message);
  }
}

async function deleteProjectLink(projectId, linkId) {
  if (!confirm('Remove this link from the project?')) return;
  await api(`/api/projects/${projectId}/links/${linkId}`, 'DELETE');
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
function renameCurrentChat() {
  if (!state.currentChat) return;
  renameChat(state.currentChat.id);
}

async function newChatInCurrentProject() {
  const projectId = state.currentChat?.project_id;
  if (!projectId) return;
  const proj = state.projects.find(p => p.id === projectId);
  const chat = await api('/api/chats', 'POST', { title: 'New Chat', project_id: projectId });
  state.chats = [chat, ...state.chats];
  renderSidebar();
  await openChat(chat.id);
}

function updateProjectChatBtn() {
  const btn = document.getElementById('new-project-chat-btn');
  if (!btn) return;
  const projectId = state.currentChat?.project_id;
  if (!projectId) { btn.style.display = 'none'; return; }
  const proj = state.projects.find(p => p.id === projectId);
  const projName = proj ? proj.name : 'project';
  const shortName = projName.length > 20 ? projName.slice(0, 18) + '…' : projName;
  btn.textContent = `＋ Chat in ${shortName}`;
  btn.title = `Start a new chat in "${projName}"`;
  // Show for all roles (guests can create chats within their accessible projects — server enforces access)
  btn.style.display = '';
}

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
  // Persist to server — preserve project_id and telegram_session_key to avoid nullifying them
  const existing = state.chats.find(c => c.id === id);
  const chat = await api(`/api/chats/${id}`, 'PUT', {
    title,
    project_id: existing?.project_id || null,
    telegram_session_key: existing?.telegram_session_key || null,
  });
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
  const coreOpen = document.getElementById('core-panel').classList.contains('open');
  document.getElementById('app').classList.toggle('panel-open', artifactOpen || skillsOpen || workflowsOpen || coreOpen);
}

// === Artifacts ===
function toggleArtifactPanel() {
  const panel = document.getElementById('artifact-panel');
  const willOpen = !panel.classList.contains('open');
  panel.classList.toggle('open');
  // Close other panels if opening artifact panel (avoid double-panel on smaller screens)
  if (willOpen) document.getElementById('skills-panel').classList.remove('open');
  if (willOpen) document.getElementById('workflows-panel').classList.remove('open');
  if (willOpen) document.getElementById('core-panel').classList.remove('open');
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

// === Phase 4: Approval helpers ===
// Track pending approvals this user submitted: Map<approvalId, { actionPayload }>
const pendingApprovals = new Map();

function insertAndSend(text) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  input.value = text;
  autoResize(input);
  sendMessage();
}

async function renderApprovalCard(approvalId, containerEl) {
  try {
    const approval = await api(`/api/approvals/${approvalId}`);
    const user = window.currentUser;
    const canDecide = (user?.role === 'admin') ||
      (user?.role === 'accord' && approval.requires_approval === 'accord');

    let statusHtml = '';
    let actionsHtml = '';

    if (approval.status === 'pending') {
      if (canDecide) {
        actionsHtml = `
          <div class="approval-card-actions">
            <button class="approval-btn-approve" onclick="approveAction('${approvalId}')">Approve</button>
            <button class="approval-btn-deny" onclick="denyAction('${approvalId}')">Deny</button>
          </div>`;
      } else {
        actionsHtml = `<div class="approval-status-badge pending">Awaiting approval...</div>`;
      }
    } else if (approval.status === 'approved') {
      statusHtml = ' approved';
      actionsHtml = `<div class="approval-status-badge approved">✅ Approved</div>`;
    } else {
      statusHtml = ' denied';
      actionsHtml = `<div class="approval-status-badge denied">❌ Denied</div>`;
    }

    containerEl.innerHTML = `
      <div class="approval-card${statusHtml}" data-approval-id="${esc(approvalId)}">
        <div class="approval-card-title">🔐 Permission Request</div>
        <div class="approval-card-sub">${esc(approval.guest_display_name)} wants to run <strong>${esc(approval.action_name)}</strong><br><span style="font-size:12px;color:var(--text-muted)">${esc(approval.permission)}</span></div>
        ${actionsHtml}
      </div>`;
  } catch (e) {
    containerEl.innerHTML = `<div class="approval-card"><div class="approval-card-title">🔐 Permission Request</div><div class="approval-card-sub" style="color:var(--text-muted)">Could not load approval details.</div></div>`;
  }
}

async function approveAction(approvalId) {
  try {
    await api(`/api/approvals/${approvalId}/approve`, 'POST');
  } catch (e) { showToast('Error: ' + e.message); }
}

async function denyAction(approvalId) {
  try {
    await api(`/api/approvals/${approvalId}/deny`, 'POST');
  } catch (e) { showToast('Error: ' + e.message); }
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
    const content = res.content;
    body.innerHTML = `
      ${renderMarkdown(content)}
      <div class="skills-viewer-footer">
        <button class="skills-use-btn" onclick="handleUseWorkflow(${JSON.stringify(workflowName)}, ${JSON.stringify(content)})">▶ Use Workflow</button>
      </div>`;
    body.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  } catch (e) {
    body.innerHTML = `<div style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

async function handleUseWorkflow(workflowName, workflowContent) {
  if (window.currentUser?.role === 'guest') {
    const chatId = state.currentChat?.id;
    if (!chatId) { showToast('Open a chat first'); return; }
    try {
      const res = await api(`/api/chats/${chatId}/request-action`, 'POST', {
        permission: 'run_workflows', actionName: workflowName, actionPayload: workflowContent
      });
      if (res.allowed) {
        insertAndSend(workflowContent);
      } else if (res.pending) {
        pendingApprovals.set(res.approvalId, { actionPayload: workflowContent });
        showToast('Approval requested. Waiting for an admin to review.');
      } else {
        showToast(res.message || 'You don\'t have permission to run this action.');
      }
    } catch (e) { showToast('Error: ' + e.message); }
  } else {
    insertAndSend(workflowContent);
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
  if (willOpen) document.getElementById('core-panel').classList.remove('open');
  if (willOpen && !skillsLoaded) loadSkills();
  updatePanelOpenClass();
}

function closeSkillsPanel() {
  document.getElementById('skills-panel').classList.remove('open');
  updatePanelOpenClass();
}


// === Core Files Panel ===
let coreLoaded = false;
let allCoreFiles = [];
let activeCoreFilePath = null;

function toggleCorePanel() {
  const panel = document.getElementById('core-panel');
  const willOpen = !panel.classList.contains('open');
  panel.classList.toggle('open');
  if (willOpen) document.getElementById('artifact-panel').classList.remove('open');
  if (willOpen) document.getElementById('workflows-panel').classList.remove('open');
  if (willOpen) document.getElementById('skills-panel').classList.remove('open');
  if (willOpen && !coreLoaded) loadCoreFiles();
  updatePanelOpenClass();
}

function closeCorePanel() {
  document.getElementById('core-panel').classList.remove('open');
  updatePanelOpenClass();
}

// --- Load core files from API ---
async function loadCoreFiles() {
  try {
    allCoreFiles = await api('/api/core');
    coreLoaded = true;
    renderCoreList(allCoreFiles);
  } catch (e) {
    document.getElementById('core-list').innerHTML =
      `<div class="skills-loading" style="color:var(--danger)">Failed to load core files: ${esc(e.message)}</div>`;
  }
}

// --- Render core files list ---
function renderCoreList(files) {
  const el = document.getElementById('core-list');
  if (!files.length) {
    el.innerHTML = '<div class="skills-loading">No core files found.</div>';
    return;
  }
  let html = '';
  files.forEach(item => {
    const active = activeCoreFilePath === item.path ? 'active' : '';
    html += `<div class="skill-item ${active}" data-core-path="${esc(item.path)}" data-core-name="${esc(item.name)}" onclick="handleCoreItemClick(this)">
      <div class="skill-item-name">${esc(item.name)}</div>
      ${item.desc ? `<div class="skill-item-desc">${esc(item.desc)}</div>` : ''}
    </div>`;
  });
  el.innerHTML = html;
}

// --- Handle click on a core list item (uses data-attrs to avoid quoting issues) ---
function handleCoreItemClick(el) {
  const filePath = el.dataset.corePath;
  const fileName = el.dataset.coreName;
  if (filePath && fileName) openCoreFile(filePath, fileName);
}

// --- Open a core file in viewer ---
async function openCoreFile(filePath, fileName) {
  activeCoreFilePath = filePath;
  renderCoreList(allCoreFiles); // refresh active state

  const viewer = document.getElementById('core-viewer');
  const body = document.getElementById('core-viewer-body');
  const nameEl = document.getElementById('core-viewer-name');

  document.getElementById('core-list').style.display = 'none';
  viewer.style.display = 'flex';
  nameEl.textContent = fileName;
  body.innerHTML = '<div class="skills-loading"><span class="spinner"></span> Loading...</div>';

  try {
    const res = await api(`/api/core/content?filePath=${encodeURIComponent(filePath)}`);
    const content = res.content || '';
    body.innerHTML = `<div class="skills-viewer-md">${marked.parse(content)}</div>`;
    if (window.hljs) body.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  } catch (e) {
    body.innerHTML = `<div class="skills-loading" style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

// --- Close viewer, back to list ---
function closeCoreViewer() {
  activeCoreFilePath = null;
  document.getElementById('core-viewer').style.display = 'none';
  document.getElementById('core-list').style.display = '';
  renderCoreList(allCoreFiles);
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
    const content = res.content;
    body.innerHTML = `
      ${renderMarkdown(content)}
      <div class="skills-viewer-footer">
        <button class="skills-use-btn" onclick="handleUseSkill(${JSON.stringify(skillName)}, ${JSON.stringify(content)})">▶ Use Skill</button>
      </div>`;
    body.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  } catch (e) {
    body.innerHTML = `<div style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

async function handleUseSkill(skillName, skillContent) {
  if (window.currentUser?.role === 'guest') {
    const chatId = state.currentChat?.id;
    if (!chatId) { showToast('Open a chat first'); return; }
    try {
      const res = await api(`/api/chats/${chatId}/request-action`, 'POST', {
        permission: 'run_skills', actionName: skillName, actionPayload: skillContent
      });
      if (res.allowed) {
        insertAndSend(skillContent);
      } else if (res.pending) {
        pendingApprovals.set(res.approvalId, { actionPayload: skillContent });
        showToast('Approval requested. Waiting for an admin to review.');
      } else {
        showToast(res.message || 'You don\'t have permission to run this action.');
      }
    } catch (e) { showToast('Error: ' + e.message); }
  } else {
    insertAndSend(skillContent);
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

// === Agent status sync (for non-sender users) ===
async function syncAgentStatus(chatId) {
  try {
    const status = await api(`/api/chats/${chatId}/agent-status`);
    state.chatAgentBusy[chatId] = !!status.busy;
    state.chatThinkingMsgId[chatId] = status.busy ? (status.thinkingMsgId || null) : null;
    state.chatSharedQueue[chatId] = status.queue || [];
    if (status.busy) {
      startThinkingCycle();
      // If there's no local poll but server says busy, register a synthetic poll
      // so hasPendingPoll returns true and the stop button shows
      if (!hasPendingPoll(chatId) && status.thinkingMsgId) {
        const interval = setInterval(async () => {
          if (!state.pendingPolls[chatId]) return;
          if (!state.chatAgentBusy[chatId]) {
            clearPollInterval(chatId);
            stopThinkingCycle();
            updateStopBtn(chatId);
            return;
          }
          // Check if the thinking msg has resolved
          try {
            const msg = await api(`/api/messages/${status.thinkingMsgId}`);
            if (msg.content !== '...thinking...' && msg.content !== '') {
              state.chatAgentBusy[chatId] = false;
              clearPollInterval(chatId);
              stopThinkingCycle();
              updateStopBtn(chatId);
              if (state.currentChat?.id === chatId) { await loadMessages(); scrollToBottom(); }
            }
          } catch {}
        }, 1500);
        state.pendingPolls[chatId] = { aiMsgId: status.thinkingMsgId, interval, synthetic: true };
        updateStopBtn(chatId);
      }
    }
    if (state.currentChat?.id === chatId) renderSharedQueue(chatId);
  } catch {}
}

// === Shared queue display (server-synced) ===
function renderSharedQueue(chatId) {
  // Only show if there are server-queued items AND no local queue items
  const serverQueue = state.chatSharedQueue[chatId] || [];
  const localQueue = getChatQueue(chatId);
  // Merge: local items are the "my" items, server items include all users
  // Deduplicate by id so local items don't appear twice
  const localIds = new Set(localQueue.map(i => i.id));
  const serverOnlyItems = serverQueue.filter(i => !localIds.has(i.id));
  if (serverOnlyItems.length > 0 || localQueue.length > 0) {
    renderQueue(); // re-render local queue which will also call renderSharedQueueSection
    renderSharedQueueSection(chatId, serverOnlyItems);
  } else {
    renderSharedQueueSection(chatId, []);
  }
}

function renderSharedQueueSection(chatId, items) {
  let container = document.getElementById('shared-queue-section');
  if (!container) {
    container = document.createElement('div');
    container.id = 'shared-queue-section';
    const inputArea = document.getElementById('input-area');
    if (inputArea) inputArea.prepend(container);
  }
  if (!items.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'block';
  let html = `<div class="queue-header"><span class="queue-title">⏳ Waiting (${items.length})</span></div>`;
  items.forEach((item, idx) => {
    const sender = item.senderName || 'User';
    const preview = item.preview || '';
    html += `<div class="queue-item">
      <span class="queue-idx">${idx + 1}</span>
      <span class="queue-item-sender" style="font-size:11px;opacity:0.6;margin-right:4px">${esc(sender)}:</span>
      <span class="queue-item-text">${esc(preview.length > 70 ? preview.slice(0, 70) + '\u2026' : preview)}</span>
    </div>`;
  });
  container.innerHTML = html;
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
    // Still render shared queue items from other users
    if (chatId) {
      const serverQueue = state.chatSharedQueue[chatId] || [];
      renderSharedQueueSection(chatId, serverQueue);
    }
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
  // Note: shared queue (other users) can only be cleared server-side; don't clear chatSharedQueue
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
  showEditButtonOnLastUserMsg();
}

// === Edit-after-stop ===

// After stopping, show a transient "Edit" button on the last user message.
// Only visible if the user stopped mid-generation (not on a completed reply).
let _stoppedChatId = null; // track which chat had a stop so we can clear on next send

function showEditButtonOnLastUserMsg() {
  const area = document.getElementById('messages-area');
  const userMsgs = area.querySelectorAll('.message.user[data-id]');
  if (!userMsgs.length) return;
  const lastUserMsg = userMsgs[userMsgs.length - 1];
  const msgId = lastUserMsg.getAttribute('data-id');

  // Don't add twice
  if (lastUserMsg.querySelector('.edit-after-stop-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'msg-action-btn edit-after-stop-btn';
  btn.textContent = '✏️ Edit';
  btn.title = 'Edit and resend this message';
  btn.onclick = () => {
    btn.remove();
    enterMessageEditMode(lastUserMsg, msgId);
  };

  // Inject after the message-content div
  const actionsEl = lastUserMsg.querySelector('.message-actions');
  if (actionsEl) {
    actionsEl.appendChild(btn);
  } else {
    const contentEl = lastUserMsg.querySelector('.message-content');
    if (contentEl) contentEl.appendChild(btn);
  }

  _stoppedChatId = state.currentChat?.id;
}

function clearEditAfterStopBtn() {
  document.querySelectorAll('.edit-after-stop-btn').forEach(el => el.remove());
  _stoppedChatId = null;
}

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
  // Toggle generating class on input row for clean mobile UI
  const inputRow = document.getElementById('input-row');
  if (inputRow) {
    if (active) {
      inputRow.classList.add('generating');
    } else {
      inputRow.classList.remove('generating');
      // Restore textarea to its natural size
      const msgInput = document.getElementById('msg-input');
      if (msgInput) autoResize(msgInput);
    }
  }
}

// ============================================================
// SELF-UPDATE
// ============================================================

async function checkForUpdates() {
  showToast('Checking for updates…', 3000);
  let data;
  try {
    const res = await fetch('/api/update/check');
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
  } catch (e) {
    showToast('Update check failed: ' + e.message, 4000);
    return;
  }

  if (!data.hasUpdate) {
    showToast(`You're on the latest version (${data.current})`, 4000);
    return;
  }

  const existing = document.getElementById('update-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'update-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9000';
  modal.innerHTML = `
    <div style="background:var(--bg-secondary,#1e1e1e);border:1px solid var(--border,#333);border-radius:12px;padding:28px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
      <h3 style="margin:0 0 16px;font-size:16px;font-weight:600">Update Available</h3>
      <div style="font-size:13px;color:var(--text-secondary,#aaa);margin-bottom:20px">
        <div style="margin-bottom:8px">Current: <strong style="color:var(--text-primary,#fff)">${data.current}</strong></div>
        <div style="margin-bottom:8px">Latest: <strong style="color:#6ee7b7">${data.latest}</strong></div>
        <div style="color:var(--text-muted,#666);font-style:italic;font-size:12px">${data.latestLabel || ''}</div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('update-modal').remove()" style="padding:8px 16px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;color:var(--text-primary,#fff);cursor:pointer;font-size:13px">Cancel</button>
        <button onclick="startUpdateFlow('${data.current}','${data.latest}')" style="padding:8px 16px;border-radius:6px;border:none;background:#6ee7b7;color:#000;cursor:pointer;font-size:13px;font-weight:600">Update Now</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

async function startUpdateFlow(currentVersion, latestVersion) {
  const modal = document.getElementById('update-modal');
  if (modal) modal.remove();

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const chatTitle = `WebUI Update ${hh}:${mm} ${dd}-${mo}-${yyyy}`;

  let projectId = (state.projects && state.projects.length) ? state.projects[0].id : null;

  let chat;
  try {
    chat = await api('/api/chats', 'POST', { title: chatTitle, project_id: projectId });
  } catch (e) {
    showToast('Failed to create update chat: ' + e.message, 4000);
    return;
  }

  state.chats.unshift(chat);
  renderSidebar();
  await openChat(chat.id);

  await new Promise(r => setTimeout(r, 400));

  const updateMessage = `Update antar-web to the latest version from GitHub. Current version: ${currentVersion}. Latest version: ${latestVersion}. Run the update using the update.sh script in the antar-web directory (~/openclaw-web/update.sh), then confirm the new version is live.`;

  const input = document.getElementById('message-input');
  if (input) {
    input.value = updateMessage;
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 100));
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.click();
  }
}

// ============================================================
// ADMIN PANEL
// ============================================================

let adminPanelState = {
  activeTab: 'users',
  users: [],
  projects: [],
  projectAccess: [],
  guestPermsUserId: null,
  guestPerms: [],
  expandedProjects: new Set(),
};

function showAdminPanel() {
  // Remove existing overlay if any
  const existing = document.getElementById('admin-panel-overlay');
  if (existing) existing.remove();

  const user = window.currentUser;
  const isAdmin = user && user.role === 'admin';

  const overlay = document.createElement('div');
  overlay.id = 'admin-panel-overlay';
  overlay.innerHTML = `
    <div class="admin-header">
      <h1>🛠 Admin Panel</h1>
      <span style="font-size:12px;color:var(--text-muted)">${user?.email || ''}</span>
      <button class="admin-close-btn" onclick="closeAdminPanel()">✕</button>
    </div>
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="users" onclick="switchAdminTab('users',this)">User Management</button>
      <button class="admin-tab" data-tab="perms" onclick="switchAdminTab('perms',this)">Guest Permissions</button>
      <button class="admin-tab" data-tab="access" onclick="switchAdminTab('access',this)">Project Access</button>
      <button class="admin-tab" data-tab="audit" onclick="switchAdminTab('audit',this)">Audit Log</button>
      ${isAdmin ? `<button class="admin-tab" data-tab="tech" onclick="switchAdminTab('tech',this)">Technical Settings</button>` : ''}
    </div>
    <div class="admin-body" id="admin-body">
      <div style="color:var(--text-muted);font-size:13px;padding:20px">Loading...</div>
    </div>
  `;
  document.body.appendChild(overlay);
  adminPanelState.activeTab = 'users';
  loadAdminTab('users');
}

function closeAdminPanel() {
  const el = document.getElementById('admin-panel-overlay');
  if (el) el.remove();
}

function switchAdminTab(tab, btn) {
  adminPanelState.activeTab = tab;
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadAdminTab(tab);
}

async function loadAdminTab(tab) {
  const body = document.getElementById('admin-body');
  if (!body) return;
  body.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:20px">Loading...</div>`;
  try {
    if (tab === 'users') await renderAdminUsers(body);
    else if (tab === 'perms') await renderAdminPerms(body);
    else if (tab === 'access') await renderAdminAccess(body);
    else if (tab === 'audit') await renderAdminAuditLog(body);
    else if (tab === 'tech') await renderAdminTech(body);
  } catch (e) {
    body.innerHTML = `<div class="admin-msg err">Error: ${esc(e.message)}</div>`;
  }
}

// ---- User Management ----
async function renderAdminUsers(body) {
  const users = await api('/api/admin/users');
  adminPanelState.users = users;
  body.innerHTML = `
    <div class="admin-toolbar">
      <div class="admin-section-title">Users (${users.length})</div>
      <button class="admin-btn primary" onclick="showInviteModal()">+ Invite User</button>
    </div>
    <table class="admin-table">
      <thead><tr>
        <th>Email</th><th>Display Name</th><th>Role</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td>${esc(u.email)}</td>
            <td>${esc(u.display_name)}</td>
            <td><span class="role-badge ${u.role}">${u.role}</span></td>
            <td><span class="status-badge ${u.active !== 0 ? 'active' : 'inactive'}">${u.active !== 0 ? 'Active' : 'Inactive'}</span></td>
            <td style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="admin-btn sm" onclick="showEditUserModal('${u.id}')">Edit</button>
              ${u.active !== 0
                ? `<button class="admin-btn sm danger" onclick="toggleUserActive('${u.id}',0)">Deactivate</button>`
                : `<button class="admin-btn sm" onclick="toggleUserActive('${u.id}',1)">Reactivate</button>`
              }
              ${window.currentUser?.role === 'admin' ? `<button class="admin-btn sm danger" onclick="deleteUser('${u.id}','${esc(u.email)}')">Delete</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function showInviteModal() {
  const isAdmin = window.currentUser?.role === 'admin';
  const modal = createAdminModal(`
    <h3>Invite New User</h3>
    <label>Email</label>
    <input type="email" id="invite-email" placeholder="user@example.com"/>
    <label>Display Name (optional)</label>
    <input type="text" id="invite-name" placeholder="Full name"/>
    <label>Role</label>
    <select id="invite-role">
      <option value="guest">Guest</option>
      <option value="accord">Accord</option>
      ${isAdmin ? '<option value="admin">Admin</option>' : ''}
    </select>
    <div id="invite-msg"></div>
    <div class="admin-modal-btns">
      <button class="admin-btn" onclick="closeAdminModal()">Cancel</button>
      <button class="admin-btn primary" onclick="doInviteUser()">Send Invite</button>
    </div>
  `);
}

async function doInviteUser() {
  const email = document.getElementById('invite-email')?.value?.trim();
  const name = document.getElementById('invite-name')?.value?.trim();
  const role = document.getElementById('invite-role')?.value;
  const msg = document.getElementById('invite-msg');
  if (!email) { showAdminMsg(msg, 'Email required', 'err'); return; }
  try {
    const res = await fetch('/api/admin/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role, display_name: name })
    });
    const data = await res.json();
    if (data.ok) {
      showAdminMsg(msg, `✓ Invited! Temp password: ${data.tempPassword}`, 'ok');
      setTimeout(() => { closeAdminModal(); loadAdminTab('users'); }, 3000);
    } else {
      showAdminMsg(msg, data.error || 'Error', 'err');
    }
  } catch (e) { showAdminMsg(msg, e.message, 'err'); }
}

function showEditUserModal(userId) {
  const user = adminPanelState.users.find(u => u.id === userId);
  if (!user) return;
  createAdminModal(`
    <h3>Edit User: ${esc(user.email)}</h3>
    <label>Display Name</label>
    <input type="text" id="edit-display-name" value="${esc(user.display_name)}"/>
    <label>Role</label>
    <select id="edit-role">
      <option value="guest" ${user.role === 'guest' ? 'selected' : ''}>Guest</option>
      <option value="accord" ${user.role === 'accord' ? 'selected' : ''}>Accord</option>
      <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
    </select>
    <div id="edit-user-msg"></div>
    <div class="admin-modal-btns">
      <button class="admin-btn" onclick="closeAdminModal()">Cancel</button>
      <button class="admin-btn primary" onclick="doEditUser('${userId}')">Save</button>
    </div>
  `);
}

async function doEditUser(userId) {
  const display_name = document.getElementById('edit-display-name')?.value?.trim();
  const role = document.getElementById('edit-role')?.value;
  const msg = document.getElementById('edit-user-msg');
  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name, role })
    });
    const data = await res.json();
    if (data.ok) {
      showAdminMsg(msg, '✓ Saved', 'ok');
      setTimeout(() => { closeAdminModal(); loadAdminTab('users'); }, 1000);
    } else {
      showAdminMsg(msg, data.error || 'Error', 'err');
    }
  } catch (e) { showAdminMsg(msg, e.message, 'err'); }
}

async function toggleUserActive(userId, active) {
  try {
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active })
    });
    loadAdminTab('users');
  } catch (e) { alert(e.message); }
}

async function deleteUser(userId, email) {
  if (!confirm(`Permanently delete user "${email}"?\n\nThis cannot be undone. All their project access, permissions, and session data will be removed.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      showToast(`User ${email} deleted.`);
      loadAdminTab('users');
    } else {
      alert(data.error || 'Failed to delete user.');
    }
  } catch (e) { alert(e.message); }
}

// ---- Guest Permissions ----
async function renderAdminPerms(body) {
  const users = adminPanelState.users.length ? adminPanelState.users : await api('/api/admin/users');
  adminPanelState.users = users;
  const guests = users.filter(u => u.role === 'guest');

  body.innerHTML = `
    <div class="admin-section-title">Guest Permissions</div>
    ${guests.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">No guest users found.</p>' : `
      <div style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:6px">Select Guest</label>
        <select id="guest-select" onchange="loadGuestPerms(this.value)" style="padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:13px;">
          <option value="">-- Select a guest --</option>
          ${guests.map(g => `<option value="${g.id}">${esc(g.email)}</option>`).join('')}
        </select>
      </div>
      <div id="guest-perms-panel" style="display:none">
        <div id="guest-perms-rows"></div>
        <div style="margin-top:16px;display:flex;align-items:center;gap:10px">
          <button class="admin-btn primary" onclick="saveGuestPerms()">Save Permissions</button>
          <div id="guest-perms-msg" style="font-size:13px"></div>
        </div>
      </div>
    `}
  `;
}

async function loadGuestPerms(userId) {
  if (!userId) {
    document.getElementById('guest-perms-panel').style.display = 'none';
    return;
  }
  adminPanelState.guestPermsUserId = userId;
  const perms = await api(`/api/admin/guest-permissions/${userId}`);
  adminPanelState.guestPerms = perms;

  const PERM_DEFS = [
    { key: 'run_workflows', label: 'Run Workflows' },
    { key: 'run_skills', label: 'Run Skills' },
    { key: 'run_mcps', label: 'Run MCPs' },
  ];

  const rowsEl = document.getElementById('guest-perms-rows');
  rowsEl.innerHTML = PERM_DEFS.map(def => {
    const existing = perms.find(p => p.permission === def.key);
    const enabled = !!existing;
    const approval = existing?.requires_approval || '';
    return `
      <div class="perm-row">
        <div class="perm-label">${def.label}</div>
        <div class="perm-enabled">
          <input type="checkbox" id="perm-${def.key}" ${enabled ? 'checked' : ''}
            onchange="document.getElementById('perm-approval-${def.key}').style.display=this.checked?'inline':'none'"/>
          <label for="perm-${def.key}" style="font-size:12px;cursor:pointer">Enabled</label>
        </div>
        <div class="perm-approval" id="perm-approval-${def.key}" style="display:${enabled ? 'inline' : 'none'}">
          <select id="perm-level-${def.key}">
            <option value="" ${!approval ? 'selected' : ''}>No approval needed</option>
            <option value="accord" ${approval === 'accord' ? 'selected' : ''}>Requires Accord approval</option>
            <option value="admin" ${approval === 'admin' ? 'selected' : ''}>Requires Admin approval</option>
          </select>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('guest-perms-panel').style.display = 'block';
}

async function saveGuestPerms() {
  const userId = adminPanelState.guestPermsUserId;
  const msg = document.getElementById('guest-perms-msg');
  if (!userId) return;
  const PERMS = ['run_workflows', 'run_skills', 'run_mcps'];
  const permissions = [];
  for (const key of PERMS) {
    const cb = document.getElementById(`perm-${key}`);
    if (cb && cb.checked) {
      const lvl = document.getElementById(`perm-level-${key}`)?.value || null;
      permissions.push({ permission: key, requires_approval: lvl || null });
    }
  }
  try {
    const res = await fetch(`/api/admin/guest-permissions/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions })
    });
    const data = await res.json();
    if (data.ok) { msg.className = 'admin-msg ok'; msg.textContent = '✓ Saved'; }
    else { msg.className = 'admin-msg err'; msg.textContent = data.error || 'Error'; }
  } catch (e) { msg.className = 'admin-msg err'; msg.textContent = e.message; }
}

// ---- Project Access ----
async function renderAdminAccess(body) {
  const [accessRows, allProjects, allUsers] = await Promise.all([
    api('/api/admin/project-access'),
    api('/api/projects'),
    api('/api/admin/users'),
  ]);
  adminPanelState.projectAccess = accessRows;
  adminPanelState.projects = allProjects;
  adminPanelState.users = allUsers;

  // Group access by project
  const byProject = {};
  for (const p of allProjects) byProject[p.id] = { project: p, members: [] };
  for (const row of accessRows) {
    if (byProject[row.project_id]) byProject[row.project_id].members.push(row);
  }

  body.innerHTML = `
    <div class="admin-toolbar">
      <div class="admin-section-title">Project Access</div>
    </div>
    <div id="project-access-list">
      ${Object.values(byProject).map(({ project: p, members }) => `
        <div class="project-access-group">
          <div class="project-access-header" onclick="toggleProjectAccessGroup('${p.id}')">
            <span>📁 ${esc(p.name)}</span>
            <span style="font-size:12px;color:var(--text-muted)">${members.length} member(s)</span>
          </div>
          <div class="project-access-body" id="pac-${p.id}" style="display:none">
            ${members.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;padding:6px 0">No members</div>' :
              members.map(m => `
                <div class="project-member-row">
                  <div class="project-member-email">${esc(m.email)}</div>
                  <div class="project-member-role"><span class="role-badge ${m.role}">${m.role}</span></div>
                  <button class="admin-btn sm danger" onclick="revokeProjectAccess('${p.id}','${m.user_id}')">Revoke</button>
                </div>
              `).join('')
            }
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
              <select id="add-user-${p.id}" style="flex:1;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;">
                <option value="">-- Add user --</option>
                ${allUsers.filter(u => !members.find(m => m.user_id === u.id))
                  .map(u => `<option value="${u.id}">${esc(u.email)} (${u.role})</option>`).join('')}
              </select>
              <button class="admin-btn sm primary" onclick="grantProjectAccess('${p.id}')">Grant</button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function toggleProjectAccessGroup(projectId) {
  const el = document.getElementById(`pac-${projectId}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function grantProjectAccess(projectId) {
  const sel = document.getElementById(`add-user-${projectId}`);
  const userId = sel?.value;
  if (!userId) return;
  try {
    const res = await fetch('/api/admin/project-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, user_id: userId })
    });
    const data = await res.json();
    if (data.ok) loadAdminTab('access');
    else alert(data.error || 'Error granting access');
  } catch (e) { alert(e.message); }
}

async function revokeProjectAccess(projectId, userId) {
  if (!confirm('Revoke this user\'s access?')) return;
  try {
    const res = await fetch(`/api/admin/project-access/${projectId}/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) loadAdminTab('access');
    else alert(data.error || 'Error revoking access');
  } catch (e) { alert(e.message); }
}

// ---- Audit Log ----
async function renderAdminAuditLog(body) {
  body.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:20px">Loading audit log...</div>`;
  try {
    const rows = await api('/api/admin/audit-log');
    const fmtTs = (ts) => {
      const d = new Date(ts);
      return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    };
    body.innerHTML = `
      <div class="admin-toolbar">
        <div class="admin-section-title">Audit Log (last 200 events)</div>
        <button class="admin-btn" onclick="loadAdminTab('audit')">↺ Refresh</button>
      </div>
      ${rows.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">No audit events yet.</p>' : `
      <div style="overflow-x:auto">
        <table class="admin-table audit-table">
          <thead><tr>
            <th>Timestamp</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td style="white-space:nowrap;font-size:11px">${esc(fmtTs(r.timestamp))}</td>
                <td style="font-size:12px">${esc(r.actor_email || r.actor_user_id || '–')}</td>
                <td><span class="audit-action-badge ${esc(r.action.replace('_','-'))}">${esc(r.action)}</span></td>
                <td style="font-size:12px">${esc(r.target || '–')}</td>
                <td style="font-size:11px;color:var(--text-muted)">${r.details ? esc(JSON.stringify(r.details)) : '–'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`}
    `;
  } catch (e) {
    body.innerHTML = `<div class="admin-msg err">Error loading audit log: ${esc(e.message)}</div>`;
  }
}

// ---- Technical Settings ----
async function renderAdminTech(body) {
  body.innerHTML = `
    <div class="admin-section-title">Technical Settings</div>
    <div id="pm2-status-section">
      <div style="color:var(--text-muted);font-size:13px">Loading PM2 status...</div>
    </div>
    <div style="margin:16px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="admin-btn primary" onclick="doPM2Restart()">⟳ Restart openclaw-web</button>
      <button class="admin-btn danger" onclick="doDeploy()">🚀 Deploy (git pull + restart)</button>
      <span id="version-badge" style="font-size:13px;color:var(--text-muted)">Loading...</span>
    </div>
    <div id="tech-msg" style="font-size:13px;margin-bottom:12px"></div>
    <div id="version-section" style="margin-bottom:16px">
      <div style="color:var(--text-muted);font-size:13px">Loading version...</div>
    </div>
  `;
  loadPM2Status();
  loadVersion();
}

async function loadPM2Status() {
  const section = document.getElementById('pm2-status-section');
  if (!section) return;
  try {
    const data = await api('/api/admin/pm2-status');
    if (!data.ok || !data.processes) {
      section.innerHTML = `<div class="admin-msg err">PM2 unavailable: ${esc(data.error || 'unknown')}</div>`;
      return;
    }
    section.innerHTML = data.processes.map(p => `
      <div class="pm2-card">
        <div class="pm2-status-dot ${p.pm2_env?.status || 'stopped'}"></div>
        <div>
          <div class="pm2-name">${esc(p.name)}</div>
          <div class="pm2-meta">
            PID: ${p.pid || '–'} | Status: ${p.pm2_env?.status || '?'} |
            Restarts: ${p.pm2_env?.restart_time ?? '?'} |
            CPU: ${p.monit?.cpu ?? '?'}% | Mem: ${Math.round((p.monit?.memory || 0) / 1024 / 1024)}MB
          </div>
        </div>
      </div>
    `).join('') || '<div style="color:var(--text-muted);font-size:13px">No PM2 processes found.</div>';
  } catch (e) {
    section.innerHTML = `<div class="admin-msg err">Error: ${esc(e.message)}</div>`;
  }
}

async function loadVersion() {
  const section = document.getElementById('version-section');
  const badge = document.getElementById('version-badge');
  if (!section) return;
  try {
    const data = await api('/api/admin/version');
    if (data.ok) {
      const dateStr = data.date ? new Date(data.date).toLocaleString() : '';
      // Inline badge: prefer friendly version label, fall back to short hash
      const badgeText = data.versionLabel || data.hash || 'unknown';
      if (badge) badge.textContent = badgeText;
      section.innerHTML = `
        <div style="font-size:13px;color:var(--text-muted);line-height:1.8">
          ${data.versionLabel ? `<div><strong style="color:var(--text-primary)">${esc(data.versionLabel)}</strong></div>` : ''}
          <div>
            <span style="font-family:monospace">${esc(data.hash)}</span>
            &nbsp;${esc(data.subject)}
          </div>
          ${dateStr ? `<div style="font-size:12px">${dateStr}</div>` : ''}
        </div>
      `;
    } else {
      if (badge) badge.textContent = 'unknown';
      section.innerHTML = `<div style="color:var(--text-muted);font-size:13px">Version unavailable</div>`;
    }
  } catch (e) {
    if (badge) badge.textContent = 'unavailable';
    section.innerHTML = `<div style="color:var(--text-muted);font-size:13px">Version unavailable</div>`;
  }
}

async function doPM2Restart() {
  const msg = document.getElementById('tech-msg');
  if (!confirm('Restart openclaw-web PM2 process?')) return;
  msg.className = 'admin-msg'; msg.textContent = 'Restarting...';
  try {
    const data = await fetch('/api/admin/pm2-restart', { method: 'POST' }).then(r => r.json());
    msg.className = 'admin-msg ok'; msg.textContent = data.ok ? '✓ Restarted' : `Error: ${data.error}`;
    setTimeout(loadPM2Status, 2000);
  } catch (e) { msg.className = 'admin-msg err'; msg.textContent = e.message; }
}

async function doDeploy() {
  const msg = document.getElementById('tech-msg');
  if (!confirm('This will git pull and restart the server. Continue?')) return;
  msg.className = 'admin-msg'; msg.textContent = 'Deploying...';
  try {
    const data = await fetch('/api/admin/deploy', { method: 'POST' }).then(r => r.json());
    if (data.ok) {
      msg.className = 'admin-msg ok'; msg.textContent = '✓ Deployed. Server restarting...';
      setTimeout(loadVersion, 3000);
    } else {
      msg.className = 'admin-msg err'; msg.textContent = `Error: ${data.error || data.stderr}`;
    }
  } catch (e) { msg.className = 'admin-msg err'; msg.textContent = e.message; }
}



// ---- Project Settings Modal ----
async function showProjectSettings(projectId) {
  const proj = state.projects.find(p => p.id === projectId);
  if (!proj) return;
  try {
    const { project, members } = await api(`/api/projects/${projectId}/settings`);
    const allUsers = await api('/api/admin/users');
    const nonMembers = allUsers.filter(u => !members.find(m => m.id === u.id));

    showModal(`
      <h3 style="margin:0 0 16px">⚙️ Project Settings: ${esc(project.name)}</h3>
      <div class="project-settings-section">
        <h4>Guardrails / Rules</h4>
        <textarea id="proj-guardrails" style="width:100%;min-height:100px;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:10px;font-size:13px;font-family:inherit;resize:vertical;">${esc(project.guardrails || '')}</textarea>
        <button class="modal-btn primary" onclick="saveProjectGuardrails('${projectId}')">Save Guardrails</button>
        <div id="guardrails-msg" style="margin-top:6px;font-size:13px"></div>
      </div>
      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border)"/>
      <div class="project-settings-section">
        <h4>Members</h4>
        <div id="proj-members-list">
          ${members.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:10px">No members assigned</div>' :
            members.map(m => `
              <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
                <span style="flex:1;font-size:13px">${esc(m.email)}</span>
                <span class="role-badge ${m.role}">${m.role}</span>
                <button class="modal-btn danger-sm" onclick="removeProjMember('${projectId}','${m.id}')">Remove</button>
              </div>
            `).join('')
          }
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <select id="proj-add-user" style="flex:1;padding:7px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;">
            <option value="">-- Add user --</option>
            ${nonMembers.map(u => `<option value="${u.id}">${esc(u.email)} (${u.role})</option>`).join('')}
          </select>
          <button class="modal-btn primary" onclick="addProjMember('${projectId}')">Add</button>
        </div>
        <div id="proj-member-msg" style="margin-top:6px;font-size:13px"></div>
      </div>
    `);
  } catch (e) {
    alert('Failed to load project settings: ' + e.message);
  }
}

async function saveProjectGuardrails(projectId) {
  const guardrails = document.getElementById('proj-guardrails')?.value || '';
  const msg = document.getElementById('guardrails-msg');
  try {
    const res = await fetch(`/api/projects/${projectId}/guardrails`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guardrails })
    });
    const data = await res.json();
    if (data.ok) { msg.style.color='#4ade80'; msg.textContent='✓ Saved'; }
    else { msg.style.color='#f87171'; msg.textContent = data.error || 'Error'; }
  } catch (e) { msg.style.color='#f87171'; msg.textContent = e.message; }
}

async function addProjMember(projectId) {
  const userId = document.getElementById('proj-add-user')?.value;
  const msg = document.getElementById('proj-member-msg');
  if (!userId) return;
  try {
    const res = await fetch('/api/admin/project-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, user_id: userId })
    });
    const data = await res.json();
    if (data.ok) { msg.style.color='#4ade80'; msg.textContent='✓ Added'; showProjectSettings(projectId); }
    else { msg.style.color='#f87171'; msg.textContent = data.error || 'Error'; }
  } catch (e) { msg.style.color='#f87171'; msg.textContent = e.message; }
}

async function removeProjMember(projectId, userId) {
  const msg = document.getElementById('proj-member-msg');
  try {
    const res = await fetch(`/api/admin/project-access/${projectId}/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) { showProjectSettings(projectId); }
    else { msg.style.color='#f87171'; msg.textContent = data.error || 'Error'; }
  } catch (e) { msg.style.color='#f87171'; msg.textContent = e.message; }
}

// ---- Admin Modal helpers ----
function createAdminModal(html) {
  const existing = document.getElementById('admin-modal-backdrop');
  if (existing) existing.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'admin-modal-backdrop';
  backdrop.className = 'admin-modal-backdrop';
  backdrop.onclick = (e) => { if (e.target === backdrop) closeAdminModal(); };
  const modal = document.createElement('div');
  modal.className = 'admin-modal';
  modal.innerHTML = html;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return modal;
}

function closeAdminModal() {
  const el = document.getElementById('admin-modal-backdrop');
  if (el) el.remove();
}

function showAdminMsg(el, text, type) {
  if (!el) return;
  el.className = `admin-msg ${type}`;
  el.textContent = text;
}

// =============================================================================
// PHASE 3 — Collaborative Chat
// =============================================================================

// --- Avatar colour palette (deterministic by name) ---
const AVATAR_COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];
function getAvatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

// --- SSE per-chat connection ---
// state.chatSSE: Map<chatId, EventSource>
if (!state.chatSSE) state.chatSSE = new Map();
// Throttle typing pings
const typingPingLastSent = new Map();

// SSE backoff state per chat: Map<chatId, { retries, timer }>
const sseBackoffState = new Map();

function connectChatSSE(chatId) {
  // Close any existing SSE for a different chat
  state.chatSSE.forEach((es, cid) => { if (cid !== chatId) { try { es.close(); } catch {} state.chatSSE.delete(cid); } });
  // Don't reconnect if already open for this chat
  if (state.chatSSE.has(chatId)) return;

  // Reset backoff if this is a fresh connection request (not a retry)
  if (!sseBackoffState.has(chatId)) sseBackoffState.set(chatId, { retries: 0 });

  const es = new EventSource(`/api/chats/${chatId}/stream`);
  state.chatSSE.set(chatId, es);

  // Dead-connection detector: track last heartbeat timestamp
  let lastHeartbeatAt = Date.now();
  const heartbeatWatchdog = setInterval(() => {
    if (state.chatSSE.get(chatId) !== es) { clearInterval(heartbeatWatchdog); return; } // stale
    if (Date.now() - lastHeartbeatAt > 35000) {
      // Missed 2+ heartbeats — connection is silently dead
      clearInterval(heartbeatWatchdog);
      try { es.close(); } catch {}
      state.chatSSE.delete(chatId);
      if (state.currentChat?.id === chatId) connectChatSSE(chatId);
    }
  }, 20000);

  es.onopen = () => {
    // Reset backoff and heartbeat clock on successful connection
    lastHeartbeatAt = Date.now();
    sseBackoffState.set(chatId, { retries: 0 });
    // Hide reconnecting indicator if shown
    const ind = document.getElementById('sse-reconnect-indicator');
    if (ind) ind.style.display = 'none';
  };

  es.addEventListener('heartbeat', () => {
    lastHeartbeatAt = Date.now();
  });

  es.addEventListener('message', async () => {
    // New message arrived — reload messages if we're viewing this chat
    if (state.currentChat?.id === chatId) {
      await loadMessages(); scrollToBottom();
    }
  });

  es.addEventListener('agent_status', async (e) => {
    try {
      const data = JSON.parse(e.data);
      state.chatAgentBusy[chatId] = !!data.busy;
      state.chatThinkingMsgId[chatId] = data.busy ? (data.thinkingMsgId || null) : null;
      if (data.busy) {
        if (state.currentChat?.id === chatId) startThinkingCycle();
      } else {
        // Only stop thinking cycle if we don't have a local poll running
        if (!hasPendingPoll(chatId)) {
          if (state.currentChat?.id === chatId) stopThinkingCycle();
        }
        // Clear synthetic poll if agent finished
        const p = state.pendingPolls[chatId];
        if (p && p.synthetic) clearPollInterval(chatId);
        if (state.currentChat?.id === chatId) {
          updateStopBtn(chatId);
          processNextQueueItem(chatId);
        }
      }
      // Re-render messages so thinking state updates correctly
      if (state.currentChat?.id === chatId) {
        await loadMessages(); scrollToBottom();
      }
    } catch {}
  });

  es.addEventListener('queue_update', (e) => {
    try {
      const data = JSON.parse(e.data);
      state.chatSharedQueue[chatId] = data.queue || [];
      if (state.currentChat?.id === chatId) renderSharedQueue(chatId);
    } catch {}
  });

  es.addEventListener('typing', (e) => {
    if (state.currentChat?.id !== chatId) return;
    try {
      const data = JSON.parse(e.data);
      renderTypingIndicator(data);
    } catch {}
  });

  es.addEventListener('participant_joined', async () => {
    if (state.currentChat?.id !== chatId) return;
    await refreshParticipants(chatId);
  });

  es.addEventListener('participant_left', async () => {
    if (state.currentChat?.id !== chatId) return;
    await refreshParticipants(chatId);
  });

  es.addEventListener('chat_closed', () => {
    if (state.currentChat?.id !== chatId) return;
    updateCollabUI();
  });

  // Phase 4: approval events
  es.addEventListener('approval_request', async () => {
    if (state.currentChat?.id !== chatId) return;
    await loadMessages(); scrollToBottom();
  });

  es.addEventListener('approval_decision', async (e) => {
    if (state.currentChat?.id !== chatId) return;
    try {
      const data = JSON.parse(e.data);
      const { approvalId, status, actionPayload, guestUserId } = data;

      // Refresh message display
      await loadMessages(); scrollToBottom();

      // If I'm the guest who requested and it was approved, auto-execute
      if (status === 'approved' && pendingApprovals.has(approvalId)) {
        const pending = pendingApprovals.get(approvalId);
        pendingApprovals.delete(approvalId);
        const payload = actionPayload || pending.actionPayload;
        if (payload) {
          showToast('\u2705 Approved! Running action...');
          setTimeout(() => insertAndSend(payload), 300);
        }
      } else if (status === 'denied' && pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        showToast('\u274c Your request was denied.');
      }
    } catch {}
  });

  es.onerror = () => {
    clearInterval(heartbeatWatchdog);
    try { es.close(); } catch {}
    state.chatSSE.delete(chatId);

    // Only retry if this is still the active chat
    if (state.currentChat?.id !== chatId) {
      sseBackoffState.delete(chatId);
      return;
    }

    const backoff = sseBackoffState.get(chatId) || { retries: 0 };
    const MAX_RETRIES = 10;
    if (backoff.retries >= MAX_RETRIES) {
      sseBackoffState.delete(chatId);
      // Show a permanent error indicator
      const ind = document.getElementById('sse-reconnect-indicator');
      if (ind) { ind.textContent = 'Connection lost. Reload to reconnect.'; ind.style.display = 'block'; }
      return;
    }

    const delayMs = Math.min(1000 * Math.pow(2, backoff.retries), 30000);
    backoff.retries++;
    sseBackoffState.set(chatId, backoff);

    // Show reconnecting indicator
    const ind = document.getElementById('sse-reconnect-indicator');
    if (ind) {
      const secs = Math.round(delayMs / 1000);
      ind.textContent = `Reconnecting in ${secs}s…`;
      ind.style.display = 'block';
    }

    setTimeout(() => {
      if (state.currentChat?.id === chatId) {
        connectChatSSE(chatId);
      } else {
        sseBackoffState.delete(chatId);
        const ind2 = document.getElementById('sse-reconnect-indicator');
        if (ind2) ind2.style.display = 'none';
      }
    }, delayMs);
  };
}

// --- Typing indicator ---
function renderTypingIndicator(data) {
  const el = document.getElementById('typing-indicator');
  if (!el) return;
  const names = (data.names || data.users || []).filter(n => n !== window.currentUser?.display_name);
  let text = '';
  if (names.length > 0) {
    const label = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    text = `<div class="typing-dots"><span></span><span></span><span></span></div> ${esc(label)} ${names.length === 1 ? 'is' : 'are'} typing…`;
  }
  el.innerHTML = text;
}

// --- Typing ping (throttled to every 2s) ---
function pingTyping(chatId) {
  const now = Date.now();
  const last = typingPingLastSent.get(chatId) || 0;
  if (now - last < 2000) return;
  typingPingLastSent.set(chatId, now);
  fetch(`/api/chats/${chatId}/typing`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
}

// --- Participants row ---
async function refreshParticipants(chatId) {
  try {
    const participants = await api(`/api/chats/${chatId}/participants`);
    renderParticipantsRow(participants, chatId);
  } catch {}
}

function renderParticipantsRow(participants, chatId) {
  const row = document.getElementById('participants-row');
  if (!row) return;
  if (!participants || participants.length === 0) { row.innerHTML = ''; return; }

  const isOwner = state.currentChat?.owner_id === window.currentUser?.id
    || window.currentUser?.role === 'admin'
    || window.currentUser?.role === 'accord';

  row.innerHTML = participants.map(p => {
    const initial = (p.display_name || '?').charAt(0).toUpperCase();
    const color = getAvatarColor(p.display_name || p.user_id);
    const name = esc(p.display_name || p.email || p.user_id);
    return `<div class="participant-avatar" style="background:${color}" title="${name}">${initial}</div>`;
  }).join('');
}

async function removeParticipant(chatId, userId) {
  try {
    await api(`/api/chats/${chatId}/participants/${userId}`, 'DELETE');
    await refreshParticipants(chatId);
    await renderInviteDropdown(chatId); // refresh dropdown state too
  } catch (e) { showToast('Failed to remove participant'); }
}

// --- Invite dropdown ---
let _inviteDropdownOpen = false;

async function toggleInviteDropdown() {
  const dd = document.getElementById('invite-dropdown');
  if (!dd || !state.currentChat) return;

  if (_inviteDropdownOpen) {
    dd.style.display = 'none';
    _inviteDropdownOpen = false;
    return;
  }

  dd.style.display = 'block';
  _inviteDropdownOpen = true;
  dd.innerHTML = '<div class="invite-dd-loading">Loading...</div>';
  await renderInviteDropdown(state.currentChat.id);
}

async function renderInviteDropdown(chatId) {
  const dd = document.getElementById('invite-dropdown');
  if (!dd) return;
  try {
    const users = await api(`/api/chats/${chatId}/all-users`);
    const currentUserId = window.currentUser?.id;

    dd.innerHTML = `
      <div class="invite-dd-header">Chat participants</div>
      ${users.map(u => {
        const initial = (u.display_name || '?').charAt(0).toUpperCase();
        const color = getAvatarColor(u.display_name || u.id);
        const name = esc(u.display_name || u.email);
        const email = esc(u.email);
        const isMe = u.id === currentUserId;
        const isParticipant = !!u.is_participant;
        const rowClass = 'invite-dd-row' + (isMe ? ' invite-dd-me' : '');
        const toggleBtn = isMe ? '' : `<button class="invite-dd-toggle ${isParticipant ? 'is-member' : ''}" data-chatid="${chatId}" data-uid="${u.id}" data-member="${isParticipant ? '1' : '0'}" onclick="event.stopPropagation(); toggleParticipant(this)">${isParticipant ? '✓' : '+'}</button>`;
        return `
          <div class="${rowClass}">
            <div class="invite-dd-avatar" style="background:${color}">${initial}</div>
            <div class="invite-dd-info">
              <div class="invite-dd-name">${name}${isMe ? ' <span class="invite-dd-you">(you)</span>' : ''}</div>
              <div class="invite-dd-email">${email}</div>
            </div>
            ${toggleBtn}
          </div>`;
      }).join('')}
    `;
  } catch (e) {
    dd.innerHTML = `<div class="invite-dd-loading">Error loading users</div>`;
  }
}

async function toggleParticipant(btn) {
  if (btn.disabled) return;
  const chatId = btn.dataset.chatid;
  const userId = btn.dataset.uid;
  const isMember = btn.dataset.member === '1';

  // Show spinner, lock button
  btn.disabled = true;
  const prevHTML = btn.innerHTML;
  btn.innerHTML = '<span class="invite-spinner"></span>';

  try {
    if (isMember) {
      await api(`/api/chats/${chatId}/participants/${userId}`, 'DELETE');
      btn.dataset.member = '0';
      btn.classList.remove('is-member');
      btn.innerHTML = '+';
      showToast('Removed from chat');
    } else {
      await api(`/api/chats/${chatId}/participants`, 'POST', { userId });
      btn.dataset.member = '1';
      btn.classList.add('is-member');
      btn.innerHTML = '✓';
      showToast('✓ Added to chat');
    }
    await refreshParticipants(chatId);
  } catch (e) {
    btn.innerHTML = prevHTML;
    if (isMember) btn.classList.add('is-member'); else btn.classList.remove('is-member');
    showToast('Failed: ' + (e.message || 'error'));
  } finally {
    btn.disabled = false;
  }
}

// Close invite dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!_inviteDropdownOpen) return;
  const wrap = document.getElementById('invite-dropdown-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('invite-dropdown').style.display = 'none';
    _inviteDropdownOpen = false;
  }
});

// Close user menu when clicking outside
document.addEventListener('click', (e) => {
  const dd = document.getElementById('user-menu-dropdown');
  if (!dd || dd.style.display === 'none') return;
  const wrap = document.getElementById('user-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    dd.style.display = 'none';
  }
});

// --- Collab button (invite) ---
async function updateCollabUI() {
  const wrap = document.getElementById('invite-dropdown-wrap');
  if (!wrap || !state.currentChat) { if (wrap) wrap.style.display = 'none'; return; }

  const chat = state.currentChat;
  const role = window.currentUser?.role;
  const isGuest = role === 'guest';
  const isOwner = !isGuest && (
    chat.owner_id === window.currentUser?.id
    || !chat.owner_id
    || role === 'admin'
    || role === 'accord'
  );

  // Guests never see the invite button
  wrap.style.display = isOwner ? '' : 'none';

  // Load participants and render avatars
  try {
    const participants = await api(`/api/chats/${chat.id}/participants`);
    renderParticipantsRow(participants, chat.id);
  } catch {}
}

// --- /join/:token handling ---
async function handleJoinRoute() {
  const m = window.location.pathname.match(/^\/join\/([^/]+)$/);
  if (!m) return false;
  const token = m[1];

  // Must be logged in
  if (!window.currentUser) {
    // Save token and redirect to login, then back
    sessionStorage.setItem('pendingJoinToken', token);
    return true; // caller should show login
  }

  try {
    const res = await api(`/api/join/${token}`, 'POST');
    if (res.ok) {
      showToast(`✓ Joined "${res.chatTitle || 'chat'}"`);
      history.replaceState({}, '', '/');
      await openChat(res.chatId);
    }
  } catch (e) {
    showToast('Could not join: ' + (e.message || 'Invalid or expired link'));
    history.replaceState({}, '', '/');
  }
  return true;
}

// --- Toast helper (reuse if exists, else create) ---
function showToast(msg) {
  let el = document.getElementById('phase3-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'phase3-toast';
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:13px;color:var(--text);z-index:9999;transition:opacity 0.3s;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// --- Hook into app init: check for pending join token after login ---
const _origInitApp = typeof initApp === 'function' ? initApp : null;
// Patch the router to handle /join/ routes
const _origRouteInitial = typeof routeInitial === 'function' ? routeInitial : null;

// After DOM is ready + user is loaded, check for join token
document.addEventListener('DOMContentLoaded', () => {
  // Check if there's a pending join token from a pre-login redirect
  const pendingToken = sessionStorage.getItem('pendingJoinToken');
  if (pendingToken) {
    sessionStorage.removeItem('pendingJoinToken');
    // Will be handled after login completes via handleJoinRoute
  }
});


// ============================================================
// PULL TO REFRESH (mobile)
// ============================================================
(function initPullToRefresh() {
  // Only run on touch devices
  if (!('ontouchstart' in window)) return;

  const THRESHOLD  = 60;   // px needed to trigger
  const MAX_VISUAL = 80;   // px max indicator drop

  // Shared indicator element (fixed, appears below top edge)
  let ptrEl = null;
  function getIndicator() {
    if (ptrEl) return ptrEl;
    ptrEl = document.createElement('div');
    ptrEl.id = 'ptr-indicator';
    ptrEl.innerHTML = '<div class="ptr-spinner"></div><span class="ptr-label">Release to refresh</span>';
    document.body.appendChild(ptrEl);
    return ptrEl;
  }

  function showIndicator(pull, triggered) {
    const el = getIndicator();
    el.style.transform = `translateY(${pull}px)`;
    el.style.opacity = Math.min(1, pull / THRESHOLD).toFixed(2);
    el.querySelector('.ptr-label').textContent = triggered ? 'Release to refresh' : 'Pull to refresh';
    el.querySelector('.ptr-spinner').style.transform = `rotate(${Math.min(1, pull / THRESHOLD) * 270}deg)`;
  }

  function hideIndicator() {
    const el = getIndicator();
    el.style.transition = 'transform 0.25s ease, opacity 0.2s ease';
    el.style.transform = 'translateY(0)';
    el.style.opacity = '0';
    setTimeout(() => { el.style.transition = ''; }, 260);
  }

  function setRefreshing() {
    const el = getIndicator();
    el.style.transition = 'transform 0.2s ease';
    el.style.transform = `translateY(${THRESHOLD}px)`;
    el.querySelector('.ptr-spinner').classList.add('ptr-spinning');
    el.querySelector('.ptr-label').textContent = 'Refreshing…';
    setTimeout(() => { el.style.transition = ''; }, 210);
  }

  function doneRefreshing() {
    const el = getIndicator();
    el.querySelector('.ptr-spinner').classList.remove('ptr-spinning');
    hideIndicator();
  }

  function attachPTR(scrollEl, onRefresh) {
    let startY = 0, pulling = false, refreshing = false;

    scrollEl.addEventListener('touchstart', e => {
      if (refreshing) return;
      if (scrollEl.scrollTop > 2) return; // only at top
      startY = e.touches[0].clientY;
      pulling = false; // will confirm on move
    }, { passive: true });

    scrollEl.addEventListener('touchmove', e => {
      if (refreshing) return;
      if (scrollEl.scrollTop > 2) { pulling = false; return; }
      const dy = e.touches[0].clientY - startY;
      if (dy < 4) return; // ignore upward/tiny
      pulling = true;
      const pull = Math.min(MAX_VISUAL, Math.sqrt(dy) * 5.5);
      showIndicator(pull, pull >= THRESHOLD);
    }, { passive: true });

    scrollEl.addEventListener('touchend', async e => {
      if (!pulling || refreshing) { pulling = false; return; }
      const dy = e.changedTouches[0].clientY - startY;
      const pull = Math.min(MAX_VISUAL, Math.sqrt(Math.max(0, dy)) * 5.5);
      pulling = false;

      if (pull >= THRESHOLD) {
        refreshing = true;
        setRefreshing();
        try { await onRefresh(); } catch {}
        await new Promise(r => setTimeout(r, 350));
        doneRefreshing();
        await new Promise(r => setTimeout(r, 260));
        refreshing = false;
      } else {
        hideIndicator();
      }
      startY = 0;
    }, { passive: true });
  }

  function attachWhenReady() {
    const messagesArea    = document.getElementById('messages-area');
    const sidebarContent  = document.getElementById('sidebar-content');
    if (!messagesArea || !sidebarContent) { setTimeout(attachWhenReady, 400); return; }

    // Ensure indicator exists
    getIndicator();

    // Messages: refresh current chat
    attachPTR(messagesArea, async () => {
      if (state.currentChat) { await loadMessages(); scrollToBottom(); }
    });

    // Sidebar: reload chat list
    attachPTR(sidebarContent, async () => {
      await loadSidebar();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachWhenReady);
  } else {
    attachWhenReady();
  }
})();
