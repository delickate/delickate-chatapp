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
  addFriendPhone: '',
  groupName: '',
  selectedGroupFriendIds: new Set(),
  conversations: [],
  groupMembershipRevisions: new Map(),
  unreadCount: null,
  selectedConversationId: null,
  messages: [],
  replyTarget: null,
  selectedAttachment: null,
  attachmentPreviewUrl: null,
  previewImageUrl: null,
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
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_API_URL;

  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') {
      parsed.pathname = '/api';
    } else if (!pathname.toLowerCase().endsWith('/api')) {
      parsed.pathname = `${pathname}/api`;
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    const normalized = raw.replace(/\/+$/, '');
    return normalized.toLowerCase().endsWith('/api') ? normalized : `${normalized}/api`;
  }
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
    String(state.joinedRoomId) === String(state.selectedConversationId) &&
    selectedConversation()?.type !== 'group');
  document.querySelectorAll('[data-action="call-audio"], [data-action="call-video"]')
    .forEach((button) => {
      button.disabled = !available;
      button.hidden = selectedConversation()?.type === 'group';
    });
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

function conversationTimestamp(conversation) {
  return conversation?.last_message?.created_at || conversation?.updated_at || conversation?.created_at || '';
}

function sortConversationsByLatest(conversations) {
  return [...conversations].sort((left, right) => {
    const leftTime = Date.parse(conversationTimestamp(left) || 0);
    const rightTime = Date.parse(conversationTimestamp(right) || 0);
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return rightTime - leftTime;
  });
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
  state.replyTarget = null;
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
        <section class="auth-content">
          <div class="brand-lockup"><span class="brand-mark">P</span><span>PITBConnect</span></div>
          <h2>${isSignup ? 'Create account' : 'Sign in'}</h2>
          <form id="auth-form" class="form-grid">
            ${isSignup ? `
              <div class="field"><label for="name">Full name</label><input id="name" name="name" autocomplete="name" maxlength="120" placeholder="Your name" required /></div>
            ` : ''}
            <div class="field"><label for="phone">Phone number</label><input id="phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" placeholder="+15551234567" title="Use international format, for example +15551234567" required /></div>
            ${isSignup ? `
              <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="you@example.com" required /></div>
              <div class="field"><label for="dob">Date of birth</label><input id="dob" name="dob" type="date" max="${new Date().toISOString().slice(0, 10)}" required /></div>
            ` : ''}
            <div class="field">
              <label for="password">Password</label>
              <div class="password-input-wrap">
                <input id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="${isSignup ? 8 : 1}" maxlength="128" placeholder="${isSignup ? 'At least 8 characters' : 'Your password'}" required />
                <button class="password-visibility" type="button" data-action="toggle-password-visibility" aria-label="Show password" title="Show password" aria-pressed="false">
                  <svg class="password-eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a15.7 15.7 0 0 1-3.1 3.9"/><path d="M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.5 10.5 0 0 0 4-.8"/></svg>
                  <svg class="password-eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
            </div>
            <button class="primary-button auth-submit" type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
          </form>
          <p class="switch-auth">
            ${isSignup ? 'Already registered?' : 'Don’t have an account?'}
            <button class="text-button" type="button" data-action="toggle-auth">${isSignup ? 'Sign in' : 'Register'}</button>
          </p>
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
  closeImagePreview();
  if (!state.token || !state.user) {
    showAuth();
    return;
  }
  showChatShell();
}

function isOnline(userId) {
  return state.onlineFriendIds.has(String(userId));
}

function avatarMarkup(user, size = 'sm') {
  if (user?.avatar_url) {
    return `<img class="avatar ${size} avatar-image" src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(user.name || 'User avatar')}" loading="lazy" decoding="async">`;
  }
  return `<span class="avatar ${size} ${colorClass(user?.id)}" aria-hidden="true">${escapeHtml(initials(user?.name))}</span>`;
}

function friendAvatar(user, size = 'sm', withPresence = false) {
  const avatar = avatarMarkup(user, size);
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

function conversationTitle(conversation) {
  return conversation?.type === 'group'
    ? conversation.name
    : conversation?.friend?.name || 'Conversation';
}

function participantNames(conversation, limit = 5) {
  const names = Array.isArray(conversation?.participants)
    ? conversation.participants
        .map((participant) => participant?.name)
        .filter(Boolean)
    : [];

  if (!names.length) return '';
  const visible = names.slice(0, limit);
  const extra = Math.max(0, names.length - visible.length);
  return extra > 0 ? `${visible.join(', ')}, +${extra} more` : visible.join(', ');
}

function conversationAvatar(conversation, size = 'sm', withPresence = false) {
  if (conversation?.type !== 'group') {
    return friendAvatar(conversation?.friend, size, withPresence);
  }
  return `<span class="avatar ${size} group-avatar" aria-label="Group">${escapeHtml(initials(conversation.name))}</span>`;
}

function messageAvatar(message) {
  const conversation = selectedConversation();
  if (conversation?.type !== 'group') {
    return friendAvatar(conversation?.friend, 'message-avatar');
  }
  const sender = conversation.participants?.find((participant) =>
    String(participant.id) === String(message.sender?.id));
  return friendAvatar(sender || message.sender, 'message-avatar');
}

function showChatShell() {
  app.innerHTML = `
    <div class="app-shell ${state.selectedConversationId ? 'chat-open' : ''}">
      <aside class="rail">
        <div class="friend-toolbar" aria-label="Friend list actions">
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="search" aria-label="Search friends" aria-expanded="false" title="Search friends"><span aria-hidden="true">⌕</span><span>Search</span></button>
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="add" aria-label="Add a friend" aria-expanded="false" title="Add a friend"><span aria-hidden="true">＋</span><span>Add</span></button>
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="group" aria-label="Create a group" aria-expanded="false" title="Create a group"><span aria-hidden="true">◎</span><span>Group</span></button>
          <button class="rail-tool request-tool" type="button" data-action="toggle-sidebar-tool" data-tool="requests" aria-label="Friend requests" aria-expanded="false" title="Friend requests"><span aria-hidden="true">✉</span><span>Requests</span><span class="tool-badge" id="request-count" hidden></span></button>
          <button class="rail-tool" type="button" data-action="refresh" aria-label="Refresh friends and messages" title="Refresh"><span aria-hidden="true">↻</span><span>Sync</span></button>
          <button class="rail-tool" type="button" data-action="toggle-sidebar-tool" data-tool="updates" aria-label="Check app updates" aria-expanded="false" title="App updates"><span aria-hidden="true">⋯</span><span>Updates</span></button>
        </div>
        <div class="sidebar-tools" id="sidebar-tools" hidden></div>
        <div class="friend-list-heading"><h2>Friends</h2><span class="unread-total" id="unread-message-count" hidden></span></div>
        <div class="friend-list" id="friend-list"></div>
        <div class="profile">
          <button class="profile-avatar-button" type="button" data-action="open-profile" aria-label="Open profile" title="Open profile">
            ${friendAvatar(state.user, 'sm')}
          </button>
          <div class="person-info"><div class="person-name">${escapeHtml(state.user.name)}</div><div class="person-sub">${escapeHtml(state.user.phone)}</div></div>
          <button class="logout-button" type="button" data-action="logout">Sign out</button>
        </div>
      </aside>
      <section class="chat-panel" id="chat-panel"></section>
      <div id="modal-root"></div>
    </div>`;

  renderSidebar();
  renderThread();
  syncUnreadIndicators();
}

function renderSidebar() {
  state.conversations = sortConversationsByLatest(state.conversations);

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
          <input id="friend-phone" name="phone" type="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" placeholder="+1 555 123 4567" value="${escapeHtml(state.addFriendPhone)}" aria-label="Friend's phone number" required />
          <button type="submit" title="Send friend request" aria-label="Send friend request">Send</button>
        </div>
      </form>`;
  }
  if (state.sidebarTool === 'group') {
    return `
      <form class="create-group" id="create-group-form">
        <label class="tool-field-label" for="group-name">New group</label>
        <input id="group-name" name="name" type="text" maxlength="100" value="${escapeHtml(state.groupName)}" placeholder="Group title" required />
        <div class="group-friend-options" role="group" aria-label="Choose friends">
          ${state.friends.length
            ? state.friends.map((friend) => `
              <label class="group-friend-option">
                <input type="checkbox" name="friend_ids" value="${escapeHtml(friend.id)}" ${state.selectedGroupFriendIds.has(String(friend.id)) ? 'checked' : ''} />
                <span>${escapeHtml(friend.name)}</span>
              </label>`).join('')
            : '<span class="empty-list">Add friends before creating a group.</span>'}
        </div>
        <button class="small-button create-group-submit" type="submit" ${state.friends.length ? '' : 'disabled'}>Create group</button>
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
  const entries = [
    ...state.friends.map((friend) => ({ kind: 'friend', friend, conversation: conversationForFriend(friend.id) })),
    ...state.conversations
      .filter((conversation) => conversation.type === 'group')
      .map((conversation) => ({ kind: 'group', conversation })),
  ].filter(({ friend, conversation }) => {
    const preview = conversation?.last_message?.body ||
      conversation?.last_message?.attachment?.name || '';
    return !filter || `${friend?.name || conversationTitle(conversation)} ${preview}`
      .toLowerCase().includes(filter);
  }).sort((left, right) => {
    const leftTime = Date.parse(conversationTimestamp(left.conversation) || 0);
    const rightTime = Date.parse(conversationTimestamp(right.conversation) || 0);
    if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return rightTime - leftTime;
  });
  friendList.innerHTML = entries.length
    ? entries.map(({ kind, friend, conversation }) => {
      if (kind === 'group') return renderGroupListItem(conversation);
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
    : state.friends.length || state.conversations.some((conversation) => conversation.type === 'group')
      ? '<div class="empty-list">No friends match your search.</div>'
      : '<div class="empty-list">Your friends and groups will appear here. Select Add or Group to get started.</div>';
}

function renderGroupListItem(conversation) {
  const unreadCount = Number(conversation.unread_count) || 0;
  const lastMessage = conversation.last_message;
  const preview = lastMessage
    ? `${lastMessage.sender?.name ? `${lastMessage.sender.name}: ` : ''}${lastMessage.body || lastMessage.attachment?.name || 'Attachment'}`
    : `${conversation.participants?.length || 0} members`;
  const memberNames = participantNames(conversation);
  const tooltip = memberNames ? `Members: ${memberNames}` : 'Group members';
  return `
    <button class="friend-item group-item ${String(selectedConversation()?.id) === String(conversation.id) ? 'active' : ''} ${unreadCount ? 'has-unread' : ''}" type="button" data-action="open-conversation" data-id="${escapeHtml(conversation.id)}" aria-label="Open group ${escapeHtml(conversation.name)}${unreadCount ? `, ${unreadCount} unread messages` : ''}" title="${escapeHtml(tooltip)}">
      ${conversationAvatar(conversation)}
      <span class="person-info"><span class="person-name">${escapeHtml(conversation.name)}</span><span class="conversation-preview">${escapeHtml(preview)}</span></span>
      <span class="conversation-meta">${lastMessage ? formattedTime(lastMessage.created_at) : ''}
        ${unreadCount ? `<span class="counter">${escapeHtml(unreadCount)}</span>` : ''}
      </span>
    </button>`;
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

  const groupMembers = conversation.type === 'group' ? (conversation.participants || []).filter((member) => member && member.id) : [];
  panel.innerHTML = `
    <header class="chat-header">
      <button class="icon-button back-to-friends" type="button" data-action="show-friends" title="Back to friends" aria-label="Back to friends">‹</button>
      ${conversationAvatar(conversation, 'lg', conversation.type !== 'group')}
      <div class="chat-heading"><h2>${escapeHtml(conversationTitle(conversation))}</h2><p id="chat-status" title="${escapeHtml(conversation.type === 'group' ? `${groupMembers.length} group members` : presenceText(conversation.friend?.id))}">${conversation.type === 'group' ? `${groupMembers.length} members` : presenceText(conversation.friend?.id)}</p></div>
      <div class="chat-actions">
        ${conversation.type === 'group' ? `<button class="icon-button group-members-button" type="button" data-action="open-group-members" data-id="${escapeHtml(conversation.id)}" title="View group members" aria-label="View ${groupMembers.length} group members"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 19v-1a6 6 0 0 1 12 0v1"/><path d="M16 5.5a3 3 0 0 1 0 5.8M18 14a5 5 0 0 1 3 4.5v.5"/></svg><span class="group-member-count">${groupMembers.length}</span></button>` : ''}
        <button class="icon-button" type="button" data-action="unfriend" data-id="${escapeHtml(conversation.friend?.id)}" title="Remove friend" aria-label="Remove ${escapeHtml(conversation.friend?.name || 'friend')}" ${conversation.type === 'group' ? 'hidden' : ''}>✕</button>
        <button class="icon-button" type="button" data-action="call-audio" title="Start voice call" aria-label="Start voice call" ${state.joinedRoomId && conversation.type !== 'group' ? '' : 'disabled'} ${conversation.type === 'group' ? 'hidden' : ''}>☎</button>
        <button class="icon-button" type="button" data-action="call-video" title="Start video call" aria-label="Start video call" ${state.joinedRoomId && conversation.type !== 'group' ? '' : 'disabled'} ${conversation.type === 'group' ? 'hidden' : ''}>▣</button>
        <button class="icon-button" type="button" data-action="refresh" title="Refresh messages" aria-label="Refresh messages">↻</button>
      </div>
    </header>
    <div class="message-list" id="message-list"></div>
    <div class="composer-wrap">
      <div class="attachment-preview" id="attachment-preview" aria-live="polite" hidden></div>
      <div class="reply-preview" id="reply-preview" hidden></div>
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
      <p class="composer-hint" id="attachment-status" aria-live="polite">Press Enter to send · Shift + Enter for a new line · Paste an image to attach · 5 MiB max.</p>
    </div>`;
  renderMessages();
  updateReplyPreview();
}

function renderProfileModal() {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot || !state.user) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="app-modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close profile">×</button>
        <h2 id="profile-modal-title">Your profile</h2>
        <div class="profile-modal-avatar">${friendAvatar(state.user, 'lg')}</div>
        <div class="profile-modal-name">${escapeHtml(state.user.name)}</div>
        <div class="profile-modal-phone">${escapeHtml(state.user.phone)}</div>
        <button class="primary-button profile-change-button" type="button" data-action="choose-profile-picture">Change profile picture</button>
        <input id="profile-picture-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </section>
    </div>`;
}

function renderGroupMembersModal(conversation) {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot || conversation?.type !== 'group') return;
  const members = (conversation.participants || []).filter((member) => member && member.id);
  const memberIds = new Set(members.map((member) => String(member.id)));
  const availableFriends = state.friends.filter((friend) => !memberIds.has(String(friend.id)));
  const creatorId = conversation.created_by ?? conversation.created_by_user_id;
  const isCreator = String(creatorId) === String(state.user.id);
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="app-modal group-modal" role="dialog" aria-modal="true" aria-labelledby="group-modal-title">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close group members">×</button>
        <h2 id="group-modal-title">${isCreator ? 'Manage group members' : 'Group members'}</h2>
        <p class="modal-subtitle">${escapeHtml(conversation.name || 'Group')} · ${members.length} members</p>
        <div class="modal-member-list">
          ${members.map((member) => `
            <div class="modal-member-row">
              ${friendAvatar(member, 'sm')}
              <span class="modal-member-name">${escapeHtml(member.name)}</span>
              ${String(member.id) === String(state.user.id)
                ? `<span class="group-member-role">${isCreator ? 'Creator' : 'You'}</span>`
                : isCreator
                  ? `<button class="group-member-remove" type="button" data-action="remove-group-member" data-conversation-id="${escapeHtml(conversation.id)}" data-user-id="${escapeHtml(member.id)}" aria-label="Remove ${escapeHtml(member.name)} from group" title="Remove member">×</button>`
                  : ''}
            </div>
          `).join('')}
        </div>
        ${isCreator ? `
          <form class="add-group-member-form" id="add-group-member-form" data-conversation-id="${escapeHtml(conversation.id)}">
            <label for="group-member-friend">Add a friend</label>
            <div class="add-group-member-controls">
              <select id="group-member-friend" name="user_id" required ${availableFriends.length ? '' : 'disabled'}>
                ${availableFriends.length
                  ? `<option value="">Select a friend</option>${availableFriends.map((friend) => `<option value="${escapeHtml(friend.id)}">${escapeHtml(friend.name)}</option>`).join('')}`
                  : '<option value="">No more friends to add</option>'}
              </select>
              <button class="small-button" type="submit" ${availableFriends.length ? '' : 'disabled'}>Add</button>
            </div>
          </form>
        ` : ''}
        ${!isCreator ? `<button class="group-leave-modal" type="button" data-action="leave-group" data-id="${escapeHtml(conversation.id)}">Leave group</button>` : ''}
      </section>
    </div>`;
}

function updateGroupParticipants(conversationId, participants) {
  const key = String(conversationId);
  state.groupMembershipRevisions.set(key, (state.groupMembershipRevisions.get(key) || 0) + 1);
  state.conversations = state.conversations.map((conversation) =>
    String(conversation.id) === key ? { ...conversation, participants } : conversation);
  const updatedConversation = state.conversations.find((conversation) => String(conversation.id) === key);
  if (updatedConversation && String(state.selectedConversationId) === key) {
    renderThread();
    renderGroupMembersModal(updatedConversation);
  }
}

function closeModal() {
  const modalRoot = document.querySelector('#modal-root');
  if (modalRoot) modalRoot.replaceChildren();
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
        <video id="call-remote-video" autoplay muted playsinline></video>
        <video id="call-local-video" autoplay muted playsinline></video>
      </div>` : '<div class="call-avatar" aria-hidden="true">☎</div>'}
      <audio id="call-remote-audio" autoplay controls aria-label="Friend call audio"></audio>
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
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    playRemoteMedia(remoteAudio);
  }
}

function playRemoteMedia(element) {
  element.play().catch((error) => {
    if (error.name === 'AbortError' || !state.call || state.call.playbackWarningShown) return;
    state.call.playbackWarningShown = true;
    showNotice('Incoming audio could not start automatically. Press Play in the call controls to hear your friend.');
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
    const isDeleted = Boolean(message.deleted_for_everyone_at);
    const day = formattedDay(message.created_at);
    let divider = '';
    if (day !== lastDay) {
      divider = `<div class="day-divider"><span>${escapeHtml(day)}</span></div>`;
      lastDay = day;
    }
    const receipt = !isDeleted && isMine
      ? (message.read_at ? '✓✓ Seen' : message.delivered_at ? '✓✓ Delivered' : '✓ Sent')
      : '';
    const cacheKey = attachmentCacheKey(message.conversation_id, message.id);
    const imagePreview = message.attachment && CACHED_IMAGE_TYPES.has(message.attachment.mime)
      ? state.cachedAttachments.get(cacheKey)
      : null;
    const replyPreview = message.reply_to
      ? `<div class="message-quote"><strong>${escapeHtml(message.reply_to.sender?.name || 'Message')}</strong><span>${escapeHtml(message.reply_to.unavailable ? 'Original message unavailable' : message.reply_to.deleted_for_everyone_at ? 'This message was deleted' : message.reply_to.body || message.reply_to.attachment?.name || 'Attachment')}</span></div>`
      : '';
    return `${divider}
      <div class="message-row ${isMine ? 'mine' : ''}">
        ${isMine ? '' : messageAvatar(message)}
        <div class="message-bubble">
          ${replyPreview}
          ${isDeleted ? '<div class="message-deleted">This message was deleted</div>' : ''}
          ${!isDeleted && message.body ? `<div class="message-text">${escapeHtml(message.body)}</div>` : ''}
          ${!isDeleted && imagePreview ? `<button class="message-image-button" type="button" data-action="preview-image" data-image-url="${escapeHtml(imagePreview)}" data-image-name="${escapeHtml(message.attachment.name)}" aria-label="View ${escapeHtml(message.attachment.name)} full size"><img class="message-image" src="${escapeHtml(imagePreview)}" alt="${escapeHtml(message.attachment.name)}" loading="lazy" decoding="async"></button>` : ''}
          ${!isDeleted && message.attachment ? `<button class="attachment-download" type="button" data-action="download-attachment" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.attachment.name)} · ${formatFileSize(message.attachment.size)} · Download</button>` : ''}
          ${!isDeleted ? `<div class="message-actions">
            <button type="button" data-action="reply-message" data-message-id="${escapeHtml(message.id)}" aria-label="Reply to message" title="Reply">↩</button>
            <button type="button" data-action="delete-message-for-me" data-message-id="${escapeHtml(message.id)}" aria-label="Delete message for me" title="Delete for me">⌫</button>
            ${isMine ? `<button type="button" data-action="delete-message-for-everyone" data-message-id="${escapeHtml(message.id)}" aria-label="Delete message for everyone" title="Delete for everyone">×</button>` : ''}
          </div>` : ''}
          <div class="message-foot"><span>${formattedTime(message.created_at)}</span>${receipt ? `<span>${receipt}</span>` : ''}</div>
        </div>
      </div>`;
  }).join('');
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
}

function updateReplyPreview() {
  const preview = document.querySelector('#reply-preview');
  if (!preview) return;
  const message = state.replyTarget;
  preview.hidden = !message;
  preview.innerHTML = message ? `
    <div class="reply-preview-content">
      <strong>Replying to ${escapeHtml(message.sender?.name || 'message')}</strong>
      <span>${escapeHtml(message.deleted_for_everyone_at ? 'This message was deleted' : message.body || message.attachment?.name || 'Attachment')}</span>
    </div>
    <button class="reply-preview-cancel" type="button" data-action="cancel-reply" aria-label="Cancel reply">×</button>` : '';
}

function beginReply(message) {
  state.replyTarget = message;
  updateReplyPreview();
  document.querySelector('#message-form textarea')?.focus();
}

function showImagePreview(url, name) {
  closeImagePreview();
  state.previewImageUrl = url;
  const viewer = document.createElement('div');
  viewer.className = 'image-viewer';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.setAttribute('aria-label', `Image preview: ${name}`);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'image-viewer-close';
  close.dataset.action = 'close-image-preview';
  close.setAttribute('aria-label', 'Close image preview');
  close.textContent = '×';

  const image = document.createElement('img');
  image.className = 'image-viewer-full';
  image.src = url;
  image.alt = name;

  viewer.append(close, image);
  app.append(viewer);
  close.focus();
}

function closeImagePreview() {
  state.previewImageUrl = null;
  app.querySelector('.image-viewer')?.remove();
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
    const membershipRevisionsAtStart = new Map(state.groupMembershipRevisions);
    const [friends, requests, conversations] = await Promise.all([
      api('/friends'),
      api('/friends/requests?direction=incoming'),
      api('/conversations'),
    ]);
    state.friends = Array.isArray(friends.data) ? friends.data : [];
    state.requests = Array.isArray(requests.data) ? requests.data : [];
    const previousConversations = state.conversations;
    state.conversations = sortConversationsByLatest(
      Array.isArray(conversations.data) ? conversations.data : [],
    ).map((conversation) => {
      if (conversation.type !== 'group') return conversation;
      const key = String(conversation.id);
      if ((state.groupMembershipRevisions.get(key) || 0) <= (membershipRevisionsAtStart.get(key) || 0)) {
        return conversation;
      }
      const current = previousConversations.find((item) => String(item.id) === key);
      return current ? { ...conversation, participants: current.participants } : conversation;
    });
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
  const conversation = selectedConversation();
  if (conversation?.type === 'group') {
    if (state.typingUserId) {
      const typingUser = conversation.participants?.find((participant) =>
        String(participant.id) === String(state.typingUserId));
      if (typingUser) return `${typingUser.name} is typing…`;
    }
    const memberNames = participantNames(conversation);
    return `${conversation.participants?.length || 0} members${memberNames ? ` • ${memberNames}` : ''}`;
  }
  if (!state.socketConnected) return 'Presence unavailable';
  if (String(state.typingUserId) === String(userId)) return 'Typing…';
  return isOnline(userId) ? 'Online' : 'Offline';
}

function updatePresenceViews() {
  renderSidebar();
  const conversation = selectedConversation();
  const status = document.querySelector('#chat-status');
  if (status && conversation) {
    const isTyping = conversation.type === 'group'
      ? Boolean(state.typingUserId && conversation.participants?.some((participant) =>
        String(participant.id) === String(state.typingUserId)))
      : String(state.typingUserId) === String(conversation.friend?.id);
    status.textContent = presenceText(conversation.friend?.id);
    status.classList.toggle('typing', isTyping);
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
  if (conversation.type === 'group') {
    showNotice('Voice and video calls are not available in group chats.');
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
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: call.mediaType === 'video',
  });
  if (state.call?.id !== call.id) {
    localStream.getTracks().forEach((track) => track.stop());
    return;
  }
  if (!localStream.getAudioTracks().some((track) => track.enabled && track.readyState === 'live')) {
    localStream.getTracks().forEach((track) => track.stop());
    throw new Error('No active microphone audio track was created. Check microphone permissions and input settings.');
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
    (selectedConversation().type === 'group'
      ? selectedConversation().participants?.some((participant) =>
        String(participant.id) === String(payload?.user_id))
      : String(payload?.user_id) === String(selectedConversation().friend?.id))) {
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
    const hasTurnRelay = state.iceServers.some((server) => {
      const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      return urls.some((url) => /^turns?:/i.test(String(url || '')));
    });
    if (!hasTurnRelay) {
      showNotice('No TURN relay is configured on the socket server. Calls may fail behind NAT or a firewall.');
    }
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
    state.conversations = sortConversationsByLatest([...state.conversations, conversation]);
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
  state.replyTarget = null;
  state.selectedAttachment = null;
  clearAttachmentPreview();
  render();
  joinSelectedConversation();
  await loadMessages();
  renderMessages();
}

async function openGroupConversation(conversationId) {
  const conversation = state.conversations.find((item) =>
    String(item.id) === String(conversationId) && item.type === 'group');
  if (!conversation) throw new Error('This group is no longer available.');
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
  state.replyTarget = null;
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
  state.addFriendPhone = '';
  form.reset();
  await refreshData();
  showNotice('Friend request sent.', 'success');
}

async function handleCreateGroup(form) {
  const formData = new FormData(form);
  const name = formData.get('name')?.toString().trim() || '';
  const friendIds = formData.getAll('friend_ids').map((id) => Number(id));
  if (!name) throw new Error('Enter a group title.');
  if (!friendIds.length) throw new Error('Choose at least one friend to add to the group.');
  const conversation = await api('/groups', {
    method: 'POST',
    body: { name, friend_ids: friendIds },
  });
  state.sidebarTool = null;
  state.groupName = '';
  state.selectedGroupFriendIds.clear();
  state.conversations = sortConversationsByLatest([...state.conversations, conversation]);
  await refreshData();
  await openGroupConversation(conversation.id);
  showNotice('Group created.', 'success');
}

async function handleRequestResponse(button) {
  const { id, response } = button.dataset;
  button.disabled = true;
  await api(`/friends/requests/${encodeURIComponent(id)}/${response}`, { method: 'POST' });
  await refreshData();
  showNotice(response === 'accept' ? 'Friend request accepted.' : 'Friend request declined.', 'success');
}

async function handleUnfriend(friendId) {
  const friend = state.friends.find((person) => String(person.id) === String(friendId));
  const friendName = friend?.name || 'this friend';
  const confirmed = window.confirm(`Remove ${friendName} from your friends list? This will also delete the direct chat.`);
  if (!confirmed) return;

  await api(`/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' });
  state.selectedConversationId = null;
  state.messages = [];
  state.activeRoomId = null;
  state.joinedRoomId = null;
  await refreshData();
  showNotice('Friend removed.', 'success');
}

async function handleLeaveGroup(conversationId) {
  const conversation = state.conversations.find((item) => String(item.id) === String(conversationId) && item.type === 'group');
  if (!conversation) throw new Error('This group is no longer available.');
  const confirmed = window.confirm(`Leave "${conversation.name}"?`);
  if (!confirmed) return;

  await api(`/groups/${encodeURIComponent(conversationId)}/leave`, { method: 'POST' });
  closeModal();
  state.selectedConversationId = null;
  state.messages = [];
  state.activeRoomId = null;
  state.joinedRoomId = null;
  await refreshData();
  showNotice('You left the group.', 'success');
}

async function handleRemoveGroupMember(conversationId, userId, button) {
  const conversation = state.conversations.find((item) => String(item.id) === String(conversationId) && item.type === 'group');
  if (!conversation) throw new Error('This group is no longer available.');
  const member = (conversation.participants || []).find((person) => String(person.id) === String(userId));
  if (!member) throw new Error('This member is no longer in the group.');
  const confirmed = window.confirm(`Remove ${member.name} from "${conversation.name}"?`);
  if (!confirmed) return;

  if (button) button.disabled = true;
  await api(`/groups/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  updateGroupParticipants(conversationId, (conversation.participants || []).filter(
    (person) => String(person.id) !== String(userId),
  ));
  showNotice(`${member.name} was removed from the group.`, 'success');
}

async function handleAddGroupMember(form) {
  const conversationId = form.dataset.conversationId;
  const userId = new FormData(form).get('user_id')?.toString();
  if (!conversationId || !userId) throw new Error('Select a friend to add.');
  const conversation = state.conversations.find((item) =>
    String(item.id) === String(conversationId) && item.type === 'group');
  if (!conversation) throw new Error('This group is no longer available.');
  const friend = state.friends.find((item) => String(item.id) === userId);
  if (!friend) throw new Error('This friend is no longer available.');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const response = await api(`/groups/${encodeURIComponent(conversationId)}/members`, {
      method: 'POST',
      body: { user_id: Number(userId) },
    });
    const member = response?.member || friend;
    const participants = [...(conversation.participants || []), member];
    updateGroupParticipants(conversationId, participants);
    showNotice(`${member.name} was added to the group.`, 'success');
  } finally {
    if (submitButton.isConnected) submitButton.disabled = false;
  }
}

async function handleSendMessage(form) {
  const field = form.elements.body;
  const body = field.value.trim();
  const conversation = selectedConversation();
  const file = state.selectedAttachment;
  const replyTarget = state.replyTarget;
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
    if (replyTarget) {
      if (payload instanceof FormData) payload.append('reply_to_message_id', replyTarget.id);
      else payload.reply_to_message_id = replyTarget.id;
    }
    const sentMessage = await api(`/conversations/${encodeURIComponent(conversation.id)}/messages`, {
      method: 'POST',
      body: payload,
    });
    field.value = '';
    state.replyTarget = null;
    updateReplyPreview();
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

async function handleDeleteMessage(messageId, scope) {
  const conversation = selectedConversation();
  const message = state.messages.find((item) => String(item.id) === String(messageId));
  if (!conversation || !message) throw new Error('This message is no longer available.');
  const forEveryone = scope === 'everyone';
  const confirmation = forEveryone
    ? 'Delete this message for everyone? It will be removed for all participants.'
    : 'Delete this message only for you? Other participants will still see it.';
  if (!window.confirm(confirmation)) return;

  let cleanupWarning = '';
  await api(`/conversations/${encodeURIComponent(conversation.id)}/messages/${encodeURIComponent(message.id)}`, {
    method: 'DELETE',
    body: { scope: forEveryone ? 'everyone' : 'me' },
  });
  if (message.attachment && CACHED_IMAGE_TYPES.has(message.attachment.mime)) {
    const cacheDetails = {
      userId: state.user.id,
      conversationId: conversation.id,
      messageId: message.id,
      mime: message.attachment.mime,
    };
    state.cachedAttachments.delete(attachmentCacheKey(conversation.id, message.id));
    try {
      await window.localAttachments.deleteImage(cacheDetails);
    } catch (error) {
      cleanupWarning = ` The local image copy could not be removed: ${error.message}`;
    }
  }
  await loadMessages();
  renderMessages();
  await refreshData();
  if (state.lastRefreshError) return;
  showNotice(
    `${forEveryone ? 'Message deleted for everyone.' : 'Message deleted for you.'}${cleanupWarning}`,
    cleanupWarning ? 'error' : 'success',
  );
}

function updateAttachmentStatus() {
  const status = document.querySelector('#attachment-status');
  if (status) {
    status.textContent = state.selectedAttachment
      ? 'Ready to send · 5 MiB max.'
      : 'Press Enter to send · Shift + Enter for a new line · Paste an image to attach · 5 MiB max.';
  }
}

function selectAttachment(file) {
  if (!file) return;
  if (!isAllowedAttachment(file)) {
    showNotice('Choose an image, document, spreadsheet, or ZIP file.');
    return;
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    showNotice('Attachments must be 5 MiB or smaller.');
    return;
  }
  state.selectedAttachment = file;
  const attachmentInput = document.querySelector('#attachment-input');
  if (attachmentInput) attachmentInput.value = '';
  renderAttachmentPreview(file);
  updateAttachmentStatus();
}

function pastedImageFile(clipboardData) {
  const image = Array.from(clipboardData?.items || [])
    .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    ?.getAsFile();
  if (!image) return null;

  const extensionByMime = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/heif': 'heif',
  };
  const extension = extensionByMime[image.type.toLowerCase()];
  if (!extension) {
    throw new Error('This pasted image format is not supported. Save it as PNG or JPEG and try again.');
  }

  return new File([image], `PITBConnect-snippet-${Date.now()}.${extension}`, {
    type: image.type,
    lastModified: Date.now(),
  });
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

async function updateProfilePicture(file) {
  if (!file) return;
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (!allowedTypes.has(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG, GIF, or WEBP image under 5 MB.');
  }

  const formData = new FormData();
  formData.append('profile_picture', file);
  const payload = await api('/user/profile-picture', {
    method: 'POST',
    body: formData,
  });

  if (!payload?.user) {
    throw new Error('The avatar upload was accepted but the server did not return the updated profile.');
  }

  state.user = payload.user;
  localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
  render();
  renderProfileModal();
  showNotice('Profile picture updated.', 'success');
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
    if (form.id === 'create-group-form') await handleCreateGroup(form);
    if (form.id === 'add-group-member-form') await handleAddGroupMember(form);
    if (form.id === 'message-form') await handleSendMessage(form);
  } catch (error) {
    showNotice(error.message || 'Something went wrong. Please try again.');
  }
});

app.addEventListener('click', async (event) => {
  if (event.target.matches('.modal-backdrop')) {
    closeModal();
    return;
  }
  const imageButton = event.target.closest('[data-action="preview-image"]');
  if (imageButton) {
    showImagePreview(imageButton.dataset.imageUrl, imageButton.dataset.imageName || 'Shared image');
    return;
  }
  if (event.target.matches('.image-viewer') ||
    event.target.closest('[data-action="close-image-preview"]')) {
    closeImagePreview();
    return;
  }
  const picker = document.querySelector('#emoji-picker');
  if (picker && !picker.hidden && !picker.contains(event.target) &&
    !event.target.closest('[data-action="toggle-emoji-picker"]')) {
    closeEmojiPicker();
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'toggle-password-visibility') {
      const password = document.querySelector('#password');
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      button.setAttribute('title', visible ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(visible));
      button.classList.toggle('is-visible', visible);
      password.focus();
    } else if (action === 'toggle-auth') {
      state.authMode = state.authMode === 'login' ? 'signup' : 'login';
      render();
    } else if (action === 'toggle-sidebar-tool') {
      state.sidebarTool = state.sidebarTool === button.dataset.tool ? null : button.dataset.tool;
      renderSidebar();
      if (state.sidebarTool === 'search') {
        document.querySelector('#friend-search')?.focus();
      }
    } else if (action === 'open-profile') {
      renderProfileModal();
    } else if (action === 'open-group-members') {
      const conversation = state.conversations.find((item) =>
        String(item.id) === String(id) && item.type === 'group');
      if (!conversation) throw new Error('This group is no longer available.');
      renderGroupMembersModal(conversation);
    } else if (action === 'close-modal') {
      closeModal();
    } else if (action === 'choose-profile-picture') {
      document.querySelector('#profile-picture-input')?.click();
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
      state.replyTarget = null;
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
    } else if (action === 'reply-message') {
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      if (!message) throw new Error('This message is no longer available.');
      beginReply(message);
    } else if (action === 'cancel-reply') {
      state.replyTarget = null;
      updateReplyPreview();
    } else if (action === 'delete-message-for-me') {
      await handleDeleteMessage(button.dataset.messageId, 'me');
    } else if (action === 'delete-message-for-everyone') {
      await handleDeleteMessage(button.dataset.messageId, 'everyone');
    } else if (action === 'download-attachment') {
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      await downloadAttachment(message);
    } else if (action === 'respond-request') {
      await handleRequestResponse(button);
    } else if (action === 'unfriend') {
      await handleUnfriend(id);
    } else if (action === 'leave-group') {
      await handleLeaveGroup(id);
    } else if (action === 'remove-group-member') {
      await handleRemoveGroupMember(button.dataset.conversationId, button.dataset.userId, button);
    } else if (action === 'open-friend') {
      await openFriend(id);
    } else if (action === 'open-conversation') {
      await openGroupConversation(id);
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
  if (event.target.id === 'friend-phone') {
    state.addFriendPhone = event.target.value;
  }
  if (event.target.id === 'group-name') state.groupName = event.target.value;
  if (event.target.matches('#message-form textarea')) handleMessageTyping();
});

app.addEventListener('change', (event) => {
  if (event.target.matches('#create-group-form input[name="friend_ids"]')) {
    const friendId = String(event.target.value);
    if (event.target.checked) state.selectedGroupFriendIds.add(friendId);
    else state.selectedGroupFriendIds.delete(friendId);
    return;
  }
  if (event.target.id === 'profile-picture-input') {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file) return;
    void updateProfilePicture(file).catch((error) => {
      showNotice(error.message || 'The profile picture could not be updated.');
    });
    return;
  }

  if (event.target.id !== 'attachment-input') return;
  const file = event.target.files?.[0] || null;
  if (file) selectAttachment(file);
});

app.addEventListener('paste', (event) => {
  if (!event.target.matches('#message-form textarea')) return;
  try {
    const file = pastedImageFile(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    selectAttachment(file);
  } catch (error) {
    event.preventDefault();
    showNotice(error.message || 'The pasted image could not be attached.');
  }
});

app.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('.modal-backdrop')) {
    closeModal();
    return;
  }
  if (event.key === 'Escape' && state.previewImageUrl) {
    closeImagePreview();
    return;
  }
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
