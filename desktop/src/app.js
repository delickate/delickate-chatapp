'use strict';

const API_URL_KEY = 'pitbconnect.apiUrl';
const TOKEN_KEY = 'pitbconnect.authToken';
const USER_KEY = 'pitbconnect.currentUser';
const SOCKET_URL_KEY = 'pitbconnect.socketUrl';
const DEFAULT_API_URL = 'https://api.sanjakarobar.com/api';
const DEFAULT_SOCKET_URL = 'https://socket.sanjakarobar.com';
const REFRESH_INTERVAL = 5000;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'bmp', 'dib', 'tif', 'tiff', 'ico', 'avif', 'heic', 'heif',
  'pdf', 'txt', 'rtf', 'doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'odt',
  'ppt', 'pot', 'pps', 'pptx', 'pptm', 'ppsx', 'odp',
  'xls', 'xlt', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm', 'csv', 'ods', 'zip',
]);
const CACHED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
]);
const TYPING_TIMEOUT = 1400;
const EMOJI_OPTIONS = [
  ['😀', 'Grinning face'], ['😂', 'Face with tears of joy'], ['🥰', 'Smiling face with hearts'],
  ['😊', 'Smiling face'], ['😍', 'Heart eyes'], ['😎', 'Sunglasses face'], ['😭', 'Loudly crying face'],
  ['😮', 'Face with open mouth'], ['🤔', 'Thinking face'], ['😘', 'Face blowing a kiss'],
  ['😢', 'Crying face'], ['😡', 'Angry face'], ['👋', 'Waving hand'], ['👏', 'Clapping hands'],
  ['🙌', 'Raising hands'], ['🙏', 'Folded hands'], ['👍', 'Thumbs up'], ['👎', 'Thumbs down'],
  ['❤️', 'Red heart'], ['💕', 'Two hearts'], ['💯', 'Hundred points'], ['🎉', 'Party popper'],
  ['🔥', 'Fire'], ['✨', 'Sparkles'], ['✅', 'Check mark'], ['🌹', 'Rose'],
];
const app = document.querySelector('#app');

const state = {
  apiUrl: normalizeApiUrl(readStoredValue(API_URL_KEY, 'daylight.apiUrl') || DEFAULT_API_URL),
  socketUrl: readStoredValue(SOCKET_URL_KEY, 'daylight.socketUrl') || DEFAULT_SOCKET_URL,
  token: readStoredValue(TOKEN_KEY, 'daylight.authToken'),
  user: readStoredUser(),
  authMode: 'login',
  friends: [],
  requests: [],
  sidebarTool: null,
  friendSearchQuery: '',
  conversations: [],
  unreadCount: null,
  selectedConversationId: null,
  messages: [],
  selectedAttachment: null,
  attachmentPreviewUrl: null,
  cachedAttachments: new Map(),
  attachmentCachePending: new Set(),
  onlineFriendIds: new Set(),
  socketConnected: false,
  typingUserId: null,
  typingTimeout: null,
  localTyping: false,
  localTypingTimeout: null,
  localTypingPulse: null,
  activeRoomId: null,
  joinedRoomId: null,
  socketFriendSignature: null,
  refreshing: false,
  pollTimer: null,
  noticeTimer: null,
  lastRefreshError: '',
  appVersion: '',
  updateAvailableVersion: null,
  updateStatus: 'Checking for updates…',
  call: null,
  peerConnection: null,
  localStream: null,
  remoteStream: null,
  pendingIceCandidates: [],
  pendingCallSignals: [],
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

function normalizeApiUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function readStoredValue(key, legacyKey) {
  const value = localStorage.getItem(key);
  if (value !== null) return value;
  const legacyValue = localStorage.getItem(legacyKey);
  if (legacyValue !== null) {
    localStorage.setItem(key, legacyValue);
    localStorage.removeItem(legacyKey);
  }
  return legacyValue;
}

function readStoredUser() {
  try {
    return JSON.parse(readStoredValue(USER_KEY, 'daylight.currentUser') || 'null');
  } catch {
    return null;
  }
}

function updateCallButtons() {
  const available = Boolean(state.joinedRoomId &&
    String(state.joinedRoomId) === String(state.selectedConversationId));
  document.querySelectorAll('[data-action="call-audio"], [data-action="call-video"]')
    .forEach((button) => { button.disabled = !available; });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join('')
    .toUpperCase();
}

function colorClass(id) {
  return `alt-${Math.abs(Number(id) || 0) % 4}`;
}

function formattedTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function formattedDay(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

function showNotice(message, type = 'error') {
  let notice = document.querySelector('.notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'notice';
    notice.setAttribute('role', 'alert');
    document.body.append(notice);
  }
  notice.textContent = message;
  notice.classList.toggle('success', type === 'success');
  notice.hidden = false;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => {
    notice.hidden = true;
  }, 5000);
}

function apiErrorMessage(payload, status) {
  if (payload?.errors) {
    const firstError = Object.values(payload.errors).flat().find(Boolean);
    if (firstError) return firstError;
  }
  if (payload?.message) return payload.message;
  if (status === 401) return 'Your session expired. Please sign in again.';
  return `The request failed (${status}). Please try again.`;
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const isMultipart = options.body instanceof FormData;
  if (options.body !== undefined && !isMultipart) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;
  try {
    response = await fetch(`${state.apiUrl}${path}`, {
      ...options,
      headers,
      body: options.body === undefined || isMultipart ? options.body : JSON.stringify(options.body),
    });
  } catch {
    throw new Error(`Can't reach the API at ${state.apiUrl}. Check the backend and API address.`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) {
      clearSession();
      render();
    }
    throw new Error(apiErrorMessage(payload, response.status));
  }
  return payload;
}

async function downloadAttachment(message) {
  const conversation = selectedConversation();
  if (!conversation || !message?.attachment) return;

  const blob = await fetchAttachmentBlob(conversation.id, message.id);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attachment-${message.id}.${message.attachment.name.split('.').pop()}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchAttachmentBlob(conversationId, messageId) {
  let response;
  try {
    response = await fetch(
      `${state.apiUrl}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachment`,
      { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${state.token}` } },
    );
  } catch {
    throw new Error(`Can't reach the API at ${state.apiUrl}. Check the backend and API address.`);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && state.token) {
      clearSession();
      render();
    }
    throw new Error(apiErrorMessage(payload, response.status));
  }

  return response.blob();
}

function attachmentCacheKey(conversationId, messageId) {
  return `${conversationId}:${messageId}`;
}

async function cacheImageAttachment(conversationId, message) {
  const attachment = message.attachment;
  if (!attachment || !CACHED_IMAGE_TYPES.has(attachment.mime)) return;

  const key = attachmentCacheKey(conversationId, message.id);
  if (state.cachedAttachments.has(key) || state.attachmentCachePending.has(key)) return;
  state.attachmentCachePending.add(key);

  try {
    const cacheDetails = {
      userId: state.user.id,
      conversationId,
      messageId: message.id,
      mime: attachment.mime,
    };
    let dataUrl = await window.localAttachments.readImage(cacheDetails);
    if (!dataUrl) {
      const blob = await fetchAttachmentBlob(conversationId, message.id);
      if (blob.size > MAX_ATTACHMENT_SIZE || blob.type !== attachment.mime) {
        throw new Error(`The image "${attachment.name}" could not be verified.`);
      }
      dataUrl = await window.localAttachments.saveImage({
        ...cacheDetails,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    state.cachedAttachments.set(key, dataUrl);
    if (String(state.selectedConversationId) === String(conversationId)) {
      renderMessages();
    }
  } finally {
    state.attachmentCachePending.delete(key);
  }
}

async function cacheMessageImages(conversationId, messages) {
  const images = messages.filter((message) =>
    message.attachment && CACHED_IMAGE_TYPES.has(message.attachment.mime));
  const results = await Promise.allSettled(
    images.map((message) => cacheImageAttachment(conversationId, message)),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    showNotice(`The image could not be saved to this device: ${failed.reason.message}`);
  }
}

function clearSession() {
  window.chatSocket?.disconnect().catch(() => {});
  cleanupCall();
  state.token = null;
  state.user = null;
  state.friends = [];
  state.requests = [];
  state.conversations = [];
  state.unreadCount = null;
  window.desktopApp?.setUnreadCount(0, false);
  state.messages = [];
  state.selectedAttachment = null;
  clearAttachmentPreview();
  state.cachedAttachments.clear();
  state.attachmentCachePending.clear();
  state.selectedConversationId = null;
  state.onlineFriendIds.clear();
  state.socketConnected = false;
  state.typingUserId = null;
  state.activeRoomId = null;
  state.joinedRoomId = null;
  state.socketFriendSignature = null;
  stopLocalTyping();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  stopPolling();
}

function persistSession(payload) {
  if (!payload?.token || !payload?.user) {
    throw new Error('The API response did not include a user and token.');
  }
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem(TOKEN_KEY, payload.token);
  localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
}

function showAuth() {
  const isSignup = state.authMode === 'signup';
  app.innerHTML = `
    <section class="auth-screen">
      <div class="auth-card">
        <aside class="auth-aside">
          <div class="brand-lockup"><span class="brand-mark">P</span><span>PITBConnect</span></div>
          <div class="aside-copy">
            <h1>Good conversations start here.</h1>
            <p>A quieter place to catch up with your people, one message at a time.</p>
          </div>
          <div class="aside-note">Your conversations, all in one place.</div>
        </aside>
        <section class="auth-content">
          <h2>${isSignup ? 'Create your account' : 'Welcome back'}</h2>
          <p class="auth-lede">${isSignup ? 'A few details and you’re ready to connect.' : 'Sign in to pick up where you left off.'}</p>
          <form id="auth-form" class="form-grid">
            ${isSignup ? `
              <div class="field"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" maxlength="120" placeholder="Your name" required /></div>
            ` : ''}
            <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" placeholder="+15551234567" title="Use international format, for example +15551234567" required /></div>
            ${isSignup ? `
              <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required /></div>
              <div class="field"><label for="dob">Date of birth</label><input id="dob" name="dob" type="date" max="${new Date().toISOString().slice(0, 10)}" required /></div>
            ` : ''}
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="${isSignup ? 8 : 1}" maxlength="128" placeholder="${isSignup ? 'At least 8 characters' : 'Your password'}" required /></div>
            <button class="primary-button auth-submit" type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
          </form>
          <p class="switch-auth">
            ${isSignup ? 'Already have an account?' : 'New to PITBConnect?'}
            <button class="text-button" type="button" data-action="toggle-auth">${isSignup ? 'Sign in' : 'Create account'}</button>
          </p>
          <details class="api-settings">
            <summary>API connection settings</summary>
            <form id="api-settings-form">
              <label class="settings-field">Laravel API URL<input name="apiUrl" type="url" value="${escapeHtml(state.apiUrl)}" required /></label>
              <label class="settings-field">Socket.IO URL<input name="socketUrl" type="url" value="${escapeHtml(state.socketUrl)}" required /></label>
              <button class="small-button" type="submit">Save</button>
            </form>
            <div>API URL ends with <code>/api</code>; socket URL is the server origin.</div>
          </details>
          ${updateControls()}
        </section>
      </div>
    </section>`;
}

function updateControls() {
  return `
    <div class="update-controls">
      <span class="app-version" id="app-version">${state.appVersion ? `PITBConnect v${escapeHtml(state.appVersion)}` : 'PITBConnect'}</span>
      <div class="update-actions">
        <button class="small-button" type="button" data-action="check-updates">Check for updates</button>
        <button class="small-button update-download" type="button" data-action="download-update" ${state.updateAvailableVersion ? '' : 'hidden'}>Download v${escapeHtml(state.updateAvailableVersion || '')}</button>
      </div>
      <span class="update-status" id="update-status" role="status" aria-live="polite">${escapeHtml(state.updateStatus)}</span>
    </div>`;
}

function render() {
  if (!state.token || !state.user) {
    showAuth();
    return;
  }
  showChatShell();
}

function isOnline(userId) {
  return state.onlineFriendIds.has(String(userId));
}

function friendAvatar(user, size = 'sm', withPresence = false) {
  const avatar = `<span class="avatar ${size} ${colorClass(user?.id)}" aria-hidden="true">${escapeHtml(initials(user?.name))}</span>`;
  if (!withPresence) return avatar;
  const status = state.socketConnected && isOnline(user?.id) ? 'online' : 'offline';
  return `<span class="avatar-wrap">${avatar}<span class="presence-dot ${status}" aria-label="${status}"></span></span>`;
}

function selectedConversation() {
  return state.conversations.find((item) => String(item.id) === String(state.selectedConversationId)) || null;
}

function conversationForFriend(friendId) {
  return state.conversations.find((item) => String(item.friend?.id) === String(friendId)) || null;
}

function showChatShell() {
  app.innerHTML = `
    <div class="app-shell ${state.selectedConversationId ? 'chat-open' : ''}">
      <aside class="rail">
        <header class="rail-brand">
          <div class="brand-lockup"><span class="brand-mark">P</span><span>PITBConnect</span></div>
        </header>
        <nav class="rail-tools" aria-label="Friend list actions">
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="search" aria-label="Search friends" aria-expanded="false" title="Search friends"><span aria-hidden="true">⌕</span><span>Search</span></button>
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="add" aria-label="Add a friend" aria-expanded="false" title="Add a friend"><span aria-hidden="true">＋</span><span>Add</span></button>
          <button class="rail-tool request-tool" type="button" data-action="toggle-sidebar-tool" data-tool="requests" aria-label="Friend requests" aria-expanded="false" title="Friend requests"><span aria-hidden="true">✉</span><span>Requests</span><span class="tool-badge" id="request-count" hidden></span></button>
          <button class="rail-tool" type="button" data-action="refresh" aria-label="Refresh friends and messages" title="Refresh"><span aria-hidden="true">↻</span><span>Sync</span></button>
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="updates" aria-label="Check app updates" aria-expanded="false" title="App updates"><span aria-hidden="true">⋯</span><span>Updates</span></button>
        </nav>
        <div class="sidebar-tools" id="sidebar-tools" hidden></div>
        <div class="friend-list-heading"><h2>Friends</h2><span class="unread-total" id="unread-message-count" hidden></span></div>
        <div class="friend-list" id="friend-list"></div>
        <div class="profile">
          ${friendAvatar(state.user, 'sm')}
          <div class="person-info"><div class="person-name">${escapeHtml(state.user.name)}</div><div class="person-sub">${escapeHtml(state.user.phone)}</div></div>
          <button class="logout-button" type="button" data-action="logout">Sign out</button>
        </div>
      </aside>
      <section class="chat-panel" id="chat-panel"></section>
    </div>`;

  renderSidebar();
  renderThread();
  syncUnreadIndicators();
}

function renderSidebar() {
  const toolsPanel = document.querySelector('#sidebar-tools');
  const requestCount = document.querySelector('#request-count');
  const friendList = document.querySelector('#friend-list');
  if (!toolsPanel || !friendList || !requestCount) return;

  requestCount.textContent = state.requests.length ? String(state.requests.length) : '';
  requestCount.hidden = state.requests.length === 0;
  document.querySelectorAll('[data-action="toggle-sidebar-tool"]').forEach((button) => {
    const active = button.dataset.tool === state.sidebarTool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-expanded', String(active));
  });
  toolsPanel.hidden = !state.sidebarTool;
  toolsPanel.innerHTML = renderSidebarTool();
  renderFriendList();
}

function renderSidebarTool() {
  if (state.sidebarTool === 'search') {
    return `
      <label class="search-box friend-search"><span aria-hidden="true">⌕</span><input id="friend-search" type="search" value="${escapeHtml(state.friendSearchQuery)}" placeholder="Search friends or messages" aria-label="Search friends or messages" /></label>`;
  }
  if (state.sidebarTool === 'add') {
    return `
      <form class="add-friend" id="add-friend-form">
        <label class="tool-field-label" for="friend-phone">Add a friend by phone</label>
        <div class="add-friend-entry">
          <input id="friend-phone" name="phone" type="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" placeholder="+1 555 123 4567" aria-label="Friend's phone number" required />
          <button type="submit" title="Send friend request" aria-label="Send friend request">Send</button>
        </div>
      </form>`;
  }
  if (state.sidebarTool === 'requests') {
    return `
      <section class="tool-section" aria-label="Friend requests">
        <h2>Friend requests${state.requests.length ? ` (${state.requests.length})` : ''}</h2>
        <div class="request-list">${state.requests.length
          ? state.requests.map((request) => `
            <div class="request-row">
              ${friendAvatar(request.user)}
              <div class="request-info"><div class="person-name">${escapeHtml(request.user?.name)}</div><div class="person-sub">${escapeHtml(request.user?.phone)}</div></div>
              <div class="request-actions">
                <button type="button" data-action="respond-request" data-id="${escapeHtml(request.id)}" data-response="accept" title="Accept request" aria-label="Accept ${escapeHtml(request.user?.name)}">✓</button>
                <button type="button" class="reject" data-action="respond-request" data-id="${escapeHtml(request.id)}" data-response="reject" title="Reject request" aria-label="Reject ${escapeHtml(request.user?.name)}">×</button>
              </div>
            </div>`).join('')
          : '<div class="empty-list">No pending friend requests.</div>'}
        </div>
      </section>`;
  }
  if (state.sidebarTool === 'updates') return updateControls();
  return '';
}

function renderFriendList(filterValue = state.sidebarTool === 'search' ? state.friendSearchQuery : '') {
  const friendList = document.querySelector('#friend-list');
  if (!friendList) return;
  const filter = filterValue.trim().toLowerCase();
  const friends = state.friends.filter((friend) => {
    const conversation = conversationForFriend(friend.id);
    const preview = conversation?.last_message?.body ||
      conversation?.last_message?.attachment?.name || '';
    return !filter || `${friend.name || ''} ${preview}`.toLowerCase().includes(filter);
  });
  friendList.innerHTML = friends.length
    ? friends.map((friend) => {
      const conversation = conversationForFriend(friend.id);
      const unreadCount = Number(conversation?.unread_count) || 0;
      const lastMessage = conversation?.last_message;
      const preview = lastMessage?.body || lastMessage?.attachment?.name || 'Start a conversation';
      const messagePreview = lastMessage && String(lastMessage.sender?.id) === String(state.user.id)
        ? `You: ${preview}`
        : preview;
      return `
        <button class="friend-item ${String(selectedConversation()?.friend?.id) === String(friend.id) ? 'active' : ''} ${unreadCount ? 'has-unread' : ''}" type="button" data-action="open-friend" data-id="${escapeHtml(friend.id)}" aria-label="Chat with ${escapeHtml(friend.name)}${unreadCount ? `, ${unreadCount} unread messages` : ''}">
          ${friendAvatar(friend, 'sm', true)}
          <span class="person-info"><span class="person-name">${escapeHtml(friend.name)}</span><span class="conversation-preview">${escapeHtml(messagePreview)}</span></span>
          <span class="conversation-meta">${lastMessage ? formattedTime(lastMessage.created_at) : ''}
            ${unreadCount ? `<span class="counter">${escapeHtml(unreadCount)}</span>` : ''}
          </span>
        </button>`;
    }).join('')
    : state.friends.length
      ? '<div class="empty-list">No friends match your search.</div>'
      : '<div class="empty-list">Your accepted friends will appear here. Select Add to invite someone.</div>';
}

function renderThread() {
  const panel = document.querySelector('#chat-panel');
  if (!panel) return;
  const conversation = selectedConversation();
  if (!conversation) {
    panel.innerHTML = `
      <div class="chat-empty">
        <div class="empty-art" aria-hidden="true">✦</div>
        <h2>A little more connected.</h2>
        <p>Choose one of your friends to open a conversation. Your messages will appear here.</p>
      </div>`;
    return;
  }

  panel.innerHTML = `
    <header class="chat-header">
      <button class="icon-button back-to-friends" type="button" data-action="show-friends" title="Back to friends" aria-label="Back to friends">‹</button>
      ${friendAvatar(conversation.friend, 'lg', true)}
      <div class="chat-heading"><h2>${escapeHtml(conversation.friend?.name)}</h2><p id="chat-status">${presenceText(conversation.friend?.id)}</p></div>
      <div class="chat-actions">
        <button class="icon-button" type="button" data-action="call-audio" title="Start voice call" aria-label="Start voice call" ${state.joinedRoomId ? '' : 'disabled'}>☎</button>
        <button class="icon-button" type="button" data-action="call-video" title="Start video call" aria-label="Start video call" ${state.joinedRoomId ? '' : 'disabled'}>▣</button>
        <button class="icon-button" type="button" data-action="refresh" title="Refresh messages" aria-label="Refresh messages">↻</button>
      </div>
    </header>
    <div class="message-list" id="message-list"></div>
    <div class="composer-wrap">
      <div class="attachment-preview" id="attachment-preview" aria-live="polite" hidden></div>
      <form class="composer" id="message-form">
        <textarea class="compose-input" name="body" rows="1" maxlength="10000" placeholder="Write a message…" aria-label="Write a message"></textarea>
        <div class="emoji-picker" id="emoji-picker" role="group" aria-label="Choose an emoji" hidden>
          ${EMOJI_OPTIONS.map(([emoji, label]) => `
            <button type="button" class="emoji-option" data-action="insert-emoji" data-emoji="${emoji}" aria-label="${label}" title="${label}">${emoji}</button>
          `).join('')}
        </div>
        <button class="emoji-button" type="button" data-action="toggle-emoji-picker" aria-label="Add emoji" aria-expanded="false" aria-controls="emoji-picker" title="Add emoji">☺</button>
        <input id="attachment-input" type="file" accept="image/*,.pdf,.txt,.rtf,.doc,.dot,.docx,.docm,.dotx,.dotm,.odt,.ppt,.pot,.pps,.pptx,.pptm,.ppsx,.odp,.xls,.xlt,.xlsx,.xlsm,.xlsb,.xltx,.xltm,.csv,.ods,.zip" hidden>
        <button class="attach-button" type="button" data-action="choose-attachment" aria-label="Attach a file" title="Attach a file">＋</button>
        <button class="send-button" type="submit" aria-label="Send message">➤</button>
      </form>
      <p class="composer-hint" id="attachment-status" aria-live="polite">Press Enter to send · Shift + Enter for a new line. Images, documents, spreadsheets, and ZIP files · 5 MiB max.</p>
    </div>`;
  renderMessages();
}

function renderCallOverlay() {
  const overlay = document.querySelector('#call-overlay');
  if (!overlay) return;
  const call = state.call;
  if (!call) {
    overlay.innerHTML = '';
    overlay.hidden = true;
    return;
  }

  const incoming = call.direction === 'incoming' && call.phase === 'ringing';
  const video = call.mediaType === 'video';
  overlay.hidden = false;
  overlay.innerHTML = `
    <section class="call-card" role="dialog" aria-modal="true" aria-labelledby="call-title">
      <header class="call-card-header">
        <div>
          <h2 id="call-title">${escapeHtml(incoming ? 'Incoming call' : call.phase === 'ringing' ? 'Calling…' : 'In call')}</h2>
          <p>${escapeHtml(call.peerName)} · ${video ? 'Video call' : 'Voice call'}</p>
        </div>
        <span class="call-status">${escapeHtml(call.connectionStatus || (call.phase === 'active' ? 'Connected' : call.phase === 'connecting' ? 'Connecting…' : incoming ? 'Ringing' : 'Waiting'))}</span>
      </header>
      ${video ? `<div class="call-video-grid">
        <video id="call-remote-video" autoplay controls playsinline></video>
        <video id="call-local-video" autoplay muted playsinline></video>
      </div>` : '<div class="call-avatar" aria-hidden="true">☎</div><audio id="call-remote-audio" autoplay controls></audio>'}
      <footer class="call-controls">
        ${incoming
          ? `<button class="call-control accept" data-call-action="accept">Answer</button><button class="call-control hangup" data-call-action="reject">Decline</button>`
          : `<button class="call-control" data-call-action="mute">${call.muted ? 'Unmute' : 'Mute'}</button>
             ${video ? `<button class="call-control" data-call-action="camera">${call.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</button>` : ''}
             <button class="call-control hangup" data-call-action="hangup">${call.phase === 'ringing' ? 'Cancel' : 'End call'}</button>`}
      </footer>
    </section>`;

  const localVideo = overlay.querySelector('#call-local-video');
  if (localVideo && state.localStream) localVideo.srcObject = state.localStream;
  const remoteVideo = overlay.querySelector('#call-remote-video');
  if (remoteVideo && state.remoteStream) {
    remoteVideo.srcObject = state.remoteStream;
    playRemoteMedia(remoteVideo);
  }
  const remoteAudio = overlay.querySelector('#call-remote-audio');
  if (remoteAudio && state.remoteStream) {
    remoteAudio.srcObject = state.remoteStream;
    playRemoteMedia(remoteAudio);
  }
}

function playRemoteMedia(element) {
  element.play().catch((error) => {
    if (error.name === 'AbortError' || !state.call || state.call.playbackWarningShown) return;
    state.call.playbackWarningShown = true;
    showNotice('Incoming media could not start automatically. Press Play in the call controls to hear or see your friend.');
  });
}

function renderMessages() {
  const list = document.querySelector('#message-list');
  if (!list) return;
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (!state.messages.length) {
    list.innerHTML = '<div class="empty-list chat-empty">Say hello and start the conversation.</div>';
    return;
  }

  const orderedMessages = [...state.messages].reverse();
  let lastDay = '';
  list.innerHTML = orderedMessages.map((message) => {
    const isMine = String(message.sender?.id) === String(state.user.id);
    const day = formattedDay(message.created_at);
    let divider = '';
    if (day !== lastDay) {
      divider = `<div class="day-divider"><span>${escapeHtml(day)}</span></div>`;
      lastDay = day;
    }
    const receipt = isMine ? (message.read_at ? '✓✓ Seen' : message.delivered_at ? '✓✓ Delivered' : '✓ Sent') : '';
    const cacheKey = attachmentCacheKey(message.conversation_id, message.id);
    const imagePreview = message.attachment && CACHED_IMAGE_TYPES.has(message.attachment.mime)
      ? state.cachedAttachments.get(cacheKey)
      : null;
    return `${divider}
      <div class="message-row ${isMine ? 'mine' : ''}">
        ${isMine ? '' : friendAvatar(selectedConversation()?.friend, 'message-avatar')}
        <div class="message-bubble">
          ${message.body ? `<div class="message-text">${escapeHtml(message.body)}</div>` : ''}
          ${imagePreview ? `<img class="message-image" src="${escapeHtml(imagePreview)}" alt="${escapeHtml(message.attachment.name)}" loading="lazy" decoding="async">` : ''}
          ${message.attachment ? `<button class="attachment-download" type="button" data-action="download-attachment" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.attachment.name)} · ${formatFileSize(message.attachment.size)} · Download</button>` : ''}
          <div class="message-foot"><span>${formattedTime(message.created_at)}</span>${receipt ? `<span>${receipt}</span>` : ''}</div>
        </div>
      </div>`;
  }).join('');
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

function syncUnreadIndicators() {
  const unreadCount = state.conversations.reduce((total, conversation) => {
    const count = Number(conversation.unread_count);
    return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
  }, 0);
  const shouldNotify = state.unreadCount !== null && unreadCount > state.unreadCount;
  state.unreadCount = unreadCount;

  const unreadLabel = document.querySelector('#unread-message-count');
  if (unreadLabel) {
    unreadLabel.textContent = `${unreadCount} unread`;
    unreadLabel.hidden = unreadCount === 0;
  }
  document.title = unreadCount ? `(${unreadCount}) PITBConnect — Messages` : 'PITBConnect — Messages';
  window.desktopApp?.setUnreadCount(unreadCount, shouldNotify);
}

function formatFileSize(size) {
  const bytes = Number(size) || 0;
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadMessages({ markRead = true } = {}) {
  const conversation = selectedConversation();
  if (!conversation) {
    state.messages = [];
    return;
  }
  const payload = await api(`/conversations/${encodeURIComponent(conversation.id)}/messages`);
  state.messages = Array.isArray(payload.data) ? payload.data : [];
  if (markRead && document.hasFocus() && state.messages.some((message) =>
    String(message.sender?.id) !== String(state.user.id) && !message.read_at)) {
    await api(`/conversations/${encodeURIComponent(conversation.id)}/read`, { method: 'POST' });
    state.messages = await api(`/conversations/${encodeURIComponent(conversation.id)}/messages`)
      .then((result) => Array.isArray(result.data) ? result.data : []);
    conversation.unread_count = 0;
    renderSidebar();
    syncUnreadIndicators();
  }
  await cacheMessageImages(conversation.id, state.messages);
}

async function refreshData() {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  try {
    const [friends, requests, conversations] = await Promise.all([
      api('/friends'),
      api('/friends/requests?direction=incoming'),
      api('/conversations'),
    ]);
    state.friends = Array.isArray(friends.data) ? friends.data : [];
    state.requests = Array.isArray(requests.data) ? requests.data : [];
    state.conversations = Array.isArray(conversations.data) ? conversations.data : [];
    syncUnreadIndicators();
    const friendSignature = state.friends.map((friend) => friend.id).sort().join(',');
    if (state.socketFriendSignature !== null && state.socketFriendSignature !== friendSignature) {
      connectSocket();
    }
    state.socketFriendSignature = friendSignature;

    if (state.selectedConversationId && !state.conversations.some((item) =>
      String(item.id) === String(state.selectedConversationId))) {
      state.selectedConversationId = null;
      state.messages = [];
      renderThread();
    }
    renderSidebar();

    if (state.selectedConversationId) {
      await loadMessages();
      renderMessages();
    }
    state.lastRefreshError = '';
  } catch (error) {
    if (state.lastRefreshError !== error.message) showNotice(error.message);
    state.lastRefreshError = error.message;
  } finally {
    state.refreshing = false;
  }
}

function presenceText(userId) {
  if (!state.socketConnected) return 'Presence unavailable';
  if (String(state.typingUserId) === String(userId)) return 'Typing…';
  return isOnline(userId) ? 'Online' : 'Offline';
}

function updatePresenceViews() {
  renderSidebar();
  const conversation = selectedConversation();
  const status = document.querySelector('#chat-status');
  if (status && conversation) {
    status.textContent = presenceText(conversation.friend?.id);
    status.classList.toggle('typing', String(state.typingUserId) === String(conversation.friend?.id));
  }
}

function clearTypingIndicator() {
  clearTimeout(state.typingTimeout);
  state.typingTimeout = null;
  state.typingUserId = null;
  updatePresenceViews();
}

function sendCallEvent(event, payload) {
  return window.chatSocket?.sendCallEvent(event, payload).catch((error) => {
    showNotice(error.message || 'The call could not reach the realtime service.');
    return false;
  });
}

function updateCall(patch) {
  if (!state.call) return;
  state.call = { ...state.call, ...patch };
  renderCallOverlay();
}

function cleanupCall() {
  state.peerConnection?.close();
  state.peerConnection = null;
  for (const stream of [state.localStream, state.remoteStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  state.localStream = null;
  state.remoteStream = null;
  state.pendingIceCandidates = [];
  state.pendingCallSignals = [];
  state.call = null;
  renderCallOverlay();
}

function stopCall(message) {
  if (message) showNotice(message);
  cleanupCall();
}

async function startCall(mediaType) {
  const conversation = selectedConversation();
  if (!conversation || !state.joinedRoomId ||
    String(state.joinedRoomId) !== String(conversation.id) || !state.socketConnected) {
    showNotice('Wait for the realtime chat connection before starting a call.');
    return;
  }
  if (state.call) {
    showNotice('Finish the current call before starting another.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    showNotice('Audio and video calls are not supported by this device.');
    return;
  }

  const call = {
    id: crypto.randomUUID(),
    conversationId: Number(conversation.id),
    peerId: Number(conversation.friend?.id),
    peerName: conversation.friend?.name || 'Friend',
    mediaType,
    direction: 'outgoing',
    phase: 'ringing',
    muted: false,
    cameraEnabled: true,
    playbackWarningShown: false,
    connectionStatus: '',
  };
  state.call = call;
  renderCallOverlay();
  await sendCallEvent('call:invite', {
    call_id: call.id,
    conversation_id: call.conversationId,
    target_user_id: call.peerId,
    media_type: mediaType,
  });
}

async function createPeerConnection(call, initiator) {
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: call.mediaType === 'video',
  });
  if (state.call?.id !== call.id) {
    localStream.getTracks().forEach((track) => track.stop());
    return;
  }

  const peer = new RTCPeerConnection({
    iceServers: state.iceServers,
  });
  state.localStream = localStream;
  state.peerConnection = peer;
  for (const track of localStream.getTracks()) peer.addTrack(track, localStream);
  peer.onicecandidate = ({ candidate }) => {
    if (candidate && state.call?.id === call.id) {
      void sendCallEvent('call:signal', {
        call_id: call.id,
        signal: { candidate: candidate.toJSON() },
      });
    }
  };
  peer.ontrack = ({ streams, track }) => {
    if (streams[0]) {
      state.remoteStream = streams[0];
    } else {
      state.remoteStream ||= new MediaStream();
      if (!state.remoteStream.getTracks().some((item) => item.id === track.id)) {
        state.remoteStream.addTrack(track);
      }
    }
    renderCallOverlay();
  };
  peer.onconnectionstatechange = () => {
    if (state.call?.id !== call.id) return;
    if (peer.connectionState === 'connected') updateCall({ phase: 'active' });
    if (peer.connectionState === 'failed') {
      void sendCallEvent('call:end', { call_id: call.id });
      stopCall('The call could not connect. Check your network, then configure a TURN relay on the call server if either network blocks peer-to-peer connections.');
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (state.call?.id !== call.id) return;
    if (peer.iceConnectionState === 'checking') {
      updateCall({ phase: 'connecting', connectionStatus: 'Connecting media…' });
    } else if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
      updateCall({ phase: 'active', connectionStatus: '' });
    } else if (peer.iceConnectionState === 'disconnected') {
      updateCall({ connectionStatus: 'Reconnecting media…' });
    } else if (peer.iceConnectionState === 'failed') {
      void sendCallEvent('call:end', { call_id: call.id });
      stopCall('Video could not reach the other device. Configure a TURN relay on the call server and try again.');
    }
  };
  updateCall({ phase: 'connecting' });

  for (const signal of state.pendingCallSignals.splice(0)) {
    await handleCallSignal(call, signal);
  }

  if (initiator) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await sendCallEvent('call:signal', {
      call_id: call.id,
      signal: { description: peer.localDescription.toJSON() },
    });
  }
}

async function handleCallSignal(call, signal) {
  const peer = state.peerConnection;
  if (state.call?.id !== call.id || !peer) {
    if (state.call?.id === call.id) state.pendingCallSignals.push(signal);
    return;
  }

  if (signal?.candidate) {
    if (!peer.remoteDescription) {
      state.pendingIceCandidates.push(signal.candidate);
    } else {
      await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
    return;
  }

  const description = signal?.description;
  if (!description || !['offer', 'answer'].includes(description.type) ||
    typeof description.sdp !== 'string') return;
  await peer.setRemoteDescription(new RTCSessionDescription(description));
  for (const candidate of state.pendingIceCandidates.splice(0)) {
    await peer.addIceCandidate(new RTCIceCandidate(candidate));
  }
  if (description.type === 'offer') {
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await sendCallEvent('call:signal', {
      call_id: call.id,
      signal: { description: peer.localDescription.toJSON() },
    });
  }
}

async function answerCall() {
  const call = state.call;
  if (!call || call.direction !== 'incoming' || !state.socketConnected) return;
  await sendCallEvent('call:accept', { call_id: call.id });
  try {
    await createPeerConnection(call, false);
  } catch (error) {
    await sendCallEvent('call:end', { call_id: call.id });
    stopCall(`Could not access your microphone or camera: ${error.message}`);
  }
}

function rejectCall() {
  const call = state.call;
  if (!call) return;
  void sendCallEvent('call:reject', { call_id: call.id });
  cleanupCall();
}

function hangUpCall() {
  const call = state.call;
  if (!call) return;
  void sendCallEvent(call.phase === 'ringing' ? 'call:cancel' : 'call:end', { call_id: call.id });
  cleanupCall();
}

function toggleCallTrack(kind) {
  const track = state.localStream?.getTracks().find((item) => item.kind === kind);
  if (!track || !state.call) return;
  track.enabled = !track.enabled;
  updateCall(kind === 'audio' ? { muted: !track.enabled } : { cameraEnabled: track.enabled });
}

async function handleCallSocketEvent(event, payload) {
  const call = state.call;
  if (event === 'call:invite') {
    if (call) {
      void sendCallEvent('call:reject', { call_id: payload?.call_id });
      return;
    }
    state.call = {
      id: payload.call_id,
      conversationId: Number(payload.conversation_id),
      peerId: Number(payload.caller_id),
      peerName: payload.caller_name || 'Friend',
      mediaType: payload.media_type === 'video' ? 'video' : 'audio',
      direction: 'incoming',
      phase: 'ringing',
      muted: false,
      cameraEnabled: true,
      playbackWarningShown: false,
      connectionStatus: '',
    };
    renderCallOverlay();
  } else if (!call || payload?.call_id !== call.id) {
    return;
  } else if (event === 'call:accepted' && call.direction === 'outgoing') {
    try {
      await createPeerConnection(call, true);
    } catch (error) {
      await sendCallEvent('call:end', { call_id: call.id });
      stopCall(`Could not access your microphone or camera: ${error.message}`);
    }
  } else if (event === 'call:signal') {
    try {
      await handleCallSignal(call, payload.signal);
    } catch (error) {
      await sendCallEvent('call:end', { call_id: call.id });
      stopCall(`The call negotiation failed: ${error.message}`);
    }
  } else if (event === 'call:answered-elsewhere') {
    stopCall('This call was answered on another device.');
  } else if (event === 'call:rejected') {
    stopCall('The call was declined.');
  } else if (event === 'call:unavailable') {
    stopCall('Your friend is unavailable for calls right now.');
  } else if (event === 'call:busy') {
    stopCall('Your friend is already on another call.');
  } else if (event === 'call:timeout') {
    stopCall('The call was not answered.');
  } else if (event === 'call:ended') {
    stopCall('The call ended.');
  } else if (event === 'call:error') {
    stopCall(payload.message || 'The call could not be started.');
  }
}

function handleSocketEvent(event, payload) {
  if (event === 'connect') {
    state.socketConnected = true;
    void sendCallEvent('call:ready', {
      enabled: Boolean(navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined'),
    });
    state.activeRoomId = null;
    state.joinedRoomId = null;
    state.onlineFriendIds.clear();
    updatePresenceViews();
    joinSelectedConversation();
  } else if (event === 'disconnect' || event === 'connect_error') {
    if (event === 'disconnect' && state.call) stopCall('Realtime connection lost; the call ended.');
    state.socketConnected = false;
    state.activeRoomId = null;
    state.joinedRoomId = null;
    state.onlineFriendIds.clear();
    clearTypingIndicator();
    updatePresenceViews();
    updateCallButtons();
    if (event === 'connect_error' && payload?.message) {
      const message = payload.message === 'Authentication failed'
        ? 'Realtime sign-in was rejected. Please sign in again.'
        : 'Realtime connection unavailable. Check the Socket.IO server URL and try again.';
      if (state.lastRefreshError !== message) showNotice(message);
      state.lastRefreshError = message;
    }
  } else if (event === 'presence:sync' && Array.isArray(payload)) {
    state.onlineFriendIds = new Set(payload
      .filter((item) => item?.is_online)
      .map((item) => String(item.user_id)));
    updatePresenceViews();
  } else if (event === 'presence:update' && payload?.user_id != null) {
    if (payload.is_online) state.onlineFriendIds.add(String(payload.user_id));
    else state.onlineFriendIds.delete(String(payload.user_id));
    updatePresenceViews();
  } else if (event === 'conversation:joined') {
    if (String(payload?.conversation_id) === String(state.selectedConversationId)) {
      state.joinedRoomId = payload.conversation_id;
      updateCallButtons();
    } else if (payload?.conversation_id) {
      window.chatSocket?.leaveConversation(payload.conversation_id);
    }
  } else if (event === 'conversation:typing' && selectedConversation() &&
    String(payload?.conversation_id) === String(state.selectedConversationId) &&
    String(payload?.user_id) === String(selectedConversation().friend?.id)) {
    clearTimeout(state.typingTimeout);
    state.typingUserId = payload.user_id;
    updatePresenceViews();
    state.typingTimeout = setTimeout(clearTypingIndicator, 5000);
  } else if (event === 'conversation:stop-typing' &&
    String(payload?.conversation_id) === String(state.selectedConversationId) &&
    String(payload?.user_id) === String(state.typingUserId)) {
    clearTypingIndicator();
  } else if (event === 'server:error' && payload?.message) {
    showNotice(payload.message);
  } else if (event === 'call:config' && Array.isArray(payload?.ice_servers) && payload.ice_servers.length) {
    state.iceServers = payload.ice_servers;
  } else if (event.startsWith('call:')) {
    void handleCallSocketEvent(event, payload);
  }
}

function connectSocket() {
  if (!state.token || !window.chatSocket) return;
  window.chatSocket.connect({ url: state.socketUrl, token: state.token }).catch((error) => {
    state.socketConnected = false;
    updatePresenceViews();
    showNotice(error.message || 'Could not start the real-time connection.');
  });
}

function joinSelectedConversation() {
  if (!state.socketConnected || !state.selectedConversationId) return;
  if (state.activeRoomId && String(state.activeRoomId) !== String(state.selectedConversationId)) {
    window.chatSocket.leaveConversation(state.activeRoomId);
  }
  if (String(state.activeRoomId) === String(state.selectedConversationId)) return;
  state.activeRoomId = state.selectedConversationId;
  state.joinedRoomId = null;
  window.chatSocket.joinConversation(state.selectedConversationId);
}

function stopLocalTyping() {
  clearTimeout(state.localTypingTimeout);
  state.localTypingTimeout = null;
  if (state.localTyping && state.joinedRoomId) {
    window.chatSocket?.setTyping(state.selectedConversationId, false);
  }
  state.localTyping = false;
  clearInterval(state.localTypingPulse);
  state.localTypingPulse = null;
}

function handleMessageTyping() {
  if (!state.socketConnected || !state.selectedConversationId ||
    String(state.joinedRoomId) !== String(state.selectedConversationId)) return;
  if (!state.localTyping) {
    state.localTyping = true;
    window.chatSocket.setTyping(state.selectedConversationId, true);
    state.localTypingPulse = setInterval(() => {
      if (state.localTyping && state.joinedRoomId) {
        window.chatSocket.setTyping(state.selectedConversationId, true);
      }
    }, 2500);
  }
  clearTimeout(state.localTypingTimeout);
  state.localTypingTimeout = setTimeout(stopLocalTyping, TYPING_TIMEOUT);
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => refreshData(), REFRESH_INTERVAL);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function openFriend(friendId) {
  const existing = conversationForFriend(friendId);
  let conversation = existing;
  if (!conversation) {
    conversation = await api('/conversations', {
      method: 'POST',
      body: { friend_id: Number(friendId) },
    });
    state.conversations.unshift(conversation);
  }
  if (state.activeRoomId && String(state.activeRoomId) !== String(conversation.id)) {
    window.chatSocket?.leaveConversation(state.activeRoomId);
    state.activeRoomId = null;
    state.joinedRoomId = null;
  }
  stopLocalTyping();
  clearTypingIndicator();
  state.sidebarTool = null;
  state.selectedConversationId = conversation.id;
  state.messages = [];
  state.selectedAttachment = null;
  clearAttachmentPreview();
  render();
  joinSelectedConversation();
  await loadMessages();
  renderMessages();
}

async function handleAuthSubmit(form) {
  const formData = new FormData(form);
  const body = Object.fromEntries(formData.entries());
  body.device_name = 'pitbconnect-desktop';
  const path = state.authMode === 'signup' ? '/auth/register' : '/auth/login';
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const payload = await api(path, { method: 'POST', body });
    persistSession(payload);
    state.selectedConversationId = null;
    state.messages = [];
    render();
    await refreshData();
    connectSocket();
    startPolling();
  } finally {
    submitButton.disabled = false;
  }
}

async function handleAddFriend(form) {
  const phone = new FormData(form).get('phone')?.toString().trim();
  if (!phone) return;
  await api('/friends/requests', { method: 'POST', body: { phone } });
  form.reset();
  await refreshData();
  showNotice('Friend request sent.', 'success');
}

async function handleRequestResponse(button) {
  const { id, response } = button.dataset;
  button.disabled = true;
  await api(`/friends/requests/${encodeURIComponent(id)}/${response}`, { method: 'POST' });
  await refreshData();
  showNotice(response === 'accept' ? 'Friend request accepted.' : 'Friend request declined.', 'success');
}

async function handleSendMessage(form) {
  const field = form.elements.body;
  const body = field.value.trim();
  const conversation = selectedConversation();
  const file = state.selectedAttachment;
  if (!conversation || (!body && !file)) return;
  if (file && !isAllowedAttachment(file)) {
    throw new Error('Choose an image, document, spreadsheet, or ZIP file.');
  }
  if (file && file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error('Attachments must be 5 MiB or smaller.');
  }
  stopLocalTyping();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const payload = file ? new FormData() : { body };
    if (file) {
      if (body) payload.append('body', body);
      payload.append('attachment', file);
    }
    const sentMessage = await api(`/conversations/${encodeURIComponent(conversation.id)}/messages`, {
      method: 'POST',
      body: payload,
    });
    field.value = '';
    state.selectedAttachment = null;
    const attachmentInput = form.querySelector('#attachment-input');
    if (attachmentInput) attachmentInput.value = '';
    clearAttachmentPreview();
    updateAttachmentStatus();
    if (file && CACHED_IMAGE_TYPES.has(sentMessage.attachment?.mime)) {
      try {
        const key = attachmentCacheKey(conversation.id, sentMessage.id);
        const dataUrl = await window.localAttachments.saveImage({
          userId: state.user.id,
          conversationId: conversation.id,
          messageId: sentMessage.id,
          mime: sentMessage.attachment.mime,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        state.cachedAttachments.set(key, dataUrl);
      } catch (error) {
        showNotice(`The image was sent, but could not be saved to this device: ${error.message}`);
      }
    }
    await refreshData();
  } finally {
    submitButton.disabled = false;
    field.focus();
  }
}

function updateAttachmentStatus() {
  const status = document.querySelector('#attachment-status');
  if (status) {
    status.textContent = state.selectedAttachment
      ? 'Ready to send · 5 MiB max.'
      : 'Press Enter to send · Shift + Enter for a new line. Images, documents, spreadsheets, and ZIP files · 5 MiB max.';
  }
}

function clearAttachmentPreview() {
  if (state.attachmentPreviewUrl) {
    URL.revokeObjectURL(state.attachmentPreviewUrl);
    state.attachmentPreviewUrl = null;
  }
  const preview = document.querySelector('#attachment-preview');
  if (preview) {
    preview.replaceChildren();
    preview.hidden = true;
  }
}

function renderAttachmentPreview(file) {
  clearAttachmentPreview();
  if (!file) return;
  const preview = document.querySelector('#attachment-preview');
  if (!preview) return;

  const details = document.createElement('div');
  details.className = 'attachment-preview-details';
  const extension = file.name.split('.').pop()?.toUpperCase() || 'FILE';
  const imageTypes = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  ]);
  if (imageTypes.has(file.type)) {
    state.attachmentPreviewUrl = URL.createObjectURL(file);
    const image = document.createElement('img');
    image.className = 'attachment-preview-image';
    image.src = state.attachmentPreviewUrl;
    image.alt = `Preview of ${file.name}`;
    details.append(image);
  } else {
    const icon = document.createElement('span');
    icon.className = 'attachment-preview-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = extension.slice(0, 4);
    details.append(icon);
  }

  const description = document.createElement('span');
  description.className = 'attachment-preview-description';
  const filename = document.createElement('span');
  filename.className = 'attachment-preview-name';
  filename.textContent = file.name;
  const metadata = document.createElement('span');
  metadata.className = 'attachment-preview-size';
  metadata.textContent = `${formatFileSize(file.size)} · ${extension}`;
  description.append(filename, metadata);
  details.append(description);

  const remove = document.createElement('button');
  remove.className = 'attachment-preview-remove';
  remove.type = 'button';
  remove.dataset.action = 'remove-attachment';
  remove.setAttribute('aria-label', 'Remove attachment');
  remove.title = 'Remove attachment';
  remove.textContent = '×';
  preview.append(details, remove);
  preview.hidden = false;
}

function isAllowedAttachment(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return Boolean(extension && ALLOWED_ATTACHMENT_EXTENSIONS.has(extension));
}

function toggleEmojiPicker() {
  const picker = document.querySelector('#emoji-picker');
  const button = document.querySelector('[data-action="toggle-emoji-picker"]');
  if (!picker || !button) return;
  picker.hidden = !picker.hidden;
  button.setAttribute('aria-expanded', String(!picker.hidden));
}

function closeEmojiPicker() {
  const picker = document.querySelector('#emoji-picker');
  const button = document.querySelector('[data-action="toggle-emoji-picker"]');
  if (!picker || !button) return;
  picker.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

function insertEmoji(emoji) {
  const field = document.querySelector('#message-form textarea');
  if (!field) return;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  const nextValue = `${field.value.slice(0, start)}${emoji}${field.value.slice(end)}`;
  if (nextValue.length > field.maxLength) {
    showNotice('This message has reached the 10,000 character limit.');
    return;
  }
  field.setRangeText(emoji, start, end, 'end');
  field.focus();
  field.dispatchEvent(new Event('input', { bubbles: true }));
  closeEmojiPicker();
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (error) {
    showNotice(`Signed out locally. ${error.message}`);
  } finally {
    clearSession();
    state.authMode = 'login';
    render();
  }
}

function renderUpdateStatus() {
  const version = document.querySelector('#app-version');
  if (version && state.appVersion) version.textContent = `PITBConnect v${state.appVersion}`;
  const status = document.querySelector('#update-status');
  if (status) status.textContent = state.updateStatus;
  document.querySelectorAll('[data-action="check-updates"]').forEach((button) => {
    button.disabled = state.updateStatus === 'Checking for updates…';
  });
  document.querySelectorAll('[data-action="download-update"]').forEach((button) => {
    button.hidden = !state.updateAvailableVersion;
    if (state.updateAvailableVersion) {
      button.textContent = `Download v${state.updateAvailableVersion}`;
    }
  });
}

async function checkForUpdates(manual = true) {
  state.updateStatus = 'Checking for updates…';
  renderUpdateStatus();
  try {
    const result = await window.desktopApp.checkForUpdates();
    state.appVersion = result.currentVersion;
    state.updateAvailableVersion = result.updateAvailable ? result.latestVersion : null;
    state.updateStatus = result.updateAvailable
      ? `Version ${result.latestVersion} is available.`
      : `You're up to date (v${result.currentVersion}).`;
    renderUpdateStatus();
    if (manual && !result.updateAvailable) showNotice(state.updateStatus, 'success');
  } catch (error) {
    state.updateStatus = `Could not check for updates: ${error.message}`;
    renderUpdateStatus();
    if (manual) throw error;
  }
}

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === 'auth-form') await handleAuthSubmit(form);
    if (form.id === 'api-settings-form') {
      const value = normalizeApiUrl(new FormData(form).get('apiUrl')?.toString() || '');
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.pathname.endsWith('/api')) {
        throw new Error('Enter an HTTP or HTTPS Laravel API address ending with /api.');
      }
      const socketUrl = new URL(new FormData(form).get('socketUrl')?.toString() || '');
      if (!['http:', 'https:'].includes(socketUrl.protocol) || socketUrl.pathname !== '/' ||
        socketUrl.username || socketUrl.password || socketUrl.search || socketUrl.hash) {
        throw new Error('Enter an HTTP or HTTPS Socket.IO server origin without a path.');
      }
      state.apiUrl = value;
      state.socketUrl = socketUrl.origin;
      localStorage.setItem(API_URL_KEY, value);
      localStorage.setItem(SOCKET_URL_KEY, state.socketUrl);
      render();
      showNotice('API address saved.', 'success');
      connectSocket();
    }
    if (form.id === 'add-friend-form') await handleAddFriend(form);
    if (form.id === 'message-form') await handleSendMessage(form);
  } catch (error) {
    showNotice(error.message || 'Something went wrong. Please try again.');
  }
});

app.addEventListener('click', async (event) => {
  const picker = document.querySelector('#emoji-picker');
  if (picker && !picker.hidden && !picker.contains(event.target) &&
    !event.target.closest('[data-action="toggle-emoji-picker"]')) {
    closeEmojiPicker();
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'toggle-auth') {
      state.authMode = state.authMode === 'login' ? 'signup' : 'login';
      render();
    } else if (action === 'toggle-sidebar-tool') {
      state.sidebarTool = state.sidebarTool === button.dataset.tool ? null : button.dataset.tool;
      renderSidebar();
      if (state.sidebarTool === 'search') {
        document.querySelector('#friend-search')?.focus();
      }
    } else if (action === 'check-updates') {
      await checkForUpdates();
    } else if (action === 'download-update') {
      await window.desktopApp.downloadUpdate(state.updateAvailableVersion);
    } else if (action === 'logout') {
      await logout();
    } else if (action === 'refresh') {
      await refreshData();
      if (state.selectedConversationId) {
        await loadMessages();
        renderMessages();
      }
    } else if (action === 'call-audio' || action === 'call-video') {
      await startCall(action === 'call-video' ? 'video' : 'audio');
    } else if (action === 'choose-attachment') {
      document.querySelector('#attachment-input')?.click();
    } else if (action === 'show-friends') {
      if (state.activeRoomId) window.chatSocket?.leaveConversation(state.activeRoomId);
      state.activeRoomId = null;
      state.joinedRoomId = null;
      state.selectedConversationId = null;
      state.messages = [];
      state.selectedAttachment = null;
      const attachmentInput = document.querySelector('#attachment-input');
      if (attachmentInput) attachmentInput.value = '';
      clearAttachmentPreview();
      stopLocalTyping();
      clearTypingIndicator();
      render();
    } else if (action === 'remove-attachment') {
      state.selectedAttachment = null;
      const attachmentInput = document.querySelector('#attachment-input');
      if (attachmentInput) attachmentInput.value = '';
      clearAttachmentPreview();
      updateAttachmentStatus();
    } else if (action === 'toggle-emoji-picker') {
      toggleEmojiPicker();
    } else if (button.dataset.emoji) {
      insertEmoji(button.dataset.emoji);
    } else if (action === 'download-attachment') {
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      await downloadAttachment(message);
    } else if (action === 'respond-request') {
      await handleRequestResponse(button);
    } else if (action === 'open-friend') {
      await openFriend(id);
    }
  } catch (error) {
    showNotice(error.message || 'Something went wrong. Please try again.');
    button.disabled = false;
  }
});

document.querySelector('#call-overlay')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-call-action]');
  if (!button) return;
  try {
    if (button.dataset.callAction === 'accept') await answerCall();
    else if (button.dataset.callAction === 'reject') rejectCall();
    else if (button.dataset.callAction === 'hangup') hangUpCall();
    else if (button.dataset.callAction === 'mute') toggleCallTrack('audio');
    else if (button.dataset.callAction === 'camera') toggleCallTrack('video');
  } catch (error) {
    showNotice(error.message || 'The call could not be started.');
  }
});

app.addEventListener('input', (event) => {
  if (event.target.id === 'friend-search') {
    state.friendSearchQuery = event.target.value;
    renderFriendList();
  }
  if (event.target.matches('#message-form textarea')) handleMessageTyping();
});

app.addEventListener('change', (event) => {
  if (event.target.id !== 'attachment-input') return;
  const file = event.target.files?.[0] || null;
  if (file && !isAllowedAttachment(file)) {
    event.target.value = '';
    state.selectedAttachment = null;
    updateAttachmentStatus();
    showNotice('Choose an image, document, spreadsheet, or ZIP file.');
    return;
  }
  if (file && file.size > MAX_ATTACHMENT_SIZE) {
    event.target.value = '';
    state.selectedAttachment = null;
    updateAttachmentStatus();
    showNotice('Attachments must be 5 MiB or smaller.');
    return;
  }
  state.selectedAttachment = file;
  renderAttachmentPreview(file);
  updateAttachmentStatus();
});

app.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('#emoji-picker')?.hidden) {
    closeEmojiPicker();
  }
  if (event.target.matches('#message-form textarea') && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

window.chatSocket?.onEvent(handleSocketEvent);
checkForUpdates(false);

if (state.token && state.user) {
  render();
  refreshData().then(startPolling);
  connectSocket();
} else {
  render();
}
