'use strict';

const API_URL_KEY = 'daylight.apiUrl';
const TOKEN_KEY = 'daylight.authToken';
const USER_KEY = 'daylight.currentUser';
const SOCKET_URL_KEY = 'daylight.socketUrl';
const DEFAULT_API_URL = 'https://api.sanjakarobar.com/api';
const DEFAULT_SOCKET_URL = 'https://socket.sanjakarobar.com';
const REFRESH_INTERVAL = 5000;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const CACHED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TYPING_TIMEOUT = 1400;
const app = document.querySelector('#app');

const state = {
  apiUrl: normalizeApiUrl(localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL),
  socketUrl: localStorage.getItem(SOCKET_URL_KEY) || DEFAULT_SOCKET_URL,
  token: localStorage.getItem(TOKEN_KEY),
  user: readStoredUser(),
  authMode: 'login',
  friends: [],
  requests: [],
  conversations: [],
  selectedConversationId: null,
  messages: [],
  selectedAttachment: null,
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

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
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
  state.messages = [];
  state.selectedAttachment = null;
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
          <div class="brand-lockup"><span class="brand-mark">d</span><span>daylight</span></div>
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
            ${isSignup ? 'Already have an account?' : 'New to Daylight?'}
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
        </section>
      </div>
    </section>`;
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
    <div class="app-shell">
      <aside class="rail">
        <header class="rail-brand">
          <div class="brand-lockup"><span class="brand-mark">d</span><span>daylight</span></div>
          <button class="icon-button" type="button" data-action="refresh" title="Refresh" aria-label="Refresh">↻</button>
        </header>
        <div class="section-head"><h2>Friend requests</h2><span class="counter" id="request-count">0</span></div>
        <div class="request-list" id="request-list"></div>
        <div class="section-head"><h2>Your friends</h2><span class="section-label">Phone</span></div>
        <form class="add-friend" id="add-friend-form">
          <input name="phone" type="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" placeholder="+1 555 123 4567" aria-label="Friend's phone number" required />
          <button type="submit" title="Send friend request" aria-label="Send friend request">+</button>
        </form>
        <div class="friend-list" id="friend-list"></div>
        <div class="profile">
          ${friendAvatar(state.user, 'sm')}
          <div class="person-info"><div class="person-name">${escapeHtml(state.user.name)}</div><div class="person-sub">${escapeHtml(state.user.phone)}</div></div>
          <button class="logout-button" type="button" data-action="logout">Sign out</button>
        </div>
      </aside>
      <section class="panel">
        <div class="panel-top">
          <h2>Messages</h2>
          <p>Your conversations with friends.</p>
          <label class="search-box"><span aria-hidden="true">⌕</span><input id="conversation-search" type="search" placeholder="Search conversations" aria-label="Search conversations" /></label>
        </div>
        <div class="conversation-list" id="conversation-list"></div>
      </section>
      <section class="chat-panel" id="chat-panel"></section>
    </div>`;

  renderSidebar();
  renderConversationList();
  renderThread();
}

function renderSidebar() {
  const requestList = document.querySelector('#request-list');
  const requestCount = document.querySelector('#request-count');
  const friendList = document.querySelector('#friend-list');
  if (!requestList || !friendList || !requestCount) return;

  requestCount.textContent = String(state.requests.length);
  requestList.innerHTML = state.requests.length
    ? state.requests.map((request) => `
      <div class="request-row">
        ${friendAvatar(request.user)}
        <div class="request-info"><div class="person-name">${escapeHtml(request.user?.name)}</div><div class="person-sub">${escapeHtml(request.user?.phone)}</div></div>
        <div class="request-actions">
          <button type="button" data-action="respond-request" data-id="${escapeHtml(request.id)}" data-response="accept" title="Accept request" aria-label="Accept ${escapeHtml(request.user?.name)}">✓</button>
          <button type="button" class="reject" data-action="respond-request" data-id="${escapeHtml(request.id)}" data-response="reject" title="Reject request" aria-label="Reject ${escapeHtml(request.user?.name)}">×</button>
        </div>
      </div>`).join('')
    : '<div class="empty-list">No new requests. Add a friend by phone number to get started.</div>';

  friendList.innerHTML = state.friends.length
    ? state.friends.map((friend) => `
      <button class="friend-item ${String(selectedConversation()?.friend?.id) === String(friend.id) ? 'active' : ''}" type="button" data-action="open-friend" data-id="${escapeHtml(friend.id)}" aria-label="Chat with ${escapeHtml(friend.name)}">
        ${friendAvatar(friend, 'sm', true)}
        <span class="person-info"><span class="person-name">${escapeHtml(friend.name)}</span><span class="person-sub">${escapeHtml(friend.phone)}</span><span class="presence-label ${state.socketConnected && isOnline(friend.id) ? 'online' : ''}" data-presence-label="${escapeHtml(friend.id)}">${presenceText(friend.id)}</span></span>
        <span class="friend-open">Chat</span>
      </button>`).join('')
    : '<div class="empty-list">Accepted friends will show up here. Add someone using their phone number above.</div>';
}

function renderConversationList() {
  const list = document.querySelector('#conversation-list');
  if (!list) return;
  const filter = (document.querySelector('#conversation-search')?.value || '').trim().toLowerCase();
  const conversations = state.conversations.filter((conversation) =>
    !filter || `${conversation.friend?.name || ''} ${conversation.last_message?.body || conversation.last_message?.attachment?.name || ''}`.toLowerCase().includes(filter));

  list.innerHTML = conversations.length
    ? conversations.map((conversation) => `
      <button class="conversation-item ${String(conversation.id) === String(state.selectedConversationId) ? 'active' : ''}" type="button" data-action="select-conversation" data-id="${escapeHtml(conversation.id)}">
        ${friendAvatar(conversation.friend, 'lg', true)}
        <span class="person-info">
          <span class="person-name">${escapeHtml(conversation.friend?.name)}</span>
          <span class="conversation-preview">${escapeHtml(conversation.last_message?.body || conversation.last_message?.attachment?.name || 'Start a conversation')}</span>
        </span>
        <span class="conversation-meta">${formattedTime(conversation.last_message?.created_at || conversation.updated_at)}
          ${conversation.unread_count ? `<span class="counter">${escapeHtml(conversation.unread_count)}</span>` : ''}
        </span>
      </button>`).join('')
    : '<div class="empty-list">No conversations yet. Choose a friend to say hello.</div>';
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
      <form class="composer" id="message-form">
        <textarea class="compose-input" name="body" rows="1" maxlength="10000" placeholder="Write a message…" aria-label="Write a message"></textarea>
        <input id="attachment-input" type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt" hidden>
        <button class="attach-button" type="button" data-action="choose-attachment" aria-label="Attach a file" title="Attach a file">＋</button>
        <button class="send-button" type="submit" aria-label="Send message">➤</button>
      </form>
      <p class="composer-hint" id="attachment-status" aria-live="polite">Press Enter to send · Shift + Enter for a new line. Attachments: 5 MiB max.</p>
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
        <span class="call-status">${escapeHtml(call.phase === 'active' ? 'Connected' : call.phase === 'connecting' ? 'Connecting…' : incoming ? 'Ringing' : 'Waiting')}</span>
      </header>
      ${video ? `<div class="call-video-grid">
        <video id="call-remote-video" autoplay playsinline></video>
        <video id="call-local-video" autoplay muted playsinline></video>
      </div>` : '<div class="call-avatar" aria-hidden="true">☎</div><audio id="call-remote-audio" autoplay></audio>'}
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
  if (remoteVideo && state.remoteStream) remoteVideo.srcObject = state.remoteStream;
  const remoteAudio = overlay.querySelector('#call-remote-audio');
  if (remoteAudio && state.remoteStream) remoteAudio.srcObject = state.remoteStream;
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
  if (markRead && state.messages.some((message) =>
    String(message.sender?.id) !== String(state.user.id) && !message.read_at)) {
    await api(`/conversations/${encodeURIComponent(conversation.id)}/read`, { method: 'POST' });
    state.messages = await api(`/conversations/${encodeURIComponent(conversation.id)}/messages`)
      .then((result) => Array.isArray(result.data) ? result.data : []);
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
    renderConversationList();

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
  renderConversationList();
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
  peer.ontrack = ({ streams }) => {
    state.remoteStream = streams[0] || state.remoteStream;
    renderCallOverlay();
  };
  peer.onconnectionstatechange = () => {
    if (state.call?.id !== call.id) return;
    if (peer.connectionState === 'connected') updateCall({ phase: 'active' });
    if (peer.connectionState === 'failed') {
      void sendCallEvent('call:end', { call_id: call.id });
      stopCall('The call connection failed. Check your network and try again.');
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
  state.selectedConversationId = conversation.id;
  state.messages = [];
  render();
  joinSelectedConversation();
  await loadMessages();
  renderMessages();
  renderConversationList();
}

async function handleAuthSubmit(form) {
  const formData = new FormData(form);
  const body = Object.fromEntries(formData.entries());
  body.device_name = 'daylight-desktop';
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
      ? `${state.selectedAttachment.name} · ${formatFileSize(state.selectedAttachment.size)} (5 MiB max)`
      : 'Press Enter to send · Shift + Enter for a new line. Attachments: 5 MiB max.';
  }
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
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  try {
    if (action === 'toggle-auth') {
      state.authMode = state.authMode === 'login' ? 'signup' : 'login';
      render();
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
    } else if (action === 'download-attachment') {
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      await downloadAttachment(message);
    } else if (action === 'respond-request') {
      await handleRequestResponse(button);
    } else if (action === 'open-friend') {
      await openFriend(id);
    } else if (action === 'select-conversation') {
      if (state.activeRoomId && String(state.activeRoomId) !== String(id)) {
        window.chatSocket?.leaveConversation(state.activeRoomId);
        state.activeRoomId = null;
        state.joinedRoomId = null;
      }
      stopLocalTyping();
      clearTypingIndicator();
      state.selectedConversationId = id;
      state.messages = [];
      state.selectedAttachment = null;
      renderThread();
      renderConversationList();
      joinSelectedConversation();
      await loadMessages();
      renderMessages();
      await refreshData();
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
  if (event.target.id === 'conversation-search') renderConversationList();
  if (event.target.matches('#message-form textarea')) handleMessageTyping();
});

app.addEventListener('change', (event) => {
  if (event.target.id !== 'attachment-input') return;
  const file = event.target.files?.[0] || null;
  if (file && file.size > MAX_ATTACHMENT_SIZE) {
    event.target.value = '';
    state.selectedAttachment = null;
    updateAttachmentStatus();
    showNotice('Attachments must be 5 MiB or smaller.');
    return;
  }
  state.selectedAttachment = file;
  updateAttachmentStatus();
});

app.addEventListener('keydown', (event) => {
  if (event.target.matches('#message-form textarea') && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

window.chatSocket?.onEvent(handleSocketEvent);

if (state.token && state.user) {
  render();
  refreshData().then(startPolling);
  connectSocket();
} else {
  render();
}
