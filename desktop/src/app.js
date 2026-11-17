'use strict';

const API_URL_KEY = 'dailyconnect.apiUrl';
const TOKEN_KEY = 'dailyconnect.authToken';
const USER_KEY = 'dailyconnect.currentUser';
const SOCKET_URL_KEY = 'dailyconnect.socketUrl';
const SETTINGS_KEY = 'dailyconnect.settings';
const DEFAULT_SETTINGS = { notifications: true, blurMessages: false };
const DEFAULT_API_URL = 'https://api.sanjakarobar.com/api';
const DEFAULT_SOCKET_URL = 'https://socket.sanjakarobar.com';
// DailyConnect logo: a blue squircle with two overlapping chat bubbles.
// Kept inline so it scales crisply and needs no asset load in the renderer.
const BRAND_LOGO = `<svg class="brand-logo" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <defs><linearGradient id="dc-bg" x1="4" y1="2" x2="44" y2="46" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#3b93e3"/><stop offset="1" stop-color="#1b5b9b"/></linearGradient></defs>
  <rect width="48" height="48" rx="12" fill="url(#dc-bg)"/>
  <path d="M28 9h7a5 5 0 0 1 5 5v5a5 5 0 0 1-5 5h-1.5l.5 4-4.8-4H29a5 5 0 0 1-5-5" fill="#ffffff" opacity=".42"/>
  <path d="M13 14h17a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5H19l-6.2 4.6.6-4.6H13a5 5 0 0 1-5-5v-8a5 5 0 0 1 5-5z" fill="#ffffff"/>
  <circle cx="16.5" cy="23" r="2.1" fill="#2878c7"/><circle cx="23.5" cy="23" r="2.1" fill="#2878c7"/><circle cx="30.5" cy="23" r="2.1" fill="#2878c7"/>
</svg>`;
// Background sync. With the realtime socket connected, messages arrive
// instantly, so polling only catches up on friend requests and receipts.
const REFRESH_INTERVAL = 5000;
const CONNECTED_REFRESH_INTERVAL = 30000;
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
// Messages per request: a chat opens with the newest page, and older pages load
// as you scroll up.
const MESSAGE_PAGE_SIZE = 30;
const DEFAULT_MESSAGE_EDIT_MINUTES = 5;
// Must match User::MESSAGE_EDIT_MINUTE_OPTIONS in the API; 0 turns editing off.
const MESSAGE_EDIT_MINUTE_OPTIONS = [0, 1, 2, 5, 10, 15, 30, 60];
const MAX_VOICE_SECONDS = 300;
// Protected messages: 20 characters from a 32-symbol alphabet without look-alike
// characters (no I, O, 0, 1) gives 100 bits of randomness, far beyond what can
// be guessed even by someone holding the stored ciphertext.
const PROTECTED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PROTECTED_PASSWORD_LENGTH = 20;
const PROTECTED_KDF_ITERATIONS = 600000;
const MAX_PROTECTED_LENGTH = 2000;
const MIN_VOICE_MILLISECONDS = 1000;
const VOICE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
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
  socketUrl: DEFAULT_SOCKET_URL,
  token: readStoredValue(TOKEN_KEY, 'daylight.authToken'),
  user: readStoredUser(),
  authMode: 'login',
  forgotStage: 'request',
  forgotPhone: '',
  forgotEmailHint: '',
  friends: [],
  blockedUsers: [],
  callHistory: [],
  callHistoryPage: 0,
  callHistoryLastPage: 1,
  callHistoryLoading: false,
  callHistoryError: '',
  requests: [],
  sidebarTool: null,
  friendSearchQuery: '',
  addFriendPhone: '',
  groupName: '',
  selectedGroupFriendIds: new Set(),
  groupFriendQuery: '',
  conversations: [],
  groupMembershipRevisions: new Map(),
  unreadCount: null,
  unreadByConversation: null,
  settings: readSettings(),
  selectedConversationId: null,
  messages: [],
  // How far each member has read the selected conversation (from the API).
  readCursors: [],
  pinnedMessages: [],
  // 'chats' = friends and groups; 'others' = chats with people who are not friends.
  chatListTab: 'chats',
  pinIndex: 0,
  callHistoryFilter: 'all',
  latestMissedCallId: 0,
  messagesLoading: false,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  replyTarget: null,
  editTarget: null,
  selectedAttachment: null,
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
  refreshPending: false,
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
  groupPeers: new Map(),
  recentGroupCallIds: new Set(),
  // Message search. Messages are end-to-end encrypted, so they are searched in
  // a local index of decrypted messages that lives only for this session.
  searchIndex: new Map(),
  chatSearch: { open: false, conversationId: null, query: '', status: '', html: '' },
  chatSearchToken: 0,
  globalSearch: { query: '', status: '', html: '' },
  globalSearchToken: 0,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  voiceRecording: null,
  voicePlayer: null,
  voiceBlobUrls: new Map(),
  unlockedMessages: new Map(),
  // Messages this device is sending or has just sent, keyed by a temporary id,
  // so they stay visible until a reload from the server includes them.
  outgoing: new Map(),
  sendQueue: Promise.resolve(),
  // Message encryption: imported AES keys by "conversationId:version", the newest
  // version per conversation, in-flight key requests, and decrypted content.
  conversationKeys: new Map(),
  latestKeyVersions: new Map(),
  keyRequests: new Map(),
  decryptedContent: new Map(),
};

// Line icons for the left navigation (24px grid, drawn with currentColor).
const NAV_ICONS = {
  chats: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.4-4.9A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8.5 10h7M8.5 13.5h4.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
  addFriend: '<circle cx="9.5" cy="8" r="4"/><path d="M2.5 20.5v-.5a7 7 0 0 1 11.2-5.6"/><path d="M19 14v6.5M15.75 17.25h6.5"/>',
  group: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5V20a6.5 6.5 0 0 1 13 0v.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8v.5"/>',
  calls: '<path d="M7.2 3.8 9.5 3.3a1.6 1.6 0 0 1 1.8 1.1l.8 2.8a1.6 1.6 0 0 1-.7 1.8l-1.6 1.1a14 14 0 0 0 4.1 4.1l1.1-1.6a1.6 1.6 0 0 1 1.8-.7l2.8.8a1.6 1.6 0 0 1 1.1 1.8l-.5 2.3a2 2 0 0 1-2 1.6A15.5 15.5 0 0 1 5.6 5.8a2 2 0 0 1 1.6-2Z"/>',
  requests: '<path d="M21.5 12.5h-5.5l-2 3h-4l-2-3H2.5"/><path d="M5.6 5.2 2.5 12.5v5.5a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-5.5l-3.1-7.3A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.8 1.2Z"/>',
  blocked: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.5L3.5 9"/><path d="M3.5 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.5l1.9-2.5"/><path d="M20.5 20v-5h-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  updates: '<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>',
};

function navIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[name]}</svg>`;
}

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

function readSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      notifications: typeof stored.notifications === 'boolean' ? stored.notifications : DEFAULT_SETTINGS.notifications,
      blurMessages: typeof stored.blurMessages === 'boolean' ? stored.blurMessages : DEFAULT_SETTINGS.blurMessages,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    showNotice('Settings could not be saved on this computer; they will reset when the app restarts.');
  }
  applySettings();
}

function applySettings() {
  document.body.classList.toggle('blur-messages', state.settings.blurMessages);
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
    String(state.joinedRoomId) === String(state.selectedConversationId)) &&
    !isReadOnly(selectedConversation());
  document.querySelectorAll('[data-action="call-audio"], [data-action="call-video"]')
    .forEach((button) => {
      button.disabled = !available;
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

function linkifyMessageText(value) {
  const text = String(value ?? '');
  const urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s<>"']*)?/gi;
  let html = '';
  let lastIndex = 0;
  let match;

  while ((match = urlPattern.exec(text)) !== null) {
    let url = match[0];
    let trailing = '';
    while (/[),.!?;:]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }

    let normalizedUrl;
    try {
      normalizedUrl = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).href;
    } catch {
      continue;
    }
    if (!/^https?:$/.test(new URL(normalizedUrl).protocol)) continue;

    html += `${escapeHtml(text.slice(lastIndex, match.index))}<a class="message-link" href="#" data-action="open-external-link" data-url="${escapeHtml(normalizedUrl)}">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
    lastIndex = match.index + match[0].length;
  }

  return html + escapeHtml(text.slice(lastIndex));
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

function formatCallDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function messagePreview(message, fallback = '') {
  if (message?.type === 'call' && message.call) {
    const mediaName = message.call.media_type === 'video' ? 'video' : 'voice';
    // A missed call you placed (unanswered, declined or cancelled) is "no answer" for you.
    const outgoing = String(message.sender?.id) === String(state.user?.id);
    return message.call.status === 'missed'
      ? (outgoing ? `${mediaName === 'video' ? 'Video' : 'Voice'} call · No answer` : `Missed ${mediaName} call`)
      : `${mediaName === 'video' ? 'Video' : 'Voice'} call · ${formatCallDuration(message.call.duration_seconds)}`;
  }
  if (message?.type === 'protected') return '🔒 Protected message';
  if (message?.type === 'voice') {
    return message.voice ? `🎤 Voice message (${formatCallDuration(message.voice.duration_seconds)})` : '🎤 Voice message';
  }
  return message?.body || message?.attachment?.name || fallback;
}

// One-line description of a message for reply quotes and dialogs.
function messageSummary(message) {
  if (!message) return 'Attachment';
  if (message.unavailable) return 'Original message unavailable';
  if (message.deleted_for_everyone_at) return 'This message was deleted';
  if (message.type === 'voice') return '🎤 Voice message';
  if (message.type === 'protected') return '🔒 Protected message';
  return message.body || message.attachment?.name || 'Attachment';
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
  } catch (error) {
    // Surface the real failure (DNS / TLS / CORS / wrong URL) in DevTools so it
    // can be diagnosed, instead of always blaming the connection.
    console.error(`API request failed: ${options.method || 'GET'} ${state.apiUrl}${path}`, error);
    throw new Error(`API server is not reachable (${error?.message || 'network error'}). Tried ${state.apiUrl}${path} — check the API URL in Settings and your connection.`);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.token) {
      clearSession();
      render();
    }
    const message = apiErrorMessage(payload, response.status);
    if (
      path === '/friends/requests' &&
      (response.status === 404 || /no query results for model|modelnotfoundexception|friend not found|user not found/i.test(message))
    ) {
      throw new Error('This person does not exist or cannot be added.');
    }
    throw new Error(message);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Message encryption
//
// Every conversation has a random AES-256 key that the API hands to its members
// (any signed-in device, no password needed). Message text, captions, and file
// details are encrypted here before upload, and each file is encrypted with its
// own random key that travels inside the encrypted message. The database and
// file storage only ever hold ciphertext. The format is shared with the mobile app:
//   body      = {"v":1,"iv":<base64>,"ct":<base64>}   AES-256-GCM with the
//               conversation key, additional data "pitbconnect:<conversation>:<version>"
//   plaintext = {"text": string|null, "file": {name, mime, size, key, iv} | null}
//   file      = AES-256-GCM with the file key and iv, no additional data
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const UNDECRYPTABLE_TEXT = '⚠ This message could not be decrypted.';

async function rememberConversationKeys(keys) {
  await Promise.all((Array.isArray(keys) ? keys : []).map(async (item) => {
    const conversationId = String(item.conversation_id);
    const version = Number(item.version);
    const mapKey = `${conversationId}:${version}`;
    if (!state.conversationKeys.has(mapKey)) {
      state.conversationKeys.set(mapKey, await crypto.subtle.importKey(
        'raw', base64ToBytes(item.key), 'AES-GCM', false, ['encrypt', 'decrypt'],
      ));
    }
    if (version > (state.latestKeyVersions.get(conversationId) || 0)) {
      state.latestKeyVersions.set(conversationId, version);
    }
  }));
}

function fetchConversationKeys(conversationId) {
  const id = String(conversationId);
  if (!state.keyRequests.has(id)) {
    state.keyRequests.set(id, api(`/conversations/${encodeURIComponent(id)}/keys`)
      .then((result) => rememberConversationKeys(result.data))
      .finally(() => state.keyRequests.delete(id)));
  }
  return state.keyRequests.get(id);
}

async function conversationKey(conversationId, version) {
  const mapKey = `${conversationId}:${version}`;
  if (!state.conversationKeys.has(mapKey)) await fetchConversationKeys(conversationId);
  const key = state.conversationKeys.get(mapKey);
  if (!key) throw new Error('The encryption key for this conversation is not available.');
  return key;
}

function encryptionContext(conversationId, version) {
  // IMPORTANT: this AAD prefix is a cross-client protocol constant shared with
  // the mobile app and existing stored ciphertext. It must stay "pitbconnect"
  // regardless of the app's display name, or messages fail to decrypt.
  return textEncoder.encode(`pitbconnect:${conversationId}:${version}`);
}

async function encryptMessageContent(conversationId, content, refreshKeys = false) {
  const id = String(conversationId);
  if (refreshKeys || !state.latestKeyVersions.has(id)) await fetchConversationKeys(id);
  const version = state.latestKeyVersions.get(id);
  if (!version) throw new Error('This conversation has no encryption key yet. Refresh and try again.');
  const key = await conversationKey(id, version);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify({ text: content.text ?? null, file: content.file ?? null }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encryptionContext(id, version) }, key, plaintext,
  );
  return {
    encrypted: true,
    key_version: version,
    body: JSON.stringify({ v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ciphertext)) }),
  };
}

// Encrypts and sends; if the server reports that the conversation has a newer
// key (someone left a group), refreshes the keys and tries once more.
async function sendEncrypted(conversationId, content, send) {
  try {
    return await send(await encryptMessageContent(conversationId, content));
  } catch (error) {
    if (!/newer encryption key/i.test(error.message || '')) throw error;
    return send(await encryptMessageContent(conversationId, content, true));
  }
}

async function decryptMessageContent(conversationId, version, body) {
  const envelope = JSON.parse(body);
  if (envelope?.v !== 1) throw new Error('Unsupported encryption format.');
  const key = await conversationKey(String(conversationId), version);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData: encryptionContext(String(conversationId), version) },
    key,
    base64ToBytes(envelope.ct),
  );
  const content = JSON.parse(textDecoder.decode(plaintext));
  return {
    text: typeof content?.text === 'string' ? content.text : null,
    file: content?.file && typeof content.file === 'object' ? content.file : null,
  };
}

async function encryptFileBytes(bytes) {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { data: new Uint8Array(ciphertext), key: bytesToBase64(rawKey), iv: bytesToBase64(iv) };
}

async function decryptFileBytes(bytes, attachment) {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(attachment.fileKey), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(attachment.fileIv) }, key, bytes));
}

async function decryptedContentFor(conversationId, item) {
  const cacheKey = `${conversationId}|${item.key_version}|${item.body}`;
  const cached = state.decryptedContent.get(cacheKey);
  if (cached) return cached;
  try {
    const content = await decryptMessageContent(conversationId, item.key_version, item.body);
    if (state.decryptedContent.size >= 5000) state.decryptedContent.clear();
    state.decryptedContent.set(cacheKey, content);
    return content;
  } catch {
    return null;
  }
}

// Turns an encrypted message from the API into the plain shape the rest of the
// app works with. File keys stay on the attachment so downloads can be decrypted.
async function decryptForDisplay(conversationId, message) {
  if (!message) return message;
  let result = message;
  if (message.encrypted && message.body) {
    const content = await decryptedContentFor(conversationId, message);
    result = content
      ? {
        ...message,
        body: content.text,
        attachment: message.attachment && content.file ? {
          name: String(content.file.name || 'attachment'),
          mime: String(content.file.mime || 'application/octet-stream'),
          size: Number(content.file.size) || message.attachment.size,
          encrypted: true,
          fileKey: content.file.key,
          fileIv: content.file.iv,
        } : message.attachment,
      }
      : { ...message, body: UNDECRYPTABLE_TEXT, attachment: null, decryption_failed: true };
  }
  const reply = result.reply_to;
  if (reply?.key_version && reply.body) {
    const content = await decryptedContentFor(conversationId, reply);
    result = {
      ...result,
      reply_to: content
        ? { ...reply, body: content.text, attachment: content.file ? { name: String(content.file.name || 'attachment') } : reply.attachment }
        : { ...reply, body: UNDECRYPTABLE_TEXT, attachment: null },
    };
  }
  return result;
}

function decryptMessagesForDisplay(conversationId, messages) {
  return Promise.all(messages.map((message) => decryptForDisplay(conversationId, message)));
}

function decryptConversationPreviews(conversations) {
  return Promise.all(conversations.map(async (conversation) => conversation.last_message
    ? { ...conversation, last_message: await decryptForDisplay(conversation.id, conversation.last_message) }
    : conversation));
}

function attachmentExtensionAllowed(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase();
  return Boolean(extension && ALLOWED_ATTACHMENT_EXTENSIONS.has(extension));
}

async function downloadAttachment(message) {
  const conversation = selectedConversation();
  if (!conversation || !message?.attachment) return;
  if (message.attachment.encrypted && !attachmentExtensionAllowed(message.attachment.name)) {
    throw new Error(`"${message.attachment.name}" is not an allowed file type, so it was not downloaded.`);
  }

  const blob = await fetchAttachmentBlob(conversation.id, message);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attachment-${message.id}.${message.attachment.name.split('.').pop()}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchAttachmentBlob(conversationId, message) {
  const messageId = message.id;
  let response;
  try {
    response = await fetch(
      `${state.apiUrl}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachment`,
      { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${state.token}` } },
    );
  } catch (error) {
    console.error(`Attachment fetch failed: ${state.apiUrl}/conversations/${conversationId}/messages/${messageId}/attachment`, error);
    throw new Error(`API server is not reachable (${error?.message || 'network error'}). Please check your connection and try again.`);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && state.token) {
      clearSession();
      render();
    }
    throw new Error(apiErrorMessage(payload, response.status));
  }

  const blob = await response.blob();
  if (!message.attachment?.fileKey) return blob;
  try {
    const bytes = await decryptFileBytes(new Uint8Array(await blob.arrayBuffer()), message.attachment);
    return new Blob([bytes], { type: message.attachment.mime || 'application/octet-stream' });
  } catch {
    throw new Error(`"${message.attachment.name}" could not be decrypted.`);
  }
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
      const blob = await fetchAttachmentBlob(conversationId, message);
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
  cancelVoiceRecording();
  releaseVoiceBlobs();
  state.unlockedMessages.clear();
  state.outgoing.clear();
  state.sendQueue = Promise.resolve();
  state.conversationKeys.clear();
  state.latestKeyVersions.clear();
  state.keyRequests.clear();
  state.decryptedContent.clear();
  state.searchIndex.clear();
  state.chatSearch = { open: false, conversationId: null, query: '', status: '', html: '' };
  state.globalSearch = { query: '', status: '', html: '' };
  state.chatSearchToken += 1;
  state.globalSearchToken += 1;
  state.token = null;
  state.user = null;
  state.friends = [];
  state.requests = [];
  state.callHistory = [];
  state.callHistoryPage = 0;
  state.callHistoryLastPage = 1;
  state.callHistoryError = '';
  state.callHistoryLoading = false;
  state.conversations = [];
  state.unreadCount = null;
  state.unreadByConversation = null;
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

function storeUser(user) {
  state.user = user;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function messageEditMinutes() {
  const minutes = Number(state.user?.message_edit_minutes);
  return Number.isInteger(minutes) && minutes >= 0 ? minutes : DEFAULT_MESSAGE_EDIT_MINUTES;
}

// Whether the edit option should be offered; the API makes the final decision.
function canEditMessage(message) {
  const minutes = messageEditMinutes();
  return minutes > 0 &&
    !message.pending &&
    message.type === 'text' &&
    !message.deleted_for_everyone_at &&
    String(message.sender?.id) === String(state.user?.id) &&
    Date.now() - Date.parse(message.created_at) < minutes * 60_000;
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

const PASSWORD_EYE_SVGS = `
  <svg class="password-eye-closed" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a15.7 15.7 0 0 1-3.1 3.9"/><path d="M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.5 10.5 0 0 0 4-.8"/></svg>
  <svg class="password-eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`;

function showAuthForgot() {
  const verifying = state.forgotStage === 'verify';
  return `
    <section class="auth-screen">
      <div class="auth-card">
        <section class="auth-content">
          <div class="brand-lockup"><span class="brand-mark">${BRAND_LOGO}</span><span>DailyConnect</span></div>
          <h2>Reset password</h2>
          ${verifying ? `
          <p class="auth-hint">We sent a 6-digit code to ${state.forgotEmailHint
            ? `<strong>${escapeHtml(state.forgotEmailHint)}</strong>`
            : 'the email on file for this number'}. Enter it below with your new password. The code expires in 15 minutes.</p>
          <form id="reset-password-form" class="form-grid">
            <input type="hidden" name="phone" value="${escapeHtml(state.forgotPhone)}" />
            <div class="field"><label for="reset-code">Reset code</label><input id="reset-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code" title="Enter the 6-digit code from the email" required /></div>
            <div class="field">
              <label for="reset-password">New password</label>
              <div class="password-input-wrap">
                <input id="reset-password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="At least 8 characters" required />
                <button class="password-visibility" type="button" data-action="toggle-field-visibility" data-target="reset-password" aria-label="Show password" title="Show password" aria-pressed="false">${PASSWORD_EYE_SVGS}</button>
              </div>
            </div>
            <button class="primary-button auth-submit" type="submit">Set new password</button>
          </form>
          <p class="switch-auth"><button class="text-button" type="button" data-action="forgot-resend">Didn’t get a code? Send again</button></p>
          ` : `
          <p class="auth-hint">Enter your phone number and we’ll email a reset code to the address on your account.</p>
          <form id="forgot-password-form" class="form-grid">
            <div class="field"><label for="forgot-phone">Phone number</label><input id="forgot-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" value="${escapeHtml(state.forgotPhone)}" placeholder="+15551234567" title="Use international format, for example +15551234567" required /></div>
            <button class="primary-button auth-submit" type="submit">Send reset code</button>
          </form>
          `}
          <p class="switch-auth">Remembered it? <button class="text-button" type="button" data-action="back-to-login">Back to sign in</button></p>
        </section>
      </div>
    </section>`;
}

function showAuth() {
  if (state.authMode === 'forgot') {
    app.innerHTML = showAuthForgot();
    return;
  }
  const isSignup = state.authMode === 'signup';
  app.innerHTML = `
    <section class="auth-screen">
      <div class="auth-card">
        <section class="auth-content">
          <div class="brand-lockup"><span class="brand-mark">${BRAND_LOGO}</span><span>DailyConnect</span></div>
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
                <button class="password-visibility" type="button" data-action="toggle-password-visibility" aria-label="Show password" title="Show password" aria-pressed="false">${PASSWORD_EYE_SVGS}</button>
              </div>
            </div>
            ${isSignup ? '' : '<p class="auth-forgot"><button class="text-button" type="button" data-action="forgot-password">Forgot password?</button></p>'}
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
      <span class="app-version" id="app-version">${state.appVersion ? `DailyConnect v${escapeHtml(state.appVersion)}` : 'DailyConnect'}</span>
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

function userProfileButton(user, size = 'sm', withPresence = false) {
  if (!user?.id) return friendAvatar(user, size, withPresence);
  return `<button class="user-profile-trigger" type="button" data-action="open-user-profile" data-id="${escapeHtml(user.id)}" aria-label="View ${escapeHtml(user.name || 'user')}'s profile" title="View profile">${friendAvatar(user, size, withPresence)}</button>`;
}

function userForProfile(userId) {
  const key = String(userId);
  if (String(state.user?.id) === key) return state.user;
  const users = [
    ...state.friends,
    ...state.blockedUsers,
    ...state.requests.map((request) => request.user),
    ...state.conversations.flatMap((conversation) => [
      conversation.friend,
      ...(conversation.participants || []),
    ]),
    ...state.callHistory.map((call) => call.contact),
    ...state.messages.map((message) => message.sender),
  ];
  return users.find((user) => String(user?.id) === key) || null;
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
  if (conversation.icon_url) {
    return `<img class="avatar ${size} avatar-image" src="${escapeHtml(conversation.icon_url)}" alt="${escapeHtml(conversation.name || 'Group')}" loading="lazy" decoding="async">`;
  }
  return `<span class="avatar ${size} group-avatar" aria-label="Group">${escapeHtml(initials(conversation.name))}</span>`;
}

function messageAvatar(message) {
  const conversation = selectedConversation();
  if (conversation?.type !== 'group') {
    return userProfileButton(conversation?.friend, 'message-avatar');
  }
  const sender = conversation.participants?.find((participant) =>
    String(participant.id) === String(message.sender?.id));
  return userProfileButton(sender || message.sender, 'message-avatar');
}

function showChatShell() {
  app.innerHTML = `
    <div class="app-shell ${state.selectedConversationId ? 'chat-open' : ''}">
      <nav class="app-nav" aria-label="Main navigation">
        <div class="app-nav-primary">
          <span class="app-nav-brand brand-mark" aria-label="DailyConnect">${BRAND_LOGO}</span>
          <button class="app-nav-button" type="button" data-action="show-friends" aria-label="Chats" title="Chats">${navIcon('chats')}</button>
          <button class="app-nav-button" type="button" data-action="toggle-sidebar-tool" data-tool="search" aria-label="Search" aria-expanded="false" title="Search">${navIcon('search')}</button>
          <button class="app-nav-button" type="button" data-action="toggle-sidebar-tool" data-tool="add" aria-label="Add a friend" aria-expanded="false" title="Add a friend">${navIcon('addFriend')}</button>
          <button class="app-nav-button" type="button" data-action="open-create-group" aria-label="Create a group" aria-haspopup="dialog" title="Create a group">${navIcon('group')}</button>
          <button class="app-nav-button" type="button" data-action="toggle-sidebar-tool" data-tool="calls" aria-label="Call history" aria-expanded="false" title="Call history">${navIcon('calls')}<span class="tool-badge" id="missed-call-count" hidden></span></button>
          <button class="app-nav-button request-tool" type="button" data-action="toggle-sidebar-tool" data-tool="requests" aria-label="Friend requests" aria-expanded="false" title="Friend requests">${navIcon('requests')}<span class="tool-badge" id="request-count" hidden></span></button>
          <button class="app-nav-button" type="button" data-action="toggle-sidebar-tool" data-tool="blocked" aria-label="Blocked users" aria-expanded="false" title="Blocked users">${navIcon('blocked')}</button>
        </div>
        <div class="app-nav-secondary">
          <button class="app-nav-button" type="button" data-action="refresh" aria-label="Sync chats" title="Sync chats">${navIcon('sync')}</button>
          <button class="app-nav-button" type="button" data-action="toggle-sidebar-tool" data-tool="settings" aria-label="Settings" aria-expanded="false" title="Settings">${navIcon('settings')}</button>
          <button class="app-nav-button" type="button" data-action="toggle-sidebar-tool" data-tool="updates" aria-label="App updates" aria-expanded="false" title="App updates">${navIcon('updates')}</button>
        </div>
      </nav>
      <aside class="rail">
        <div class="sidebar-tools" id="sidebar-tools" hidden></div>
        <div class="friend-list-heading">
          <div class="chat-list-tabs" role="tablist" aria-label="Chat lists">
            <button type="button" role="tab" data-action="chat-list-tab" data-tab="chats" aria-selected="true" class="active">Chats<span class="unread-total" id="unread-message-count" hidden></span></button>
            <button type="button" role="tab" data-action="chat-list-tab" data-tab="others" aria-selected="false" title="Chats with people who are not your friends">Others<span class="unread-total" id="others-unread-count" hidden></span></button>
          </div>
        </div>
        <div class="friend-list" id="friend-list"></div>
        <div class="profile">
          <button class="profile-avatar-button" type="button" data-action="open-profile" aria-label="Open profile" title="Your profile · change picture">
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
  const chatsButton = document.querySelector('.app-nav-button[data-action="show-friends"]');
  if (chatsButton) chatsButton.classList.toggle('active', !state.sidebarTool);
  toolsPanel.hidden = !state.sidebarTool;
  const focusedInput = document.activeElement instanceof HTMLInputElement &&
    toolsPanel.contains(document.activeElement) &&
    document.activeElement.id
    ? {
      id: document.activeElement.id,
      selectionStart: document.activeElement.selectionStart,
      selectionEnd: document.activeElement.selectionEnd,
    }
    : null;
  toolsPanel.innerHTML = renderSidebarTool();
  if (focusedInput) {
    const replacementInput = document.getElementById(focusedInput.id);
    if (replacementInput instanceof HTMLInputElement && toolsPanel.contains(replacementInput)) {
      replacementInput.focus({ preventScroll: true });
      if (focusedInput.selectionStart !== null && focusedInput.selectionEnd !== null) {
        replacementInput.setSelectionRange(focusedInput.selectionStart, focusedInput.selectionEnd);
      }
    }
  }
  renderFriendList();
}

function renderSidebarTool() {
  if (state.sidebarTool === 'search') {
    return `
      <label class="search-box friend-search"><span aria-hidden="true">⌕</span><input id="friend-search" type="search" value="${escapeHtml(state.friendSearchQuery)}" placeholder="Search chats and messages" aria-label="Search chats and messages" /></label>`;
  }
  if (state.sidebarTool === 'add') {
    return `
      <form class="add-friend" id="add-friend-form">
        <label class="tool-field-label" for="friend-phone">Add a friend or message by phone</label>
        <div class="add-friend-entry">
          <input id="friend-phone" name="phone" type="tel" inputmode="tel" pattern="\\+[1-9][0-9]{7,14}" placeholder="+1 555 123 4567" value="${escapeHtml(state.addFriendPhone)}" aria-label="Phone number" required />
          <button type="submit" title="Send friend request" aria-label="Send friend request">Add</button>
          <button type="button" data-action="message-by-phone" title="Message without adding as a friend" aria-label="Message without adding as a friend">Message</button>
        </div>
        <p class="add-friend-hint">"Message" starts a chat without adding them. They will see it as a message request.</p>
      </form>`;
  }
  if (state.sidebarTool === 'requests') {
    return `
      <section class="tool-section" aria-label="Friend requests">
        <h2>Friend requests${state.requests.length ? ` (${state.requests.length})` : ''}</h2>
        <div class="request-list">${state.requests.length
          ? state.requests.map((request) => `
            <div class="request-row">
              ${userProfileButton(request.user)}
              <button class="request-info user-profile-name" type="button" data-action="open-user-profile" data-id="${escapeHtml(request.user?.id)}"><span class="person-name">${escapeHtml(request.user?.name)}</span><span class="person-sub">${escapeHtml(request.user?.phone)}</span></button>
              <div class="request-actions">
                <button type="button" data-action="respond-request" data-id="${escapeHtml(request.id)}" data-response="accept" title="Accept request" aria-label="Accept ${escapeHtml(request.user?.name)}">✓</button>
                <button type="button" class="reject" data-action="respond-request" data-id="${escapeHtml(request.id)}" data-response="reject" title="Reject request" aria-label="Reject ${escapeHtml(request.user?.name)}">×</button>
              </div>
            </div>`).join('')
          : '<div class="empty-list">No pending friend requests.</div>'}
        </div>
      </section>`;
  }
  if (state.sidebarTool === 'calls') {
    return `
      <section class="tool-section" aria-label="Call history">
        <div class="call-history-heading"><h2>Call history</h2><button class="small-button" type="button" data-action="refresh-call-history" ${state.callHistoryLoading ? 'disabled' : ''}>Refresh</button></div>
        <div class="call-history-tabs" role="tablist" aria-label="Filter calls">
          ${[['all', 'All'], ['missed', 'Missed']].map(([filter, label]) => `<button type="button" role="tab" aria-selected="${state.callHistoryFilter === filter}" class="${state.callHistoryFilter === filter ? 'active' : ''}" data-action="call-filter" data-filter="${filter}">${label}</button>`).join('')}
        </div>
        ${state.callHistoryError
          ? `<div class="empty-list call-history-error">${escapeHtml(state.callHistoryError)} <button class="text-button" type="button" data-action="refresh-call-history">Try again</button></div>`
          : state.callHistoryLoading && state.callHistoryPage === 0
            ? '<div class="empty-list">Loading call history…</div>'
            : state.callHistory.length
              ? `<div class="call-history-list">${state.callHistory.map((call) => {
                const missed = call.status === 'missed' && call.direction !== 'outgoing';
                const unanswered = call.status === 'missed' && call.direction === 'outgoing';
                const mediaKind = call.media_type === 'video' ? 'video call' : 'voice call';
                const mediaLabel = call.group ? `Group ${mediaKind}` : mediaKind.charAt(0).toUpperCase() + mediaKind.slice(1);
                const statusLabel = missed ? 'Missed' : unanswered ? 'No answer' : formatCallDuration(call.duration_seconds);
                const directionLabel = call.direction === 'outgoing' ? 'Outgoing' : 'Incoming';
                const contactName = call.group ? call.group.name || 'Group' : call.contact?.name || 'Unknown contact';
                return `<article class="call-history-entry${missed ? ' missed' : ''}">
                  ${call.group ? conversationAvatar({ type: 'group', name: call.group.name }, 'sm') : userProfileButton(call.contact, 'sm')}
                  <div class="call-history-info">
                    <strong>${escapeHtml(contactName)}</strong>
                    <span>${directionLabel} · ${mediaLabel} · ${statusLabel}</span>
                    <time>${escapeHtml(formattedDay(call.created_at))} · ${escapeHtml(formattedTime(call.created_at))}</time>
                  </div>
                  <span class="call-history-direction" aria-label="${directionLabel}">${call.direction === 'outgoing' ? '↗' : '↙'}</span>
                </article>`;
              }).join('')}</div>
              ${state.callHistoryPage < state.callHistoryLastPage
                ? `<button class="small-button call-history-more" type="button" data-action="load-more-call-history" ${state.callHistoryLoading ? 'disabled' : ''}>${state.callHistoryLoading ? 'Loading…' : 'Load older calls'}</button>`
                : ''}`
              : '<div class="empty-list">No call history yet. Calls will appear here after you call or receive a call.</div>'}
      </section>`;
  }
  if (state.sidebarTool === 'blocked') {
    return `
      <section class="tool-section" aria-label="Blocked users">
        <h2>Blocked users${state.blockedUsers.length ? ` (${state.blockedUsers.length})` : ''}</h2>
        <div class="request-list">${state.blockedUsers.length
          ? state.blockedUsers.map((user) => `
            <div class="request-row">
              ${userProfileButton(user)}
              <button class="request-info user-profile-name" type="button" data-action="open-user-profile" data-id="${escapeHtml(user.id)}"><span class="person-name">${escapeHtml(user.name)}</span><span class="person-sub">${escapeHtml(user.phone)}</span></button>
              <div class="request-actions">
                <button type="button" data-action="unblock-user" data-id="${escapeHtml(user.id)}" title="Unblock ${escapeHtml(user.name)}" aria-label="Unblock ${escapeHtml(user.name)}">↩</button>
              </div>
            </div>`).join('')
          : '<div class="empty-list">You have not blocked anyone.</div>'}
        </div>
      </section>`;
  }
  if (state.sidebarTool === 'settings') {
    return `
      <section class="tool-section settings-section" aria-label="Settings">
        <h2>Settings</h2>
        <div class="settings-profile">
          ${friendAvatar(state.user, 'lg')}
          <div class="settings-profile-text">
            <strong>${escapeHtml(state.user.name)}</strong>
            <span>${escapeHtml(state.user.phone || '')}</span>
            <span class="settings-profile-actions">
              <button class="small-button" type="button" data-action="edit-name">Edit name</button>
              <button class="small-button" type="button" data-action="choose-profile-picture">${state.user.avatar_url ? 'Change profile picture' : 'Add profile picture'}</button>
              ${state.user.avatar_url ? '<button class="secondary-button" type="button" data-action="remove-profile-picture">Remove</button>' : ''}
            </span>
          </div>
          <input id="profile-picture-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        </div>
        <label class="setting-row" for="setting-notifications">
          <span class="setting-text">
            <strong>Message notifications</strong>
            <span>Show a desktop notification and flash the taskbar when a message arrives while the app is in the background.</span>
          </span>
          <input class="setting-switch" type="checkbox" role="switch" id="setting-notifications" ${state.settings.notifications ? 'checked' : ''}>
        </label>
        <div class="setting-action">
          <button class="small-button" type="button" data-action="test-notification">Send a test notification</button>
        </div>
        <label class="setting-row" for="setting-blur-messages">
          <span class="setting-text">
            <strong>Blur messages</strong>
            <span>Blur message text, images, and chat previews until you point at them. Notifications will not show message content.</span>
          </span>
          <input class="setting-switch" type="checkbox" role="switch" id="setting-blur-messages" ${state.settings.blurMessages ? 'checked' : ''}>
        </label>
        <label class="setting-row" for="setting-edit-minutes">
          <span class="setting-text">
            <strong>Edit sent messages</strong>
            <span>How long after sending you can edit a text message. Others see an "edited" label. Saved to your account.</span>
          </span>
          <select class="setting-select" id="setting-edit-minutes">
            ${MESSAGE_EDIT_MINUTE_OPTIONS.map((minutes) => `<option value="${minutes}" ${minutes === messageEditMinutes() ? 'selected' : ''}>${minutes === 0 ? 'Off' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}</option>`).join('')}
          </select>
        </label>
        <div class="setting-row">
          <span class="setting-text">
            <strong>Password</strong>
            <span>Change the password you use to sign in. You’ll need your current password.</span>
          </span>
          <button class="small-button" type="button" data-action="change-password">Change password</button>
        </div>
        <p class="setting-note">Notification and blur settings are saved on this computer.</p>
      </section>`;
  }
  if (state.sidebarTool === 'updates') return updateControls();
  return '';
}

// A one-to-one chat with someone who is not (or no longer) a friend: message
// requests, people messaged by number, and blocked non-friends. These live in
// the "Others" list and move to "Chats" as soon as the two become friends.
function isOthersConversation(conversation) {
  return Boolean(conversation && conversation.type !== 'group' && conversation.friend &&
    !state.friends.some((friend) => String(friend.id) === String(conversation.friend.id)));
}

function updateChatListTabs() {
  document.querySelectorAll('[data-action="chat-list-tab"]').forEach((tab) => {
    const active = tab.dataset.tab === state.chatListTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

function renderFriendList(filterValue = state.sidebarTool === 'search' ? state.friendSearchQuery : '') {
  const friendList = document.querySelector('#friend-list');
  if (!friendList) return;
  const filter = filterValue.trim().toLowerCase();
  updateChatListTabs();
  // Searching looks through both lists.
  const showChats = Boolean(filter) || state.chatListTab === 'chats';
  const showOthers = Boolean(filter) || state.chatListTab === 'others';
  const entries = [
    ...(showChats ? state.friends.map((friend) => ({ kind: 'friend', friend, conversation: conversationForFriend(friend.id) })) : []),
    ...(showOthers ? state.conversations
      .filter(isOthersConversation)
      .map((conversation) => ({ kind: 'friend', friend: conversation.friend, conversation })) : []),
    ...(showChats ? state.conversations
      .filter((conversation) => conversation.type === 'group')
      .map((conversation) => ({ kind: 'group', conversation })) : []),
  ].filter(({ friend, conversation }) => {
    const preview = messagePreview(conversation?.last_message);
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
  const searchingMessages = Boolean(filter) && state.sidebarTool === 'search';
  if (state.sidebarTool === 'search') scheduleGlobalSearch(filter);
  friendList.innerHTML = (searchingMessages ? '<div class="search-section-title">Chats</div>' : '') + (entries.length
    ? entries.map(({ kind, friend, conversation }) => {
      if (kind === 'group') return renderGroupListItem(conversation);
      const unreadCount = Number(conversation?.unread_count) || 0;
      const lastMessage = conversation?.last_message;
      const preview = messagePreview(lastMessage, 'Start a conversation');
      const previewText = lastMessage && String(lastMessage.sender?.id) === String(state.user.id)
        ? `You: ${preview}`
        : preview;
      return `
        <div class="friend-item ${String(selectedConversation()?.friend?.id) === String(friend.id) ? 'active' : ''} ${unreadCount ? 'has-unread' : ''}">
          ${userProfileButton(friend, 'sm', true)}
          <div class="person-info friend-item-main">
            <button class="user-profile-name" type="button" data-action="open-user-profile" data-id="${escapeHtml(friend.id)}">${escapeHtml(friend.name)}</button>${conversationTag(conversation)}
            <button class="conversation-preview friend-item-open-chat" type="button" data-action="open-friend" data-id="${escapeHtml(friend.id)}">${escapeHtml(previewText)}</button>
          </div>
          <div class="conversation-meta">${lastMessage ? formattedTime(lastMessage.created_at) : ''}
            ${unreadCount ? `<span class="counter">${escapeHtml(unreadCount)}</span>` : ''}
          </div>
        </div>`;
    }).join('')
    : filter
      ? '<div class="empty-list">No chats match your search.</div>'
      : state.chatListTab === 'others'
        ? '<div class="empty-list">Chats with people who are not your friends appear here, such as message requests and people you message by phone number. Add them as a friend to move the chat to Chats.</div>'
        : state.friends.length || state.conversations.some((conversation) => conversation.type === 'group')
          ? '<div class="empty-list">No chats yet.</div>'
          : '<div class="empty-list">Your friends and groups will appear here. Select Add or Group to get started.</div>')
    + (searchingMessages && filter.length >= 2 ? globalSearchMarkup() : '');
}

function renderGroupListItem(conversation) {
  const unreadCount = Number(conversation.unread_count) || 0;
  const lastMessage = conversation.last_message;
  const preview = lastMessage
    ? `${lastMessage.sender?.name ? `${lastMessage.sender.name}: ` : ''}${messagePreview(lastMessage, 'Attachment')}`
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
  const searchFocused = document.activeElement?.id === 'chat-search-input';
  panel.innerHTML = `
    <header class="chat-header">
      <button class="icon-button back-to-friends" type="button" data-action="show-friends" title="Back to friends" aria-label="Back to friends">‹</button>
      ${conversation.type === 'group'
        ? `${conversationAvatar(conversation, 'lg')}<div class="chat-heading"><h2>${escapeHtml(conversationTitle(conversation))} <span class="member-count-chip" title="${groupMembers.length} group members">👥 ${groupMembers.length} ${groupMembers.length === 1 ? 'member' : 'members'}</span></h2><p id="chat-status">${escapeHtml(presenceText())}</p></div>`
        : `<button class="chat-user-profile" type="button" data-action="open-user-profile" data-id="${escapeHtml(conversation.friend?.id)}" aria-label="View ${escapeHtml(conversation.friend?.name || 'friend')}'s profile" title="View profile">${friendAvatar(conversation.friend, 'lg', true)}<span class="chat-heading"><h2>${escapeHtml(conversationTitle(conversation))}</h2><p id="chat-status" title="${escapeHtml(presenceText(conversation.friend?.id))}">${presenceText(conversation.friend?.id)}</p></span></button>`}
      <div class="chat-actions">
        <button class="icon-button" type="button" data-action="open-chat-search" title="Search messages (Ctrl+F)" aria-label="Search messages in this chat"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/></svg></button>
        ${conversation.type === 'group' ? `<button class="icon-button group-members-button" type="button" data-action="open-group-members" data-id="${escapeHtml(conversation.id)}" title="View group members" aria-label="View ${groupMembers.length} group members"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 19v-1a6 6 0 0 1 12 0v1"/><path d="M16 5.5a3 3 0 0 1 0 5.8M18 14a5 5 0 0 1 3 4.5v.5"/></svg><span class="group-member-count">${groupMembers.length}</span></button>` : ''}
        <button class="icon-button" type="button" data-action="unfriend" data-id="${escapeHtml(conversation.friend?.id)}" title="Remove friend" aria-label="Remove ${escapeHtml(conversation.friend?.name || 'friend')}" ${conversation.type === 'group' ? 'hidden' : ''}>✕</button>
        <button class="icon-button" type="button" data-action="block-user" data-id="${escapeHtml(conversation.friend?.id)}" title="Block user" aria-label="Block ${escapeHtml(conversation.friend?.name || 'user')}" ${conversation.type === 'group' ? 'hidden' : ''}>⊘</button>
        <button class="icon-button" type="button" data-action="call-audio" title="${conversation.type === 'group' ? 'Start group voice call' : 'Start voice call'}" aria-label="${conversation.type === 'group' ? 'Start group voice call' : 'Start voice call'}" ${state.joinedRoomId ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 3.8 9.5 3.3a1.6 1.6 0 0 1 1.8 1.1l.8 2.8a1.6 1.6 0 0 1-.7 1.8l-1.6 1.1a14 14 0 0 0 4.1 4.1l1.1-1.6a1.6 1.6 0 0 1 1.8-.7l2.8.8a1.6 1.6 0 0 1 1.1 1.8l-.5 2.3a2 2 0 0 1-2 1.6A15.5 15.5 0 0 1 5.6 5.8a2 2 0 0 1 1.6-2Z"/></svg></button>
        <button class="icon-button" type="button" data-action="call-video" title="${conversation.type === 'group' ? 'Start group video call' : 'Start video call'}" aria-label="${conversation.type === 'group' ? 'Start group video call' : 'Start video call'}" ${state.joinedRoomId ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3z"/></svg></button>
        <button class="icon-button" type="button" data-action="clear-chat" title="Clear chat (only for you)" aria-label="Clear chat for you"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
        <button class="icon-button" type="button" data-action="refresh" title="Refresh messages" aria-label="Refresh messages">↻</button>
      </div>
    </header>
    <div class="chat-search" id="chat-search" hidden></div>
    <div class="pinned-bar" id="pinned-bar" hidden></div>
    <div class="message-list" id="message-list"></div>
    <div class="composer-wrap">
      <div class="chat-banner" id="chat-banner" role="status" hidden></div>
      <div class="attachment-preview" id="attachment-preview" aria-live="polite" hidden></div>
      <div class="reply-preview" id="reply-preview" hidden></div>
      <div class="voice-recorder" id="voice-recorder" role="group" aria-label="Recording a voice message" hidden></div>
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
        <button class="mic-button" type="button" data-action="open-protected-composer" aria-label="Send a password-protected message" title="Send a password-protected message"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2"/></svg></button>
        <button class="mic-button" type="button" data-action="start-voice-recording" aria-label="Record a voice message" title="Record a voice message"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg></button>
        <button class="send-button" type="submit" aria-label="Send message">➤</button>
      </form>
    </div>`;
  renderMessages();
  updateReplyPreview();
  renderVoiceRecorder();
  renderChatBanner();
  renderChatSearch(searchFocused);
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
        <button class="primary-button profile-change-button" type="button" data-action="choose-profile-picture">${state.user.avatar_url ? 'Change profile picture' : 'Add profile picture'}</button>
        ${state.user.avatar_url ? '<button class="secondary-button profile-remove-button" type="button" data-action="remove-profile-picture">Remove profile picture</button>' : ''}
        <p class="profile-picture-guidance">Recommended: a square image, at least 256 x 256 px. JPEG, PNG, GIF, or WEBP; maximum 5 MB. Other image dimensions are fitted automatically.</p>
        <input id="profile-picture-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </section>
    </div>`;
}

function renderEditNameModal() {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot || !state.user) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="app-modal" role="dialog" aria-modal="true" aria-labelledby="edit-name-title">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button>
        <h2 id="edit-name-title">Edit name</h2>
        <p class="modal-subtitle">This is the name your contacts see.</p>
        <form id="edit-name-form" class="form-grid">
          <div class="field"><label for="edit-name-input">Display name</label><input id="edit-name-input" name="name" autocomplete="name" maxlength="120" value="${escapeHtml(state.user.name || '')}" placeholder="Your name" required /></div>
          <div class="modal-actions">
            <button class="secondary-button" type="button" data-action="close-modal">Cancel</button>
            <button class="primary-button" type="submit">Save</button>
          </div>
        </form>
      </section>
    </div>`;
  document.querySelector('#edit-name-input')?.focus();
}

function renderChangePasswordModal() {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot || !state.user) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="app-modal" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button>
        <h2 id="change-password-title">Change password</h2>
        <p class="modal-subtitle">Other signed-in devices will be signed out. This device stays signed in.</p>
        <form id="change-password-form" class="form-grid">
          <div class="field">
            <label for="current-password">Current password</label>
            <div class="password-input-wrap">
              <input id="current-password" name="current_password" type="password" autocomplete="current-password" maxlength="128" placeholder="Your current password" required />
              <button class="password-visibility" type="button" data-action="toggle-field-visibility" data-target="current-password" aria-label="Show password" title="Show password" aria-pressed="false">${PASSWORD_EYE_SVGS}</button>
            </div>
          </div>
          <div class="field">
            <label for="new-password">New password</label>
            <div class="password-input-wrap">
              <input id="new-password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="At least 8 characters" required />
              <button class="password-visibility" type="button" data-action="toggle-field-visibility" data-target="new-password" aria-label="Show password" title="Show password" aria-pressed="false">${PASSWORD_EYE_SVGS}</button>
            </div>
          </div>
          <div class="modal-actions">
            <button class="secondary-button" type="button" data-action="close-modal">Cancel</button>
            <button class="primary-button" type="submit">Update password</button>
          </div>
        </form>
      </section>
    </div>`;
  document.querySelector('#current-password')?.focus();
}

function renderUserProfileModal(user) {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot || !user?.id) return;
  const isFriend = state.friends.some((friend) => String(friend.id) === String(user.id));
  const online = state.socketConnected && isOnline(user.id);
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="app-modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="user-profile-title">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close profile">×</button>
        <h2 id="user-profile-title">Profile</h2>
        <div class="profile-modal-avatar">${friendAvatar(user, 'lg')}</div>
        <div class="profile-modal-name">${escapeHtml(user.name || 'User')}</div>
        <div class="profile-modal-phone">${escapeHtml(user.phone || 'Phone number not available')}</div>
        <div class="profile-user-status"><span class="presence-dot ${online ? 'online' : 'offline'}"></span>${online ? 'Online' : 'Offline'}</div>
        ${isFriend ? `<button class="primary-button profile-change-button" type="button" data-action="profile-open-chat" data-id="${escapeHtml(user.id)}">Message</button>` : ''}
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
        <div class="group-icon-editor">
          ${conversationAvatar(conversation, 'lg')}
          <div class="group-icon-actions">
            <button class="small-button" type="button" data-action="choose-group-icon">${conversation.icon_url ? 'Change group icon' : 'Add group icon'}</button>
            ${conversation.icon_url ? `<button class="secondary-button" type="button" data-action="remove-group-icon" data-id="${escapeHtml(conversation.id)}">Remove</button>` : ''}
            <span class="group-icon-hint">JPEG, PNG, GIF or WEBP, up to 5 MB. Everyone in the group sees it.</span>
          </div>
          <input id="group-icon-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-conversation-id="${escapeHtml(conversation.id)}" hidden>
        </div>
        <div class="modal-member-list">
          ${members.map((member) => `
            <div class="modal-member-row">
              ${userProfileButton(member, 'sm')}
              <button class="modal-member-name user-profile-name" type="button" data-action="open-user-profile" data-id="${escapeHtml(member.id)}">${escapeHtml(member.name)}</button>
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

function renderForwardModal(message) {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot) return;
  const targets = state.conversations.filter((conversation) =>
    String(conversation.id) !== String(message.conversation_id));
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <form class="app-modal forward-modal" id="forward-message-form" role="dialog" aria-modal="true" aria-labelledby="forward-modal-title" data-message-id="${escapeHtml(message.id)}" data-source-conversation-id="${escapeHtml(message.conversation_id)}">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close forward dialog">×</button>
        <h2 id="forward-modal-title">Forward message</h2>
        <p class="modal-subtitle">${escapeHtml(messageSummary(message))}</p>
        <div class="forward-target-list">
          ${targets.length
            ? targets.map((conversation) => `
              <label class="forward-target-row">
                <input type="checkbox" name="target_conversation_ids" value="${escapeHtml(conversation.id)}">
                ${conversationAvatar(conversation)}
                <span>${escapeHtml(conversationTitle(conversation))}</span>
              </label>
            `).join('')
            : '<div class="empty-list">No other conversations are available.</div>'}
        </div>
        <footer class="forward-modal-actions">
          <span class="forward-selection-count" id="forward-selection-count" aria-live="polite">0 selected</span>
          <button class="primary-button" type="submit" ${targets.length ? '' : 'disabled'}>Forward</button>
        </footer>
      </form>
    </div>`;
}

async function handleForwardMessage(form) {
  const messageId = form.dataset.messageId;
  const sourceConversationId = form.dataset.sourceConversationId;
  const selectedTargets = Array.from(form.querySelectorAll('input[name="target_conversation_ids"]:checked'));
  if (!selectedTargets.length) throw new Error('Select at least one conversation to forward to.');

  const message = state.messages.find((item) => String(item.id) === String(messageId));
  if (!message) throw new Error('This message is no longer available.');
  if (message.decryption_failed) throw new Error('This message could not be decrypted, so it cannot be forwarded.');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = `Forwarding to ${selectedTargets.length}…`;

  const results = await Promise.allSettled(selectedTargets.map(async (checkbox) => {
    const targetConversationId = checkbox.value;
    const forwardPath = `/conversations/${encodeURIComponent(sourceConversationId)}/messages/${encodeURIComponent(messageId)}/forward`;
    // The server cannot read encrypted content, so it is re-encrypted here for the
    // target conversation. A file keeps its own key, so its bytes are copied as-is.
    const content = message.attachment?.fileKey
      ? {
        text: message.body || null,
        file: {
          name: message.attachment.name,
          mime: message.attachment.mime,
          size: message.attachment.size,
          key: message.attachment.fileKey,
          iv: message.attachment.fileIv,
        },
      }
      : message.type === 'protected' || message.attachment ? null : { text: message.body };
    const forwardedMessage = content
      ? await sendEncrypted(targetConversationId, content, (encrypted) =>
        api(forwardPath, { method: 'POST', body: { target_conversation_id: Number(targetConversationId), ...encrypted } }))
      : await api(forwardPath, { method: 'POST', body: { target_conversation_id: Number(targetConversationId) } });
    await notifyMessageSent(targetConversationId, forwardedMessage.id);
    checkbox.checked = false;
    return targetConversationId;
  }));
  const failures = results
    .map((result, index) => ({ result, checkbox: selectedTargets[index] }))
    .filter(({ result }) => result.status === 'rejected');
  const succeeded = results.length - failures.length;

  if (!failures.length) {
    closeModal();
    await refreshData();
    showNotice(`Message forwarded to ${succeeded} ${succeeded === 1 ? 'conversation' : 'conversations'}.`, 'success');
    return;
  }

  submitButton.disabled = false;
  submitButton.textContent = 'Forward';
  const failedNames = failures.map(({ checkbox }) =>
    conversationTitle(state.conversations.find((item) => String(item.id) === checkbox.value)) || 'a conversation');
  const detail = failures[0].result.reason?.message || 'Please try again.';
  showNotice(
    `${succeeded ? `Forwarded to ${succeeded}. ` : ''}Could not forward to ${failedNames.join(', ')}. ${detail}`,
  );
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

// ---------------------------------------------------------------------------
// New group dialog
//
// Rendered once when opened; later changes (typing, ticking friends) update
// only the parts that change, so focus and scroll position are never lost.
// ---------------------------------------------------------------------------

function renderCreateGroupModal() {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot) return;
  const friends = [...state.friends].sort((left, right) =>
    String(left.name || '').localeCompare(String(right.name || '')));

  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <form class="app-modal create-group-modal" id="create-group-form" role="dialog" aria-modal="true" aria-labelledby="create-group-title" novalidate>
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button>
        <h2 id="create-group-title">New group</h2>
        <p class="modal-subtitle">Name your group and choose who to add. You can add more people later.</p>
        ${friends.length ? `
          <div class="create-group-identity">
            <span class="avatar lg group-avatar" id="group-avatar-preview" aria-hidden="true"></span>
            <label class="create-group-field">
              <span>Group name</span>
              <input id="group-name" name="name" type="text" maxlength="100" value="${escapeHtml(state.groupName)}" placeholder="e.g. Project team" autocomplete="off" required>
            </label>
          </div>
          <div class="create-group-members-head">
            <strong>Add members</strong>
            <span id="group-selected-count" aria-live="polite"></span>
          </div>
          <div class="group-chips" id="group-chips"></div>
          <div class="group-friend-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/></svg>
            <input id="group-friend-search" type="search" value="${escapeHtml(state.groupFriendQuery)}" placeholder="Search friends by name or phone" aria-label="Search friends" autocomplete="off">
          </div>
          <div class="group-friend-list" role="group" aria-label="Friends">
            ${friends.map((friend) => `
              <label class="group-friend-row" data-search="${escapeHtml(`${friend.name || ''} ${friend.phone || ''}`.toLowerCase())}">
                <input type="checkbox" name="friend_ids" value="${escapeHtml(friend.id)}" ${state.selectedGroupFriendIds.has(String(friend.id)) ? 'checked' : ''}>
                ${friendAvatar(friend, 'sm')}
                <span class="group-friend-text"><strong>${escapeHtml(friend.name)}</strong><span>${escapeHtml(friend.phone || '')}</span></span>
                <span class="group-friend-check" aria-hidden="true"></span>
              </label>`).join('')}
            <div class="empty-list" id="group-no-match" hidden>No friends match your search.</div>
          </div>
          <footer class="create-group-actions">
            <button class="secondary-button" type="button" data-action="close-modal">Cancel</button>
            <button class="primary-button" type="submit" id="create-group-submit">Create group</button>
          </footer>`
        : `
          <div class="create-group-empty">
            <p>You need at least one friend to create a group.</p>
            <button class="primary-button" type="button" data-action="open-add-friend-from-group">Add a friend</button>
          </div>`}
      </form>
    </div>`;
  updateCreateGroupView();
  modalRoot.querySelector(state.groupName ? '#group-friend-search' : '#group-name')?.focus();
}

function updateCreateGroupView() {
  const form = document.querySelector('#create-group-form');
  if (!form) return;
  const name = state.groupName.trim();
  const selected = state.friends.filter((friend) => state.selectedGroupFriendIds.has(String(friend.id)));

  const avatar = form.querySelector('#group-avatar-preview');
  if (avatar) avatar.textContent = name ? initials(name) : '＋';

  const count = form.querySelector('#group-selected-count');
  if (count) count.textContent = selected.length ? `${selected.length} selected` : 'Choose at least one';

  const chips = form.querySelector('#group-chips');
  if (chips) {
    chips.hidden = selected.length === 0;
    chips.innerHTML = selected.map((friend) => `
      <button class="group-chip" type="button" data-action="remove-group-chip" data-id="${escapeHtml(friend.id)}" aria-label="Remove ${escapeHtml(friend.name)}" title="Remove">
        ${friendAvatar(friend, 'chip')}<span>${escapeHtml(friend.name)}</span><span class="group-chip-remove" aria-hidden="true">×</span>
      </button>`).join('');
  }

  const query = state.groupFriendQuery.trim().toLowerCase();
  let visible = 0;
  form.querySelectorAll('.group-friend-row').forEach((row) => {
    const matches = !query || row.dataset.search.includes(query);
    row.hidden = !matches;
    if (matches) visible += 1;
  });
  const noMatch = form.querySelector('#group-no-match');
  if (noMatch) noMatch.hidden = visible > 0;

  const submit = form.querySelector('#create-group-submit');
  if (submit && !submit.dataset.busy) {
    submit.disabled = !name || selected.length === 0;
    submit.textContent = selected.length ? `Create group (${selected.length + 1} people)` : 'Create group';
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

  if (call.kind === 'group') {
    renderGroupCallOverlay(overlay, call);
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

function renderGroupCallOverlay(overlay, call) {
  const incoming = call.direction === 'incoming' && call.phase === 'ringing';
  const video = call.mediaType === 'video';
  const peers = [...state.groupPeers.values()];
  const title = incoming ? 'Incoming group call' : call.phase === 'joining' ? 'Joining call…' : 'Group call';
  const status = incoming
    ? `${call.callerName} is calling`
    : call.phase === 'joining'
      ? 'Connecting…'
      : peers.length ? `${peers.length + 1} in call` : 'Ringing members…';

  const tile = (user, label, detail, mediaAttribute) => `
    <div class="group-call-tile">
      ${mediaAttribute ? `<video ${mediaAttribute} autoplay muted playsinline></video>` : ''}
      <div class="group-call-tile-avatar">${avatarMarkup(user, 'lg')}</div>
      <div class="group-call-tile-label"><strong>${escapeHtml(label)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>
    </div>`;

  overlay.hidden = false;
  overlay.innerHTML = `
    <section class="call-card group-call-card" role="dialog" aria-modal="true" aria-labelledby="call-title">
      <header class="call-card-header">
        <div>
          <h2 id="call-title">${escapeHtml(title)}</h2>
          <p>${escapeHtml(call.groupName)} · ${video ? 'Video call' : 'Voice call'}</p>
        </div>
        <span class="call-status">${escapeHtml(status)}</span>
      </header>
      ${incoming
        ? `<div class="call-avatar group-call-ringing" aria-hidden="true">${escapeHtml(initials(call.groupName))}</div>`
        : `<div class="group-call-grid" data-count="${peers.length + 1}">
            ${tile(state.user, 'You', call.muted ? 'Muted' : '', video && call.cameraEnabled ? 'data-local-video' : '')}
            ${peers.map((peer) => tile(
              userForProfile(peer.userId) || { id: peer.userId, name: peer.name },
              peer.name,
              peer.status,
              video && peer.stream?.getVideoTracks().length ? `data-peer-video="${escapeHtml(peer.userId)}"` : '',
            )).join('')}
          </div>
          ${peers.map((peer) => `<audio data-peer-audio="${escapeHtml(peer.userId)}" autoplay hidden></audio>`).join('')}`}
      <footer class="call-controls">
        ${incoming
          ? `<button class="call-control accept" data-call-action="accept">Join</button><button class="call-control hangup" data-call-action="reject">Decline</button>`
          : `<button class="call-control" data-call-action="mute">${call.muted ? 'Unmute' : 'Mute'}</button>
             ${video ? `<button class="call-control" data-call-action="camera">${call.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}</button>` : ''}
             <button class="call-control hangup" data-call-action="hangup">Leave</button>`}
      </footer>
    </section>`;

  const localVideo = overlay.querySelector('[data-local-video]');
  if (localVideo && state.localStream) localVideo.srcObject = state.localStream;
  for (const peer of peers) {
    if (!peer.stream) continue;
    const peerVideo = overlay.querySelector(`[data-peer-video="${CSS.escape(String(peer.userId))}"]`);
    if (peerVideo) {
      peerVideo.srcObject = peer.stream;
      playRemoteMedia(peerVideo);
    }
    const peerAudio = overlay.querySelector(`[data-peer-audio="${CSS.escape(String(peer.userId))}"]`);
    if (peerAudio) {
      peerAudio.srcObject = peer.stream;
      peerAudio.muted = false;
      peerAudio.volume = 1;
      playRemoteMedia(peerAudio);
    }
  }
}

function playRemoteMedia(element) {
  element.play().catch((error) => {
    if (error.name === 'AbortError' || !state.call || state.call.playbackWarningShown) return;
    state.call.playbackWarningShown = true;
    showNotice('Incoming audio could not start automatically. Press Play in the call controls to hear your friend.');
  });
}

// ---------------------------------------------------------------------------
// Message requests, blocked chats, and pinned messages
// ---------------------------------------------------------------------------

// Blocked chats, and requests the other person declined, can be read but not written to.
function isReadOnly(conversation) {
  return Boolean(conversation?.blocked ||
    (conversation?.request?.status === 'declined' && !conversation.request.incoming));
}

function conversationTag(conversation) {
  if (conversation?.blocked) return '<span class="chat-tag blocked">Blocked</span>';
  if (conversation?.request?.status === 'pending') {
    return conversation.request.incoming
      ? '<span class="chat-tag request">Message request</span>'
      : '<span class="chat-tag">Request sent</span>';
  }
  return '';
}

function renderChatBanner() {
  const banner = document.querySelector('#chat-banner');
  const wrap = document.querySelector('.composer-wrap');
  const conversation = selectedConversation();
  if (!banner || !wrap || !conversation) return;
  const name = escapeHtml(conversation.friend?.name || 'This person');
  const friendId = escapeHtml(conversation.friend?.id);
  const conversationId = escapeHtml(conversation.id);
  const button = (action, label, id, extra = '') =>
    `<button class="small-button${extra}" type="button" data-action="${action}" data-id="${id}">${label}</button>`;

  let text = '';
  const actions = [];
  if (conversation.blocked === 'by_me') {
    text = `You blocked ${name}. You can still read your old messages, but neither of you can send new ones.`;
    actions.push(button('unblock-user', 'Unblock', friendId));
  } else if (conversation.blocked === 'by_them') {
    text = `You can't send messages to ${name}. You can still read your old messages.`;
  } else if (conversation.request?.status === 'pending' && conversation.request.incoming) {
    text = `${name} is not in your friends and wants to message you. Replying also accepts.`;
    actions.push(
      button('accept-request', 'Accept', conversationId),
      button('decline-request', 'Decline', conversationId),
      button('block-user', 'Block', friendId, ' danger'),
    );
  } else if (conversation.request?.status === 'pending') {
    text = `Message request sent. ${name} will see your messages as a request until they accept.`;
  } else if (conversation.request?.status === 'declined') {
    text = `${name} declined your message request.`;
  } else if (isOthersConversation(conversation)) {
    text = `${name} is not in your friends. Add them to move this chat to Chats.`;
  }
  // Any chat with a non-friend (not blocked) can be turned into a friendship.
  if (isOthersConversation(conversation) && !conversation.blocked && conversation.friend?.phone &&
    conversation.request?.status !== 'declined') {
    actions.unshift(`<button class="small-button" type="button" data-action="add-friend-from-chat" data-phone="${escapeHtml(conversation.friend.phone)}">Add friend</button>`);
  }

  banner.innerHTML = text
    ? `<span>${text}</span>${actions.length ? `<span class="chat-banner-actions">${actions.join('')}</span>` : ''}`
    : '';
  banner.hidden = !text;
  wrap.classList.toggle('read-only', isReadOnly(conversation));
}

function canPinMessage(message) {
  return !message.pending && !message.deleted_for_everyone_at && message.type !== 'call' &&
    !isReadOnly(selectedConversation());
}

function renderPinnedBar() {
  const bar = document.querySelector('#pinned-bar');
  if (!bar) return;
  const pins = state.pinnedMessages;
  if (!pins.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const index = Math.min(state.pinIndex, pins.length - 1);
  const pin = pins[index];
  bar.hidden = false;
  bar.innerHTML = `
    <span class="pinned-icon" aria-hidden="true">📌</span>
    <button class="pinned-text" type="button" data-action="jump-to-pin" data-message-id="${escapeHtml(pin.id)}" title="Go to pinned message">
      <strong>${pins.length > 1 ? `Pinned message ${index + 1} of ${pins.length}` : 'Pinned message'}</strong>
      <span>${escapeHtml(`${pin.sender?.name ? `${pin.sender.name}: ` : ''}${messageSummary(pin)}`)}</span>
    </button>
    ${isReadOnly(selectedConversation()) ? '' : `<button class="pinned-unpin" type="button" data-action="toggle-pin" data-message-id="${escapeHtml(pin.id)}" aria-label="Unpin this message" title="Unpin">×</button>`}`;
}

// ---------------------------------------------------------------------------
// Message search
//
// Messages are end-to-end encrypted, so the server cannot search them. The
// app downloads and decrypts a chat's history into a local, in-memory index
// (cleared on sign-out) and searches that. Later searches only fetch what is new.
// ---------------------------------------------------------------------------

const SEARCH_PAGE_SIZE = 100;
// Searching all chats looks through this many recent messages per chat;
// searching inside one chat goes through its whole history.
const GLOBAL_SEARCH_MESSAGES_PER_CHAT = 500;
const MAX_SEARCH_RESULTS = 200;

function searchableText(message) {
  if (!message || message.deleted_for_everyone_at || message.decryption_failed) return '';
  if (message.type === 'protected' || message.type === 'call') return '';
  return [message.body, message.attachment?.name].filter(Boolean).join(' ').trim();
}

function searchIndexFor(conversationId) {
  const key = String(conversationId);
  if (!state.searchIndex.has(key)) {
    state.searchIndex.set(key, { items: new Map(), started: false, newestId: 0, oldestId: Infinity, scanned: 0, complete: false, queue: Promise.resolve() });
  }
  return state.searchIndex.get(key);
}

function addToSearchIndex(conversationId, messages) {
  const index = searchIndexFor(conversationId);
  for (const message of messages || []) {
    const id = Number(message?.id);
    if (message?.pending || !Number.isFinite(id)) continue;
    const text = searchableText(message);
    if (text) {
      index.items.set(id, { id, conversationId: String(conversationId), text, lower: text.toLowerCase(), sender: message.sender, created_at: message.created_at });
    } else {
      index.items.delete(id);
    }
  }
}

async function fetchSearchPage(conversationId, beforeId) {
  const query = beforeId ? `before_id=${beforeId}&limit=${SEARCH_PAGE_SIZE}` : `limit=${SEARCH_PAGE_SIZE}`;
  const payload = await api(`/conversations/${encodeURIComponent(conversationId)}/messages?${query}`);
  const messages = await decryptMessagesForDisplay(conversationId, Array.isArray(payload.data) ? payload.data : []);
  addToSearchIndex(conversationId, messages);
  const ids = messages.map((message) => Number(message.id)).filter(Number.isFinite);
  return {
    newest: ids.length ? Math.max(...ids) : 0,
    oldest: ids.length ? Math.min(...ids) : Infinity,
    count: messages.length,
    hasMore: Boolean(payload.has_more),
  };
}

// Brings a chat's index up to date (new messages first), then indexes older
// history until `limit` messages were scanned or the chat's start is reached.
// Runs are queued per chat and can stop early; the next run resumes.
function indexConversation(conversationId, limit, isCancelled, onProgress) {
  const index = searchIndexFor(conversationId);
  const run = async () => {
    const key = String(conversationId);
    const latestId = Number(state.conversations.find((item) => String(item.id) === key)?.last_message?.id) || 0;
    if (!index.started) {
      const page = await fetchSearchPage(key, null);
      index.started = true;
      index.newestId = page.newest;
      index.oldestId = page.oldest;
      index.scanned = page.count;
      index.complete = !page.hasMore;
      onProgress?.();
    } else if (latestId > index.newestId) {
      // Catch up on messages that arrived since the index was built.
      let beforeId = null;
      let newest = index.newestId;
      for (let pages = 0; pages < 50; pages += 1) {
        const page = await fetchSearchPage(key, beforeId);
        newest = Math.max(newest, page.newest);
        if (!page.hasMore || page.oldest <= index.newestId) break;
        beforeId = page.oldest;
      }
      index.newestId = newest;
      onProgress?.();
    }
    while (!index.complete && index.scanned < limit && Number.isFinite(index.oldestId)) {
      if (isCancelled?.()) return;
      const page = await fetchSearchPage(key, index.oldestId);
      index.oldestId = Math.min(index.oldestId, page.oldest);
      index.scanned += page.count;
      index.complete = !page.hasMore || page.count === 0;
      onProgress?.();
    }
  };
  index.queue = index.queue.catch(() => {}).then(run);
  return index.queue;
}

function searchIndexedMessages(query, conversationIds) {
  const needle = query.trim().toLowerCase();
  const results = [];
  for (const id of conversationIds) {
    const index = state.searchIndex.get(String(id));
    if (!index) continue;
    for (const item of index.items.values()) {
      if (item.lower.includes(needle)) results.push(item);
    }
  }
  return results.sort((left, right) => right.id - left.id);
}

function searchSnippet(text, needle) {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return escapeHtml(text.slice(0, 120));
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + needle.length + 80);
  return `${start > 0 ? '…' : ''}${escapeHtml(text.slice(start, at))}<mark>${escapeHtml(text.slice(at, at + needle.length))}</mark>${escapeHtml(text.slice(at + needle.length, end))}${end < text.length ? '…' : ''}`;
}

function searchResultDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formattedTime(value);
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
}

function searchResultMarkup(item, needle, showChat) {
  const conversation = state.conversations.find((entry) => String(entry.id) === item.conversationId);
  const sender = String(item.sender?.id) === String(state.user?.id) ? 'You' : (item.sender?.name || 'Someone');
  return `
    <button class="search-result" type="button" data-action="open-search-result" data-conversation-id="${escapeHtml(item.conversationId)}" data-message-id="${escapeHtml(item.id)}">
      ${showChat ? `<span class="search-result-chat">${escapeHtml(conversationTitle(conversation))}</span>` : ''}
      <span class="search-result-meta"><span>${escapeHtml(sender)}</span><span>${escapeHtml(searchResultDate(item.created_at))}</span></span>
      <span class="search-result-text">${searchSnippet(item.text, needle)}</span>
    </button>`;
}

function resultCountText(count) {
  if (count > MAX_SEARCH_RESULTS) return `Showing the newest ${MAX_SEARCH_RESULTS} of ${count} results`;
  return `${count} ${count === 1 ? 'result' : 'results'}`;
}

// --- Search inside the open chat ---

let chatSearchTimer = null;

function openChatSearch() {
  const conversation = selectedConversation();
  if (!conversation) return;
  if (state.chatSearch.conversationId !== String(conversation.id)) {
    state.chatSearch = { open: true, conversationId: String(conversation.id), query: '', status: '', html: '' };
  } else {
    state.chatSearch.open = true;
  }
  renderChatSearch(true);
}

function closeChatSearch() {
  state.chatSearch = { open: false, conversationId: null, query: '', status: '', html: '' };
  state.chatSearchToken += 1;
  renderChatSearch(false);
}

function renderChatSearch(focus = false) {
  const box = document.querySelector('#chat-search');
  if (!box) return;
  const search = state.chatSearch;
  if (search.open && search.conversationId !== String(state.selectedConversationId)) {
    state.chatSearch = { open: false, conversationId: null, query: '', status: '', html: '' };
    state.chatSearchToken += 1;
  }
  if (!state.chatSearch.open) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="chat-search-bar">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/></svg>
      <input id="chat-search-input" type="search" value="${escapeHtml(search.query)}" placeholder="Search messages in this chat" aria-label="Search messages in this chat" autocomplete="off">
      <span class="chat-search-status" id="chat-search-status" aria-live="polite">${escapeHtml(search.status)}</span>
      <button class="icon-button" type="button" data-action="close-chat-search" title="Close search (Esc)" aria-label="Close search">×</button>
    </div>
    <div class="chat-search-results" id="chat-search-results" ${search.html ? '' : 'hidden'}>${search.html}</div>`;
  if (focus) {
    const input = box.querySelector('#chat-search-input');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }
}

function showChatSearchResults(token, query, conversationId) {
  if (token !== state.chatSearchToken) return;
  const needle = query.toLowerCase();
  const results = searchIndexedMessages(query, [conversationId]);
  const index = searchIndexFor(conversationId);
  const searching = !index.complete;
  state.chatSearch.status = `${resultCountText(results.length)}${searching ? ' · searching older messages…' : ''}`;
  state.chatSearch.html = results.length
    ? results.slice(0, MAX_SEARCH_RESULTS).map((item) => searchResultMarkup(item, needle, false)).join('')
    : searching ? '' : '<div class="empty-list">No messages found.</div>';
  const status = document.querySelector('#chat-search-status');
  if (status) status.textContent = state.chatSearch.status;
  const resultsBox = document.querySelector('#chat-search-results');
  if (resultsBox) {
    resultsBox.innerHTML = state.chatSearch.html;
    resultsBox.hidden = !state.chatSearch.html;
  }
}

async function runChatSearch() {
  const conversation = selectedConversation();
  const token = ++state.chatSearchToken;
  const query = state.chatSearch.query.trim();
  if (!conversation || !state.chatSearch.open || query.length < 2) {
    state.chatSearch.status = query.length === 1 ? 'Type at least 2 characters' : '';
    state.chatSearch.html = '';
    renderChatSearch(document.activeElement?.id === 'chat-search-input');
    return;
  }
  const conversationId = String(conversation.id);
  addToSearchIndex(conversationId, state.messages);
  showChatSearchResults(token, query, conversationId);
  try {
    await indexConversation(conversationId, Infinity, () => token !== state.chatSearchToken,
      () => showChatSearchResults(token, query, conversationId));
  } catch (error) {
    if (token !== state.chatSearchToken) return;
    state.chatSearch.status = `Search stopped: ${error.message}`;
    const status = document.querySelector('#chat-search-status');
    if (status) status.textContent = state.chatSearch.status;
    return;
  }
  showChatSearchResults(token, query, conversationId);
}

function scheduleChatSearch() {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(() => void runChatSearch(), 250);
}

// --- Search across all chats (sidebar search) ---

let globalSearchTimer = null;

function globalSearchMarkup() {
  return `
    <div class="search-section-title">Messages</div>
    <div class="global-search-status" id="global-search-status" aria-live="polite">${escapeHtml(state.globalSearch.status)}</div>
    <div class="global-message-results" id="global-message-results">${state.globalSearch.html}</div>`;
}

function showGlobalSearchResults(token, query, conversationIds, scanned) {
  if (token !== state.globalSearchToken) return;
  const done = scanned >= conversationIds.length;
  const results = searchIndexedMessages(query, conversationIds);
  state.globalSearch.status = done
    ? resultCountText(results.length)
    : `Searching messages… (${scanned} of ${conversationIds.length} chats)`;
  state.globalSearch.html = results.length
    ? results.slice(0, MAX_SEARCH_RESULTS).map((item) => searchResultMarkup(item, query.toLowerCase(), true)).join('')
    : done ? '<div class="empty-list">No messages found.</div>' : '';
  const status = document.querySelector('#global-search-status');
  if (status) status.textContent = state.globalSearch.status;
  const box = document.querySelector('#global-message-results');
  if (box) box.innerHTML = state.globalSearch.html;
}

async function runGlobalSearch(query) {
  const token = ++state.globalSearchToken;
  const conversationIds = sortConversationsByLatest(state.conversations).map((conversation) => String(conversation.id));
  if (state.selectedConversationId) addToSearchIndex(state.selectedConversationId, state.messages);
  showGlobalSearchResults(token, query, conversationIds, 0);
  let scanned = 0;
  for (const conversationId of conversationIds) {
    if (token !== state.globalSearchToken) return;
    try {
      await indexConversation(conversationId, GLOBAL_SEARCH_MESSAGES_PER_CHAT, () => token !== state.globalSearchToken);
    } catch {
      // A chat that cannot be read right now is skipped; the others still count.
    }
    scanned += 1;
    showGlobalSearchResults(token, query, conversationIds, scanned);
  }
}

// Called whenever the chat list renders while searching; only a changed
// query starts a new search.
function scheduleGlobalSearch(query) {
  if (state.globalSearch.query === query) return;
  state.globalSearch = { query, status: query.length < 2 ? '' : 'Searching messages…', html: '' };
  state.globalSearchToken += 1;
  clearTimeout(globalSearchTimer);
  if (query.length < 2) return;
  globalSearchTimer = setTimeout(() => void runGlobalSearch(query), 300);
}

async function openSearchResult(conversationId, messageId) {
  if (String(state.selectedConversationId) !== String(conversationId)) {
    const conversation = state.conversations.find((item) => String(item.id) === String(conversationId));
    if (!conversation) throw new Error('This chat is no longer available.');
    const tool = state.sidebarTool;
    if (conversation.type === 'group') await openGroupConversation(conversation.id);
    else await openFriend(conversation.friend?.id);
    // Keep the search results open so the next result is one click away.
    if (tool === 'search' && !state.sidebarTool) {
      state.sidebarTool = 'search';
      renderSidebar();
    }
  }
  await jumpToMessage(messageId);
}

// Scrolls to a message, loading older pages if it is further back in the chat.
async function jumpToMessage(messageId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const row = document.querySelector(`[data-message-row="${CSS.escape(String(messageId))}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('highlight');
      setTimeout(() => row.classList.remove('highlight'), 1600);
      return;
    }
    if (!state.hasOlderMessages) break;
    await loadOlderMessages();
  }
  showNotice('That message is no longer available.');
}

// ---------------------------------------------------------------------------
// Realtime pushes from the API
//
// The API pushes changes the moment they happen, with the message itself, so
// they show up without another request. Anything unexpected falls back to a refresh.
// ---------------------------------------------------------------------------

async function handleMessagePush(event, payload) {
  const conversationId = String(payload?.conversation_id || '');
  if (!conversationId || !payload?.message?.id) return;
  if (!state.conversations.some((conversation) => String(conversation.id) === conversationId)) {
    void refreshData();
    return;
  }
  const message = await decryptForDisplay(conversationId, payload.message);
  const fromOther = String(message.sender?.id) !== String(state.user?.id);
  const isOpen = String(state.selectedConversationId) === conversationId;

  if (event === 'message.updated') {
    const replace = (item) => String(item.id) === String(message.id) ? message : item;
    if (isOpen) {
      state.messages = state.messages.map(replace);
      state.pinnedMessages = state.pinnedMessages.map(replace);
      renderMessages();
    }
    state.conversations = state.conversations.map((conversation) =>
      String(conversation.id) === conversationId && String(conversation.last_message?.id) === String(message.id)
        ? { ...conversation, last_message: message }
        : conversation);
    renderFriendList();
    return;
  }

  if (isOpen) {
    const alreadyShown = state.messages.some((item) => String(item.id) === String(message.id)) ||
      [...state.outgoing.values()].some((entry) => String(entry.message.id) === String(message.id));
    // This device's own send is shown by its own request; skip the echo meanwhile.
    const ownSendInFlight = !fromOther && [...state.outgoing.values()].some((entry) =>
      !entry.confirmed && String(entry.conversationId) === conversationId);
    if (!alreadyShown && !ownSendInFlight) {
      state.messages = [message, ...state.messages];
      renderMessages();
      void cacheMessageImages(conversationId, [message]);
    }
  }

  const readingNow = isOpen && document.hasFocus();
  state.conversations = sortConversationsByLatest(state.conversations.map((conversation) => {
    if (String(conversation.id) !== conversationId) return conversation;
    const newer = !conversation.last_message || Number(message.id) >= Number(conversation.last_message.id);
    return {
      ...conversation,
      last_message: newer ? message : conversation.last_message,
      updated_at: newer ? message.created_at : conversation.updated_at,
      unread_count: fromOther && !readingNow ? (Number(conversation.unread_count) || 0) + 1 : conversation.unread_count,
    };
  }));
  renderFriendList();
  syncUnreadIndicators();

  if (fromOther && readingNow) {
    void api(`/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST' })
      .then(() => announceRead(conversationId))
      .catch(() => {});
  }
  if (fromOther && message.type === 'call' && message.call?.status === 'missed') void loadMissedCallBadge();
}

function handleReadPush(payload) {
  const conversation = selectedConversation();
  if (!conversation || String(payload?.conversation_id) !== String(conversation.id)) return;
  const people = [...(conversation.participants || []), conversation.friend, state.user];
  const user = people.find((person) => String(person?.id) === String(payload.user_id));
  if (!user) return;
  state.readCursors = [
    ...state.readCursors.filter((cursor) => String(cursor.user?.id) !== String(payload.user_id)),
    {
      user: { id: user.id, name: user.name, avatar_url: user.avatar_url },
      last_read_message_id: Number(payload.last_read_message_id),
      read_at: payload.read_at,
    },
  ];
  renderMessages();
}

// ---------------------------------------------------------------------------
// Missed calls badge
// ---------------------------------------------------------------------------

function missedCallSeenKey() {
  return `dailyconnect.lastSeenMissedCall.${state.user?.id}`;
}

function updateMissedCallBadge(count) {
  const badge = document.querySelector('#missed-call-count');
  if (!badge) return;
  badge.textContent = count ? String(count) : '';
  badge.hidden = !count;
  badge.title = count ? `${count} new missed ${count === 1 ? 'call' : 'calls'}` : '';
}

async function loadMissedCallBadge() {
  if (!state.token || !state.user) return;
  try {
    const result = await api('/call-history?filter=missed');
    const calls = Array.isArray(result.data) ? result.data : [];
    state.latestMissedCallId = calls.reduce((latest, call) => Math.max(latest, Number(call.id) || 0), 0);
    let lastSeen = Number(localStorage.getItem(missedCallSeenKey()));
    if (!Number.isFinite(lastSeen) || localStorage.getItem(missedCallSeenKey()) === null) {
      // First run: earlier missed calls are not "new".
      lastSeen = state.latestMissedCallId;
      localStorage.setItem(missedCallSeenKey(), String(lastSeen));
    }
    updateMissedCallBadge(state.sidebarTool === 'calls' ? 0 : calls.filter((call) => Number(call.id) > lastSeen).length);
    if (state.sidebarTool === 'calls') markMissedCallsSeen();
  } catch {
    // The badge is a convenience; call history itself still works.
  }
}

function markMissedCallsSeen() {
  if (!state.user) return;
  localStorage.setItem(missedCallSeenKey(), String(state.latestMissedCallId));
  updateMissedCallBadge(0);
}

// ---------------------------------------------------------------------------
// Read receipts
//
// The API reports how far each member has read. A message shows blue ticks once
// every other member has read it, and each member's photo sits under the newest
// message they have seen (hover it for their name and when they read it).
// ---------------------------------------------------------------------------

function hasUnreadFromOthers() {
  const mine = state.readCursors.find((cursor) => String(cursor.user?.id) === String(state.user?.id));
  const lastRead = Number(mine?.last_read_message_id) || 0;
  return state.messages.some((message) => !message.pending &&
    String(message.sender?.id) !== String(state.user.id) &&
    // Without a read position yet (older chats), fall back to the message's read time.
    (mine ? Number(message.id) > lastRead : !message.read_at));
}

function announceRead(conversationId) {
  return window.chatSocket?.notifyRead?.(conversationId).catch(() => false);
}

function otherMembers(message) {
  const conversation = selectedConversation();
  if (!conversation) return [];
  const members = conversation.type === 'group' ? conversation.participants || [] : [conversation.friend];
  return members.filter((member) => member?.id && String(member.id) !== String(message.sender?.id));
}

function readStatus(message) {
  const members = otherMembers(message);
  const readers = new Set(state.readCursors
    .filter((cursor) => Number(cursor.last_read_message_id) >= Number(message.id))
    .map((cursor) => String(cursor.user?.id)));
  if (members.length && members.every((member) => readers.has(String(member.id)))) return 'read';
  // Older direct chats may only have the message's own read time.
  if (!members.length || selectedConversation()?.type !== 'group') {
    if (message.read_at) return 'read';
  }
  return message.read_at || message.delivered_at ? 'delivered' : 'sent';
}

// Maps message id -> members whose newest seen message it is (excluding me).
function seenByMarkers() {
  const markers = new Map();
  const confirmed = state.messages.filter((message) => !message.pending);
  for (const cursor of state.readCursors) {
    if (!cursor.user?.id || String(cursor.user.id) === String(state.user?.id)) continue;
    const lastRead = Number(cursor.last_read_message_id);
    const message = confirmed.find((item) => Number(item.id) <= lastRead &&
      String(item.sender?.id) !== String(cursor.user.id));
    if (!message) continue;
    const key = String(message.id);
    if (!markers.has(key)) markers.set(key, []);
    markers.get(key).push(cursor);
  }
  return markers;
}

function seenByMarkup(cursors, alignEnd) {
  if (!cursors?.length) return '';
  const names = cursors.map((cursor) => cursor.user.name).join(', ');
  return `<div class="seen-by${alignEnd ? ' mine' : ''}" aria-label="Seen by ${escapeHtml(names)}">
      ${cursors.map((cursor) => {
        const label = `Seen by ${cursor.user.name}${cursor.read_at ? ` · ${formattedTime(cursor.read_at)}` : ''}`;
        return `<span class="seen-avatar" tabindex="0" data-name="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${avatarMarkup(cursor.user, 'seen')}</span>`;
      }).join('')}
    </div>`;
}

function renderMessages() {
  const list = document.querySelector('#message-list');
  if (!list) return;
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (!state.messages.length) {
    list.innerHTML = state.messagesLoading
      ? '<div class="empty-list chat-empty">Loading messages…</div>'
      : '<div class="empty-list chat-empty">Say hello and start the conversation.</div>';
    return;
  }

  const orderedMessages = [...state.messages].reverse();
  const seenBy = seenByMarkers();
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
    if (message.type === 'call' && message.call) {
      const missed = message.call.status === 'missed' && !isMine;
      const title = messagePreview(message);
      const icon = missed ? '↙' : (isMine ? '↗' : '↙');
      return `${divider}
        <div class="call-log-row${missed ? ' missed' : ''}" role="note">
          <span class="call-log-icon" aria-hidden="true">${icon}</span>
          <span class="call-log-details">
            <strong>${escapeHtml(title)}</strong>
            <time>${formattedTime(message.created_at)}</time>
          </span>
        </div>
        ${seenByMarkup(seenBy.get(String(message.id)), isMine)}`;
    }
    const receipt = message.pending
      ? '<span class="message-receipt pending" aria-label="Sending" title="Sending">🕓</span>'
      : !isDeleted && isMine
      ? (() => {
        const status = readStatus(message);
        const group = selectedConversation()?.type === 'group';
        const label = status === 'read' ? (group ? 'Read by everyone' : 'Read') : status === 'delivered' ? 'Delivered' : 'Sent';
        return `<span class="message-receipt ${status}" aria-label="${label}" title="${label}">${status === 'sent' ? '✓' : '✓✓'}</span>`;
      })()
      : '';
    const cacheKey = attachmentCacheKey(message.conversation_id, message.id);
    const imagePreview = message.attachment && CACHED_IMAGE_TYPES.has(message.attachment.mime)
      ? state.cachedAttachments.get(cacheKey)
      : null;
    const bodyMarkup = !isDeleted && message.body
      ? `<div class="message-text">${linkifyMessageText(message.body)}</div>`
      : '';
    const imageMarkup = !isDeleted && imagePreview
      ? `<button class="message-image-button" type="button" data-action="preview-image" data-image-url="${escapeHtml(imagePreview)}" data-image-name="${escapeHtml(message.attachment.name)}" aria-label="View ${escapeHtml(message.attachment.name)} full size"><img class="message-image" src="${escapeHtml(imagePreview)}" alt="${escapeHtml(message.attachment.name)}" loading="lazy" decoding="async"></button>`
      : '';
    const isVoice = message.type === 'voice' && Boolean(message.attachment);
    const voiceMarkup = !isDeleted && isVoice ? voiceMessageMarkup(message) : '';
    const isProtected = message.type === 'protected' && Boolean(message.protected);
    const protectedMarkup = !isDeleted && isProtected ? protectedMessageMarkup(message) : '';
    const attachmentMarkup = !isDeleted && message.attachment && !isVoice
      ? `<button class="attachment-download" type="button" data-action="download-attachment" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.attachment.name)} · ${formatFileSize(message.attachment.size)} · Download</button>`
      : '';
    const imageWithCaption = message.attachment && CACHED_IMAGE_TYPES.has(message.attachment.mime);
    const inlineTextFooter = !isDeleted && Boolean(message.body) && !message.attachment;
    const editedLabel = message.edited_at && !isDeleted
      ? `<span class="message-edited" title="Edited ${escapeHtml(formattedTime(message.edited_at))}">edited</span> `
      : '';
    const pinnedLabel = message.pinned_at && !isDeleted ? '<span class="message-pinned" title="Pinned">📌</span> ' : '';
    const messageFooter = `<div class="message-foot"><span>${pinnedLabel}${editedLabel}${formattedTime(message.created_at)}${receipt ? ` ${receipt}` : ''}</span></div>`;
    const replyPreview = message.reply_to
      ? `<div class="message-quote"><strong>${escapeHtml(message.reply_to.sender?.name || 'Message')}</strong><span>${escapeHtml(messageSummary(message.reply_to))}</span></div>`
      : '';
    const forwardedLabel = message.is_forwarded ? '<div class="message-forwarded">↗ Forwarded</div>' : '';
    return `${divider}
      <div class="message-row ${isMine ? 'mine' : ''}" data-message-row="${escapeHtml(message.id)}">
        ${isMine ? '' : messageAvatar(message)}
        <div class="message-bubble">
          ${forwardedLabel}
          ${replyPreview}
          ${isDeleted ? '<div class="message-deleted">This message was deleted</div>' : ''}
          ${voiceMarkup}
          ${protectedMarkup}
          ${inlineTextFooter
            ? `<div class="message-content">${bodyMarkup}${messageFooter}</div>`
            : imageWithCaption ? `${imageMarkup}${bodyMarkup}${attachmentMarkup}` : `${bodyMarkup}${imageMarkup}${attachmentMarkup}`}
          ${!isDeleted && !message.pending ? `<details class="message-menu ${isMine ? 'mine' : 'other'}">
            <summary aria-label="Message options" title="Message options">⋯</summary>
            <div class="message-menu-items" role="menu" aria-label="Message options">
              <button type="button" role="menuitem" data-action="reply-message" data-message-id="${escapeHtml(message.id)}">↩ <span>Reply</span></button>
              ${canPinMessage(message) ? `<button type="button" role="menuitem" data-action="toggle-pin" data-message-id="${escapeHtml(message.id)}">📌 <span>${message.pinned_at ? 'Unpin' : 'Pin'}</span></button>` : ''}
              ${canEditMessage(message) ? `<button type="button" role="menuitem" data-action="edit-message" data-message-id="${escapeHtml(message.id)}">✎ <span>Edit</span></button>` : ''}
              <button type="button" role="menuitem" data-action="forward-message" data-message-id="${escapeHtml(message.id)}">↗ <span>Forward</span></button>
              ${isVoice || (isProtected && !state.unlockedMessages.has(String(message.id))) ? '' : `<button type="button" role="menuitem" data-action="copy-message" data-message-id="${escapeHtml(message.id)}">⧉ <span>Copy message</span></button>`}
              <button type="button" role="menuitem" data-action="delete-message-for-me" data-message-id="${escapeHtml(message.id)}">⌫ <span>Delete for me</span></button>
              ${isMine ? `<button type="button" role="menuitem" data-action="delete-message-for-everyone" data-message-id="${escapeHtml(message.id)}">× <span>Delete for everyone</span></button>` : ''}
            </div>
          </details>` : ''}
          ${inlineTextFooter ? '' : messageFooter}
        </div>
      </div>
      ${seenByMarkup(seenBy.get(String(message.id)), isMine)}`;
  }).join('');
  list.insertAdjacentHTML('afterbegin', state.hasOlderMessages
    ? `<div class="history-loader" id="history-loader" aria-live="polite">${state.loadingOlderMessages ? 'Loading earlier messages…' : ''}</div>`
    : '<div class="history-start">Start of conversation</div>');
  updateVoiceViews();
  renderPinnedBar();
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
  // If the loaded messages do not fill the screen there is nothing to scroll, so
  // fetch older ones straight away.
  if (state.hasOlderMessages && !state.loadingOlderMessages && list.scrollHeight <= list.clientHeight + 40) {
    void loadOlderMessages();
  }
}

// Loads the page of messages just before the oldest one shown, keeping the
// view anchored so the messages being read do not jump.
async function loadOlderMessages() {
  const conversation = selectedConversation();
  if (!conversation || !state.hasOlderMessages || state.loadingOlderMessages) return;
  const oldestId = state.messages.reduce((oldest, message) =>
    message.pending ? oldest : Math.min(oldest, Number(message.id)), Infinity);
  if (!Number.isFinite(oldestId)) return;

  const conversationId = String(conversation.id);
  state.loadingOlderMessages = true;
  const loader = document.querySelector('#history-loader');
  if (loader) loader.textContent = 'Loading earlier messages…';
  try {
    const payload = await api(
      `/conversations/${encodeURIComponent(conversationId)}/messages?before_id=${oldestId}&limit=${MESSAGE_PAGE_SIZE}`,
    );
    if (String(state.selectedConversationId) !== conversationId) return;
    const older = await decryptMessagesForDisplay(conversationId, Array.isArray(payload.data) ? payload.data : []);
    if (String(state.selectedConversationId) !== conversationId) return;
    const known = new Set(state.messages.map((message) => String(message.id)));
    const list = document.querySelector('#message-list');
    const distanceFromBottom = list ? list.scrollHeight - list.scrollTop : 0;
    state.messages = [...state.messages, ...older.filter((message) => !known.has(String(message.id)))];
    state.hasOlderMessages = Boolean(payload.has_more);
    state.loadingOlderMessages = false;
    renderMessages();
    if (list) list.scrollTop = list.scrollHeight - distanceFromBottom;
    void cacheMessageImages(conversationId, older);
  } catch (error) {
    showNotice(`Earlier messages could not be loaded: ${error.message}`);
  } finally {
    state.loadingOlderMessages = false;
    const currentLoader = document.querySelector('#history-loader');
    if (currentLoader) currentLoader.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Voice messages
//
// The message list is rebuilt on every update, so playback lives in a single
// shared Audio element (state.voicePlayer) and the bubbles only mirror it.
// ---------------------------------------------------------------------------

function voiceKey(conversationId, messageId) {
  return attachmentCacheKey(conversationId, messageId);
}

function voiceMessageMarkup(message) {
  const key = voiceKey(message.conversation_id, message.id);
  const label = `Voice message, ${formatCallDuration(message.voice?.duration_seconds)}`;
  return `<div class="voice-message" data-voice-key="${escapeHtml(key)}">
      <button class="voice-play" type="button" data-action="toggle-voice" data-message-id="${escapeHtml(message.id)}" aria-label="Play ${escapeHtml(label)}" title="Play">▶</button>
      <div class="voice-track" data-action="seek-voice" data-message-id="${escapeHtml(message.id)}" role="slider" aria-label="Playback position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1"><div class="voice-progress"></div></div>
      <span class="voice-time">${escapeHtml(formatCallDuration(message.voice?.duration_seconds))}</span>
    </div>`;
}

function updateVoiceViews() {
  const player = state.voicePlayer;
  document.querySelectorAll('.voice-message[data-voice-key]').forEach((element) => {
    const message = state.messages.find((item) =>
      voiceKey(item.conversation_id, item.id) === element.dataset.voiceKey);
    const totalSeconds = Number(message?.voice?.duration_seconds) || 0;
    const active = player && player.key === element.dataset.voiceKey;
    const playing = active && player.status === 'playing';
    const loading = active && player.status === 'loading';
    const audioDuration = active && Number.isFinite(player.audio.duration) ? player.audio.duration : totalSeconds;
    const position = active ? player.audio.currentTime : 0;
    const percent = audioDuration > 0 ? Math.min(100, (position / audioDuration) * 100) : 0;

    const button = element.querySelector('.voice-play');
    button.textContent = loading ? '…' : playing ? '❚❚' : '▶';
    button.title = playing ? 'Pause' : 'Play';
    button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} voice message`);
    element.classList.toggle('playing', Boolean(playing));
    element.querySelector('.voice-progress').style.width = `${percent}%`;
    element.querySelector('.voice-track').setAttribute('aria-valuenow', String(Math.round(percent)));
    element.querySelector('.voice-time').textContent = formatCallDuration(
      active && position > 0 ? position : totalSeconds,
    );
  });
}

function stopVoicePlayback() {
  const player = state.voicePlayer;
  if (!player) return;
  state.voicePlayer = null;
  player.audio.pause();
  player.audio.removeAttribute('src');
  updateVoiceViews();
}

function releaseVoiceBlobs() {
  stopVoicePlayback();
  for (const url of state.voiceBlobUrls.values()) URL.revokeObjectURL(url);
  state.voiceBlobUrls.clear();
}

async function toggleVoicePlayback(messageId) {
  const message = state.messages.find((item) => String(item.id) === String(messageId));
  if (!message || message.type !== 'voice' || !message.attachment) {
    throw new Error('This voice message is no longer available.');
  }
  const key = voiceKey(message.conversation_id, message.id);
  const current = state.voicePlayer;
  if (current?.key === key) {
    if (current.status === 'loading') return;
    if (current.audio.paused) await current.audio.play();
    else current.audio.pause();
    return;
  }

  stopVoicePlayback();
  const audio = new Audio();
  const player = { key, audio, status: 'loading' };
  state.voicePlayer = player;
  updateVoiceViews();

  try {
    let url = state.voiceBlobUrls.get(key);
    if (!url) {
      const blob = await fetchAttachmentBlob(message.conversation_id, message);
      if (!blob.type.startsWith('audio/')) throw new Error('The voice message could not be verified.');
      url = URL.createObjectURL(blob);
      state.voiceBlobUrls.set(key, url);
    }
    if (state.voicePlayer !== player) return;

    const sync = (status) => () => {
      if (state.voicePlayer !== player) return;
      if (status) player.status = status;
      updateVoiceViews();
    };
    audio.addEventListener('playing', sync('playing'));
    audio.addEventListener('pause', sync('paused'));
    audio.addEventListener('timeupdate', sync());
    audio.addEventListener('ended', () => {
      if (state.voicePlayer !== player) return;
      stopVoicePlayback();
    });
    audio.src = url;
    await audio.play();
  } catch (error) {
    if (state.voicePlayer === player) stopVoicePlayback();
    throw new Error(`The voice message could not be played: ${error.message}`);
  }
}

function seekVoice(track, clientX) {
  const player = state.voicePlayer;
  const element = track.closest('.voice-message');
  if (!player || element?.dataset.voiceKey !== player.key || player.status === 'loading') return;
  const duration = Number.isFinite(player.audio.duration)
    ? player.audio.duration
    : Number(state.messages.find((item) =>
      voiceKey(item.conversation_id, item.id) === player.key)?.voice?.duration_seconds) || 0;
  if (!duration) return;
  const bounds = track.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  player.audio.currentTime = fraction * duration;
  updateVoiceViews();
}

function renderVoiceRecorder() {
  const recorder = document.querySelector('#voice-recorder');
  const form = document.querySelector('#message-form');
  if (!recorder || !form) return;
  const recording = state.voiceRecording;
  const visible = Boolean(recording &&
    String(recording.conversationId) === String(state.selectedConversationId));
  recorder.hidden = !visible;
  form.hidden = visible;
  if (!visible) {
    recorder.replaceChildren();
    return;
  }
  recorder.innerHTML = `
    <button class="voice-recorder-cancel" type="button" data-action="cancel-voice-recording" aria-label="Discard recording" title="Discard recording"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
    <span class="voice-recorder-dot" aria-hidden="true"></span>
    <span class="voice-recorder-time" id="voice-recorder-time" aria-live="off">0:00</span>
    <span class="voice-recorder-hint">Recording… up to ${formatCallDuration(MAX_VOICE_SECONDS)}</span>
    <button class="send-button" type="button" data-action="send-voice-recording" aria-label="Send voice message" title="Send voice message">➤</button>`;
  updateVoiceRecorderTime();
}

function updateVoiceRecorderTime() {
  const recording = state.voiceRecording;
  const label = document.querySelector('#voice-recorder-time');
  if (!recording || !label) return;
  label.textContent = formatCallDuration((Date.now() - recording.startedAt) / 1000);
}

async function startVoiceRecording() {
  const conversation = selectedConversation();
  if (!conversation || state.voiceRecording) return;
  if (state.call) throw new Error('Voice messages cannot be recorded during a call.');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Voice recording is not supported on this device.');
  }
  const mimeType = VOICE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This device cannot record audio in a supported format.');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new Error(`Could not access your microphone: ${error.message}`);
  }
  if (String(state.selectedConversationId) !== String(conversation.id) || state.voiceRecording || state.call) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  stopVoicePlayback();
  stopLocalTyping();
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
  const recording = {
    recorder,
    stream,
    mimeType,
    chunks: [],
    conversationId: conversation.id,
    startedAt: Date.now(),
    timer: null,
    stopped: new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true })),
  };
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) recording.chunks.push(event.data);
  });
  recorder.start(1000);
  recording.timer = setInterval(() => {
    updateVoiceRecorderTime();
    if (Date.now() - recording.startedAt >= MAX_VOICE_SECONDS * 1000) {
      void finishVoiceRecording(true).catch((error) => showNotice(error.message));
    }
  }, 250);
  state.voiceRecording = recording;
  renderVoiceRecorder();
}

async function stopRecorder(recording) {
  clearInterval(recording.timer);
  if (recording.recorder.state !== 'inactive') recording.recorder.stop();
  await recording.stopped;
  recording.stream.getTracks().forEach((track) => track.stop());
}

function cancelVoiceRecording() {
  const recording = state.voiceRecording;
  if (!recording) return;
  state.voiceRecording = null;
  renderVoiceRecorder();
  void stopRecorder(recording);
}

async function finishVoiceRecording(send) {
  const recording = state.voiceRecording;
  if (!recording) return;
  state.voiceRecording = null;
  const elapsed = Date.now() - recording.startedAt;
  renderVoiceRecorder();
  await stopRecorder(recording);
  if (!send) return;
  if (elapsed < MIN_VOICE_MILLISECONDS) {
    showNotice('Hold on a little longer — voice messages must be at least 1 second.');
    return;
  }

  const baseType = recording.mimeType.split(';')[0];
  const blob = new Blob(recording.chunks, { type: baseType });
  if (!blob.size) throw new Error('No audio was captured. Check your microphone and try again.');
  if (blob.size > MAX_ATTACHMENT_SIZE) throw new Error('The voice message is too large to send.');

  const conversationId = recording.conversationId;
  const replyTarget = String(state.selectedConversationId) === String(conversationId) ? state.replyTarget : null;
  const extension = baseType === 'audio/ogg' ? 'ogg' : 'webm';
  const encryptedVoice = await encryptFileBytes(new Uint8Array(await blob.arrayBuffer()));
  const voiceDetails = {
    name: `voice-message.${extension}`,
    mime: baseType,
    size: blob.size,
    key: encryptedVoice.key,
    iv: encryptedVoice.iv,
  };
  const sentMessage = await decryptForDisplay(conversationId, await sendEncrypted(
    conversationId,
    { text: null, file: voiceDetails },
    (encrypted) => {
      const payload = new FormData();
      payload.append('body', encrypted.body);
      payload.append('encrypted', '1');
      payload.append('key_version', String(encrypted.key_version));
      payload.append('voice', new Blob([encryptedVoice.data], { type: 'application/octet-stream' }), 'encrypted.bin');
      payload.append('voice_duration_seconds', String(Math.min(MAX_VOICE_SECONDS, Math.max(1, Math.round(elapsed / 1000)))));
      if (replyTarget) payload.append('reply_to_message_id', replyTarget.id);
      return api(`/conversations/${encodeURIComponent(conversationId)}/messages`, { method: 'POST', body: payload });
    },
  ));
  state.voiceBlobUrls.set(voiceKey(conversationId, sentMessage.id), URL.createObjectURL(blob));
  if (replyTarget && state.replyTarget === replyTarget) {
    state.replyTarget = null;
    updateReplyPreview();
  }
  applySentMessage(conversationId, sentMessage);
  void notifyMessageSent(conversationId, sentMessage.id);
}

// ---------------------------------------------------------------------------
// Protected messages
//
// The text is encrypted here with AES-256-GCM under a key derived (PBKDF2) from
// a random one-time password. Only the encrypted envelope is sent; the password
// is shown once to the sender, who passes it on in person.
// ---------------------------------------------------------------------------

function generateProtectedPassword() {
  const limit = 256 - (256 % PROTECTED_ALPHABET.length);
  const characters = [];
  while (characters.length < PROTECTED_PASSWORD_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && characters.length < PROTECTED_PASSWORD_LENGTH) {
        characters.push(PROTECTED_ALPHABET[byte % PROTECTED_ALPHABET.length]);
      }
    }
  }
  return characters.join('').match(/.{4}/g).join('-');
}

// Passwords are typed by hand, so spacing, dashes, and letter case are ignored.
function normalizeProtectedPassword(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveProtectedKey(password, salt, iterations, usage) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalizeProtectedPassword(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function encryptProtectedMessage(plaintext) {
  const password = generateProtectedPassword();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveProtectedKey(password, salt, PROTECTED_KDF_ITERATIONS, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return {
    password,
    // Key order matters: the API checks the envelope's exact shape.
    envelope: {
      v: 1,
      alg: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iter: PROTECTED_KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ciphertext)),
    },
  };
}

async function decryptProtectedMessage(envelope, password) {
  if (envelope?.v !== 1 || envelope.alg !== 'AES-256-GCM' || envelope.kdf !== 'PBKDF2-SHA256' ||
    !Number.isInteger(envelope.iter)) {
    throw new Error('This protected message uses a format this app cannot open.');
  }
  const key = await deriveProtectedKey(password, base64ToBytes(envelope.salt), envelope.iter, 'decrypt');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ct),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Incorrect password. Check it and try again.');
  }
}

function protectedMessageMarkup(message) {
  const unlocked = state.unlockedMessages.get(String(message.id));
  if (unlocked !== undefined) {
    return `<div class="protected-message unlocked">
        <div class="protected-header"><span>🔓 Protected message</span><button class="text-button" type="button" data-action="lock-protected" data-message-id="${escapeHtml(message.id)}">Hide</button></div>
        <div class="message-text">${linkifyMessageText(unlocked)}</div>
      </div>`;
  }
  return `<div class="protected-message">
      <span class="protected-icon" aria-hidden="true">🔒</span>
      <span class="protected-text"><strong>Protected message</strong><span>Enter the password to view it.</span></span>
      <button class="small-button" type="button" data-action="unlock-protected" data-message-id="${escapeHtml(message.id)}">Unlock</button>
    </div>`;
}

function renderProtectedComposeModal() {
  const modalRoot = document.querySelector('#modal-root');
  const conversation = selectedConversation();
  if (!modalRoot || !conversation) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <form class="app-modal protected-modal" id="protected-message-form" role="dialog" aria-modal="true" aria-labelledby="protected-modal-title" data-conversation-id="${escapeHtml(conversation.id)}">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button>
        <h2 id="protected-modal-title">Send a protected message</h2>
        <p class="modal-subtitle">To ${escapeHtml(conversationTitle(conversation))}. The text is encrypted on this computer and a one-time password is generated. Only someone with the password can read it.</p>
        <textarea class="protected-input" name="secret" rows="6" maxlength="${MAX_PROTECTED_LENGTH}" placeholder="For example: login details, account numbers…" aria-label="Protected message text" required spellcheck="false" autocomplete="off"></textarea>
        <footer class="forward-modal-actions">
          <span class="forward-selection-count">Up to ${MAX_PROTECTED_LENGTH} characters</span>
          <button class="primary-button" type="submit">Encrypt and send</button>
        </footer>
      </form>
    </div>`;
  modalRoot.querySelector('textarea')?.focus();
}

function renderProtectedPasswordModal(password, conversationName) {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot) return;
  // Sticky: a stray click or Escape must not dismiss the only copy of the password.
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop data-sticky>
      <section class="app-modal protected-modal" role="dialog" aria-modal="true" aria-labelledby="protected-password-title">
        <h2 id="protected-password-title">Protected message sent</h2>
        <p class="modal-subtitle">Give this password to ${escapeHtml(conversationName)} in person. It is not stored anywhere and will not be shown again. Without it, the message cannot be opened.</p>
        <div class="protected-password" id="protected-password">${escapeHtml(password)}</div>
        <footer class="forward-modal-actions">
          <button class="small-button" type="button" data-action="copy-protected-password" data-password="${escapeHtml(password)}">Copy password</button>
          <button class="primary-button" type="button" data-action="close-modal">Done</button>
        </footer>
      </section>
    </div>`;
}

function renderUnlockModal(message) {
  const modalRoot = document.querySelector('#modal-root');
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <form class="app-modal protected-modal" id="unlock-protected-form" role="dialog" aria-modal="true" aria-labelledby="unlock-modal-title" data-message-id="${escapeHtml(message.id)}">
        <button class="modal-close" type="button" data-action="close-modal" aria-label="Close">×</button>
        <h2 id="unlock-modal-title">Unlock protected message</h2>
        <p class="modal-subtitle">From ${escapeHtml(message.sender?.name || 'a contact')}. Enter the password they gave you. Dashes, spaces, and letter case do not matter.</p>
        <input class="protected-password-input" name="password" type="text" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" aria-label="Password" required spellcheck="false" autocomplete="off">
        <p class="protected-error" id="unlock-error" role="alert" hidden></p>
        <footer class="forward-modal-actions">
          <span></span>
          <button class="primary-button" type="submit">Unlock</button>
        </footer>
      </form>
    </div>`;
  modalRoot.querySelector('input')?.focus();
}

async function handleSendProtected(form) {
  const plaintext = form.elements.secret.value;
  if (!plaintext.trim()) throw new Error('Enter the text you want to protect.');
  if (plaintext.length > MAX_PROTECTED_LENGTH) {
    throw new Error(`Protected messages can be up to ${MAX_PROTECTED_LENGTH} characters.`);
  }
  const conversationId = form.dataset.conversationId;
  const conversation = state.conversations.find((item) => String(item.id) === String(conversationId));
  if (!conversation) throw new Error('This conversation is no longer available.');

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Encrypting…';
  try {
    const { password, envelope } = await encryptProtectedMessage(plaintext);
    const sentMessage = await api(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: { type: 'protected', body: JSON.stringify(envelope) },
    });
    form.elements.secret.value = '';
    renderProtectedPasswordModal(password, conversationTitle(conversation));
    applySentMessage(conversationId, sentMessage);
    void notifyMessageSent(conversationId, sentMessage.id);
  } finally {
    if (submitButton.isConnected) {
      submitButton.disabled = false;
      submitButton.textContent = 'Encrypt and send';
    }
  }
}

async function handleUnlockProtected(form) {
  const message = state.messages.find((item) => String(item.id) === String(form.dataset.messageId));
  if (!message?.protected) throw new Error('This message is no longer available.');
  const error = form.querySelector('#unlock-error');
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Unlocking…';
  error.hidden = true;
  try {
    const plaintext = await decryptProtectedMessage(message.protected, form.elements.password.value);
    state.unlockedMessages.set(String(message.id), plaintext);
    closeModal();
    renderMessages();
  } catch (unlockError) {
    error.textContent = unlockError.message;
    error.hidden = false;
    form.elements.password.select();
  } finally {
    if (submitButton.isConnected) {
      submitButton.disabled = false;
      submitButton.textContent = 'Unlock';
    }
  }
}

function updateReplyPreview() {
  const preview = document.querySelector('#reply-preview');
  if (!preview) return;
  const editing = state.editTarget &&
    String(state.editTarget.conversation_id) === String(state.selectedConversationId)
    ? state.editTarget
    : null;
  const message = editing || state.replyTarget;
  preview.hidden = !message;
  preview.classList.toggle('editing', Boolean(editing));
  preview.innerHTML = editing ? `
    <div class="reply-preview-content">
      <strong>Editing message</strong>
      <span>${escapeHtml(editing.body)}</span>
    </div>
    <button class="reply-preview-cancel" type="button" data-action="cancel-edit" aria-label="Cancel editing">×</button>`
    : message ? `
    <div class="reply-preview-content">
      <strong>Replying to ${escapeHtml(message.sender?.name || 'message')}</strong>
      <span>${escapeHtml(messageSummary(message))}</span>
    </div>
    <button class="reply-preview-cancel" type="button" data-action="cancel-reply" aria-label="Cancel reply">×</button>` : '';
  const sendButton = document.querySelector('#message-form .send-button');
  if (sendButton) {
    sendButton.textContent = editing ? '✓' : '➤';
    sendButton.setAttribute('aria-label', editing ? 'Save edited message' : 'Send message');
  }
}

function beginReply(message) {
  if (state.editTarget) cancelEdit();
  state.replyTarget = message;
  updateReplyPreview();
  document.querySelector('#message-form textarea')?.focus();
}

function beginEdit(message) {
  if (!canEditMessage(message)) {
    throw new Error(`Messages can only be edited within ${messageEditMinutes()} minutes of sending.`);
  }
  state.replyTarget = null;
  state.editTarget = message;
  updateReplyPreview();
  const field = document.querySelector('#message-form textarea');
  if (field) {
    field.value = message.body;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
}

function cancelEdit() {
  if (!state.editTarget) return;
  state.editTarget = null;
  const field = document.querySelector('#message-form textarea');
  if (field) field.value = '';
  updateReplyPreview();
}

async function saveEditedMessage(message, field) {
  const body = field.value.trim();
  if (!body) throw new Error('The message cannot be empty. Use Delete to remove it instead.');
  if (body === message.body) {
    cancelEdit();
    return;
  }
  const conversationId = message.conversation_id;
  const updated = await decryptForDisplay(conversationId, await sendEncrypted(conversationId, { text: body }, (encrypted) => api(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(message.id)}`,
    { method: 'PATCH', body: encrypted },
  )));
  if (state.editTarget === message) {
    state.editTarget = null;
    field.value = '';
    updateReplyPreview();
  }
  state.messages = state.messages.map((item) => String(item.id) === String(updated.id) ? updated : item);
  state.conversations = state.conversations.map((conversation) =>
    String(conversation.last_message?.id) === String(updated.id)
      ? { ...conversation, last_message: updated }
      : conversation);
  renderMessages();
  renderFriendList();
  // Recipients reload the conversation and pick up the new text.
  void notifyMessageSent(conversationId, updated.id);
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

// Renders the red unread badge overlaid on the Windows taskbar icon.
// Returns a PNG data URL, or null when there is nothing to show.
function renderTaskbarBadge(count) {
  if (!Number.isSafeInteger(count) || count < 1) return null;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const label = count > 99 ? '99+' : String(count);

  ctx.fillStyle = '#e5362f';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontSize = label.length >= 3 ? 14 : label.length === 2 ? 17 : 21;
  ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillText(label, size / 2, size / 2 + 1);

  return canvas.toDataURL('image/png');
}

function syncUnreadIndicators() {
  const unreadCount = state.conversations.reduce((total, conversation) => {
    const count = Number(conversation.unread_count);
    return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
  }, 0);
  const shouldNotify = state.settings.notifications &&
    state.unreadCount !== null && unreadCount > state.unreadCount;
  state.unreadCount = unreadCount;
  notifyNewMessages();

  const othersUnread = state.conversations.filter(isOthersConversation).reduce((total, conversation) => {
    const count = Number(conversation.unread_count);
    return total + (Number.isSafeInteger(count) && count > 0 ? count : 0);
  }, 0);
  const chatsUnread = unreadCount - othersUnread;
  const unreadLabel = document.querySelector('#unread-message-count');
  if (unreadLabel) {
    unreadLabel.textContent = String(chatsUnread);
    unreadLabel.title = `${chatsUnread} unread`;
    unreadLabel.hidden = chatsUnread === 0;
  }
  const othersLabel = document.querySelector('#others-unread-count');
  if (othersLabel) {
    othersLabel.textContent = String(othersUnread);
    othersLabel.title = `${othersUnread} unread from people who are not your friends`;
    othersLabel.hidden = othersUnread === 0;
  }
  document.title = unreadCount ? `(${unreadCount}) DailyConnect — Messages` : 'DailyConnect — Messages';
  window.desktopApp?.setUnreadCount(unreadCount, shouldNotify, renderTaskbarBadge(unreadCount));
}

// Shows a desktop notification for each conversation whose unread count grew
// since the last sync. The first sync after sign-in only records the counts.
function notifyNewMessages() {
  const previous = state.unreadByConversation;
  state.unreadByConversation = new Map(state.conversations.map((conversation) =>
    [String(conversation.id), Number(conversation.unread_count) || 0]));
  if (!previous || !state.settings.notifications || document.hasFocus()) return;

  const grown = state.conversations.filter((conversation) => {
    const message = conversation.last_message;
    return (Number(conversation.unread_count) || 0) > (previous.get(String(conversation.id)) || 0) &&
      message && String(message.sender?.id) !== String(state.user?.id);
  });
  for (const conversation of grown.slice(0, 3)) {
    const message = conversation.last_message;
    const content = state.settings.blurMessages ? 'New message' : messagePreview(message, 'New message');
    window.desktopApp?.showNotification({
      title: conversationTitle(conversation),
      body: conversation.type === 'group' && message.sender?.name ? `${message.sender.name}: ${content}` : content,
      conversationId: Number(conversation.id),
    });
  }
}

async function openConversationById(conversationId) {
  const conversation = state.conversations.find((item) => String(item.id) === String(conversationId));
  if (!conversation) return;
  if (conversation.type === 'group') await openGroupConversation(conversation.id);
  else if (conversation.friend?.id) await openFriend(conversation.friend.id);
}

function formatFileSize(size) {
  const bytes = Number(size) || 0;
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadMessages({ markRead = true, cacheImages = true } = {}) {
  const conversation = selectedConversation();
  if (!conversation) {
    state.messages = [];
    return;
  }
  const newestPagePath = `/conversations/${encodeURIComponent(conversation.id)}/messages?limit=${MESSAGE_PAGE_SIZE}`;
  const applyPage = async (payload) => {
    const newest = await decryptMessagesForDisplay(conversation.id, Array.isArray(payload.data) ? payload.data : []);
    // Keep older pages the user already scrolled back to; a refresh only
    // reloads the newest page.
    const oldestNewId = newest.length ? Math.min(...newest.map((message) => Number(message.id))) : Infinity;
    const olderLoaded = state.messages.filter((message) => !message.pending &&
      String(message.conversation_id) === String(conversation.id) &&
      Number(message.id) < oldestNewId);
    state.messages = withOutgoing(conversation.id, [...newest, ...olderLoaded]);
    if (!olderLoaded.length) state.hasOlderMessages = Boolean(payload.has_more);
    state.readCursors = Array.isArray(payload.read_cursors) ? payload.read_cursors : [];
    state.pinnedMessages = await decryptMessagesForDisplay(
      conversation.id, Array.isArray(payload.pinned) ? payload.pinned : [],
    );
    state.pinIndex = Math.min(state.pinIndex, Math.max(0, state.pinnedMessages.length - 1));
  };
  await applyPage(await api(newestPagePath));
  if (markRead && document.hasFocus() && hasUnreadFromOthers()) {
    await api(`/conversations/${encodeURIComponent(conversation.id)}/read`, { method: 'POST' });
    void announceRead(conversation.id);
    await applyPage(await api(newestPagePath));
    conversation.unread_count = 0;
    renderSidebar();
    syncUnreadIndicators();
  }
  // Images download in the background; each one appears as soon as it is ready.
  if (cacheImages) void cacheMessageImages(conversation.id, state.messages);
}

async function notifyMessageSent(conversationId, messageId) {
  if (!window.chatSocket || !state.socketConnected) {
    showNotice('Message sent, but realtime is disconnected. It will sync when the connection is restored.');
    return;
  }
  try {
    const sent = await window.chatSocket.notifyMessage(conversationId, messageId);
    if (!sent) {
      showNotice('Message sent, but realtime is disconnected. It will sync when the connection is restored.');
    }
  } catch (error) {
    showNotice(`Message sent, but its real-time update could not be published: ${error.message}`);
  }
}

async function refreshData() {
  if (!state.token) return;
  if (state.refreshing) {
    state.refreshPending = true;
    return;
  }
  state.refreshing = true;
  try {
    const membershipRevisionsAtStart = new Map(state.groupMembershipRevisions);
    const [friends, requests, conversations, blockedUsers, conversationKeys] = await Promise.all([
      api('/friends'),
      api('/friends/requests?direction=incoming'),
      api('/conversations'),
      api('/blocks'),
      // If this fails, keys are still fetched per conversation when needed.
      api('/conversation-keys').catch(() => ({ data: [] })),
    ]);
    await rememberConversationKeys(conversationKeys.data);
    state.friends = Array.isArray(friends.data) ? friends.data : [];
    state.requests = Array.isArray(requests.data) ? requests.data : [];
    state.blockedUsers = Array.isArray(blockedUsers.data) ? blockedUsers.data : [];
    const previousConversations = state.conversations;
    state.conversations = sortConversationsByLatest(
      await decryptConversationPreviews(Array.isArray(conversations.data) ? conversations.data : []),
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
      if (state.activeRoomId) window.chatSocket?.leaveConversation(state.activeRoomId);
      state.activeRoomId = null;
      state.joinedRoomId = null;
      stopLocalTyping();
      clearTypingIndicator();
      state.selectedConversationId = null;
      state.messages = [];
      renderThread();
    }
    renderSidebar();
    renderChatBanner();
    updateCallButtons();

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
    if (state.refreshPending) {
      state.refreshPending = false;
      void refreshData();
    }
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
    // The member count is shown next to the group name; this line lists who is in it.
    return participantNames(conversation) || 'Group';
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
  for (const peer of state.groupPeers.values()) {
    peer.pc.close();
    peer.stream?.getTracks().forEach((track) => track.stop());
  }
  state.groupPeers.clear();
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

async function persistCallSummary(payload) {
  const conversationId = Number(payload?.conversation_id);
  const callerId = Number(payload?.caller_id);
  if (!Number.isSafeInteger(conversationId) || conversationId < 1 ||
    !Number.isSafeInteger(callerId) || callerId < 1 ||
    !['missed', 'completed'].includes(payload?.call_status)) return;

  const message = await api(`/conversations/${encodeURIComponent(conversationId)}/calls`, {
    method: 'POST',
    body: {
      call_id: payload.call_id,
      caller_id: callerId,
      status: payload.call_status,
      media_type: payload.media_type,
      duration_seconds: payload.duration_seconds,
    },
  });

  if (state.sidebarTool === 'calls') void loadCallHistory();
  if (String(state.selectedConversationId) !== String(conversationId)) return;
  state.messages = [message, ...state.messages.filter((item) => String(item.id) !== String(message.id))];
  state.conversations = state.conversations.map((conversation) =>
    String(conversation.id) === String(conversationId)
      ? { ...conversation, last_message: message, updated_at: message.created_at }
      : conversation);
  renderFriendList();
  renderMessages();
}

async function loadCallHistory({ append = false } = {}) {
  if (state.callHistoryLoading) return;
  const page = append ? state.callHistoryPage + 1 : 1;
  state.callHistoryLoading = true;
  state.callHistoryError = '';
  renderSidebar();

  try {
    const result = await api(`/call-history?page=${page}${state.callHistoryFilter === 'missed' ? '&filter=missed' : ''}`);
    if (!Array.isArray(result.data)) throw new Error('The server returned an invalid call history response.');
    state.callHistory = append ? [...state.callHistory, ...result.data] : result.data;
    state.callHistoryPage = Number(result.current_page) || page;
    state.callHistoryLastPage = Number(result.last_page) || 1;
  } catch (error) {
    state.callHistoryError = error.message || 'Call history could not be loaded.';
  } finally {
    state.callHistoryLoading = false;
    if (state.sidebarTool === 'calls') renderSidebar();
  }
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
  if (state.voiceRecording) cancelVoiceRecording();
  if (conversation.type === 'group') {
    await startGroupCall(conversation, mediaType);
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
    connectedNotified: false,
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
  const notifyCallConnected = () => {
    if (state.call?.id !== call.id || state.call.connectedNotified) return;
    state.call.connectedNotified = true;
    void sendCallEvent('call:connected', { call_id: call.id });
  };
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
    if (peer.connectionState === 'connected') {
      notifyCallConnected();
      updateCall({ phase: 'active' });
    }
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
      notifyCallConnected();
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

// ---------------------------------------------------------------------------
// Group calls (mesh): one RTCPeerConnection per other participant. Whoever
// joins sends offers to everyone already in the call; existing participants
// only answer, so two peers never offer to each other at the same time.
// ---------------------------------------------------------------------------

function groupConversationById(conversationId) {
  return state.conversations.find((item) =>
    String(item.id) === String(conversationId) && item.type === 'group') || null;
}

function groupMemberName(conversationId, userId) {
  return groupConversationById(conversationId)?.participants
    ?.find((member) => String(member.id) === String(userId))?.name || 'Member';
}

async function acquireCallMedia(mediaType) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: mediaType === 'video',
  });
  if (!stream.getAudioTracks().some((track) => track.enabled && track.readyState === 'live')) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('No active microphone audio track was created. Check microphone permissions and input settings.');
  }
  return stream;
}

async function startGroupCall(conversation, mediaType) {
  const call = {
    id: crypto.randomUUID(),
    kind: 'group',
    conversationId: Number(conversation.id),
    groupName: conversation.name || 'Group',
    callerName: state.user?.name || 'You',
    mediaType,
    direction: 'outgoing',
    phase: 'joining',
    muted: false,
    cameraEnabled: true,
    playbackWarningShown: false,
    connectionStatus: '',
  };
  state.call = call;
  state.recentGroupCallIds.add(call.id);
  renderCallOverlay();

  let stream;
  try {
    stream = await acquireCallMedia(mediaType);
  } catch (error) {
    stopCall(`Could not access your microphone or camera: ${error.message}`);
    return;
  }
  if (state.call?.id !== call.id) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  state.localStream = stream;
  renderCallOverlay();
  const sent = await sendCallEvent('group-call:start', {
    call_id: call.id,
    conversation_id: call.conversationId,
    media_type: mediaType,
  });
  if (sent !== false) expectGroupCallJoin(call.conversationId);
}

// The server answers group-call:start/join with "joined" or an error. A server
// that predates group calls ignores them, so give up instead of hanging.
const GROUP_CALL_JOIN_TIMEOUT_MS = 12000;

function expectGroupCallJoin(conversationId) {
  setTimeout(() => {
    const call = state.call;
    if (call?.kind === 'group' && call.phase === 'joining' && String(call.conversationId) === String(conversationId)) {
      void sendCallEvent('group-call:leave', { call_id: call.id });
      stopCall('The call server did not respond to the group call. It may be running an older version without group calls; ask your administrator to update the socket server.');
    }
  }, GROUP_CALL_JOIN_TIMEOUT_MS);
}

async function answerGroupCall() {
  const call = state.call;
  if (call?.kind !== 'group' || call.phase !== 'ringing' || !state.socketConnected) return;
  if (state.voiceRecording) cancelVoiceRecording();
  updateCall({ phase: 'joining' });

  let stream;
  try {
    stream = await acquireCallMedia(call.mediaType);
  } catch (error) {
    void sendCallEvent('group-call:decline', { call_id: call.id });
    stopCall(`Could not access your microphone or camera: ${error.message}`);
    return;
  }
  if (state.call?.id !== call.id) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  state.localStream = stream;
  renderCallOverlay();
  const sent = await sendCallEvent('group-call:join', { call_id: call.id });
  if (sent !== false) expectGroupCallJoin(call.conversationId);
}

function sendGroupSignal(callId, userId, signal) {
  return sendCallEvent('group-call:signal', { call_id: callId, to_user_id: Number(userId), signal });
}

function createGroupPeer(userId, name, initiator) {
  const key = String(userId);
  const existing = state.groupPeers.get(key);
  if (existing) return existing;

  const callId = state.call.id;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const peer = {
    userId: Number(userId),
    name: name || groupMemberName(state.call.conversationId, userId),
    pc,
    stream: null,
    pendingCandidates: [],
    status: 'Connecting…',
    queue: Promise.resolve(),
  };
  state.groupPeers.set(key, peer);
  state.localStream?.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

  const isCurrent = () => state.call?.id === callId && state.groupPeers.get(key) === peer;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && isCurrent()) void sendGroupSignal(callId, userId, { candidate: candidate.toJSON() });
  };
  pc.ontrack = ({ streams, track }) => {
    if (!isCurrent()) return;
    if (streams[0]) {
      peer.stream = streams[0];
    } else {
      peer.stream ||= new MediaStream();
      if (!peer.stream.getTracks().some((item) => item.id === track.id)) peer.stream.addTrack(track);
    }
    renderCallOverlay();
  };
  pc.onconnectionstatechange = () => {
    if (!isCurrent()) return;
    peer.status = {
      connected: '',
      disconnected: 'Reconnecting…',
      failed: 'Could not connect',
    }[pc.connectionState] ?? 'Connecting…';
    renderCallOverlay();
  };

  if (initiator) {
    peer.queue = peer.queue.then(async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (isCurrent()) await sendGroupSignal(callId, userId, { description: pc.localDescription.toJSON() });
    }).catch((error) => {
      peer.status = 'Could not connect';
      renderCallOverlay();
      console.error('Group call offer failed:', error);
    });
  }
  renderCallOverlay();
  return peer;
}

function closeGroupPeer(userId) {
  const key = String(userId);
  const peer = state.groupPeers.get(key);
  if (!peer) return;
  state.groupPeers.delete(key);
  peer.pc.close();
  peer.stream?.getTracks().forEach((track) => track.stop());
  renderCallOverlay();
}

function handleGroupSignal(payload) {
  const call = state.call;
  const fromUserId = Number(payload?.from_user_id);
  const signal = payload?.signal;
  if (call?.kind !== 'group' || call.phase !== 'active' || payload?.call_id !== call.id ||
    !Number.isSafeInteger(fromUserId) || !signal || typeof signal !== 'object') return;

  const peer = createGroupPeer(fromUserId, null, false);
  const { pc } = peer;
  // Signals for one peer are applied strictly in order.
  peer.queue = peer.queue.then(async () => {
    if (signal.candidate) {
      if (!pc.remoteDescription) peer.pendingCandidates.push(signal.candidate);
      else await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      return;
    }
    const description = signal.description;
    if (!description || !['offer', 'answer'].includes(description.type) ||
      typeof description.sdp !== 'string') return;
    await pc.setRemoteDescription(new RTCSessionDescription(description));
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    if (description.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      if (state.call?.id === call.id) {
        await sendGroupSignal(call.id, fromUserId, { description: pc.localDescription.toJSON() });
      }
    }
  }).catch((error) => {
    peer.status = 'Could not connect';
    renderCallOverlay();
    console.error('Group call negotiation failed:', error);
  });
}

function handleGroupCallSocketEvent(event, payload) {
  const call = state.call;
  const callId = payload?.call_id;

  if (event === 'group-call:invite') {
    if (call || typeof callId !== 'string') return;
    const conversation = groupConversationById(payload.conversation_id);
    state.recentGroupCallIds.add(callId);
    state.call = {
      id: callId,
      kind: 'group',
      conversationId: Number(payload.conversation_id),
      groupName: conversation?.name || 'Group',
      callerName: payload.caller_name || 'A member',
      mediaType: payload.media_type === 'video' ? 'video' : 'audio',
      direction: 'incoming',
      phase: 'ringing',
      muted: false,
      cameraEnabled: true,
      playbackWarningShown: false,
      connectionStatus: '',
    };
    renderCallOverlay();
    return;
  }

  if (event === 'group-call:ended') {
    if (state.recentGroupCallIds.has(callId) || String(payload?.caller_id) === String(state.user?.id)) {
      state.recentGroupCallIds.delete(callId);
      void persistCallSummary(payload).catch((error) =>
        showNotice(`Call history could not be saved: ${error.message}`));
    }
    if (call?.id === callId) stopCall(call.phase === 'ringing' ? 'The group call ended.' : 'The group call has ended.');
    return;
  }

  if (event === 'group-call:joined') {
    // The server may place us in a call that was already running in this
    // group, so adopt its id and media type.
    if (call?.kind !== 'group' || call.phase !== 'joining' ||
      String(call.conversationId) !== String(payload?.conversation_id)) {
      void sendCallEvent('group-call:leave', { call_id: callId });
      return;
    }
    state.recentGroupCallIds.add(callId);
    const mediaType = payload.media_type === 'video' ? 'video' : 'audio';
    if (mediaType === 'audio' && state.localStream) {
      for (const track of state.localStream.getVideoTracks()) {
        track.stop();
        state.localStream.removeTrack(track);
      }
    }
    updateCall({ id: callId, mediaType, phase: 'active' });
    for (const participant of payload.participants || []) {
      createGroupPeer(participant.user_id, participant.name, true);
    }
    return;
  }

  if (call?.kind !== 'group' || call.id !== callId) return;

  if (event === 'group-call:participant-joined' && call.phase === 'active') {
    createGroupPeer(payload.user_id, payload.name, false);
  } else if (event === 'group-call:participant-left') {
    closeGroupPeer(payload.user_id);
  } else if (event === 'group-call:signal') {
    handleGroupSignal(payload);
  } else if (event === 'group-call:dismissed' && call.phase === 'ringing') {
    cleanupCall();
  } else if (event === 'group-call:error') {
    stopCall(payload.message || 'The group call could not continue.');
  }
}

async function answerCall() {
  const call = state.call;
  if (call?.kind === 'group') {
    await answerGroupCall();
    return;
  }
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
  void sendCallEvent(call.kind === 'group' ? 'group-call:decline' : 'call:reject', { call_id: call.id });
  cleanupCall();
}

function hangUpCall() {
  const call = state.call;
  if (!call) return;
  if (call.kind === 'group') {
    void sendCallEvent(call.phase === 'ringing' ? 'group-call:decline' : 'group-call:leave', { call_id: call.id });
    cleanupCall();
    return;
  }
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
      connectedNotified: false,
      playbackWarningShown: false,
      connectionStatus: '',
    };
    renderCallOverlay();
    return;
  }

  if (['call:timeout', 'call:rejected', 'call:unavailable', 'call:ended'].includes(event) &&
    payload?.call_status) {
    void persistCallSummary(payload).catch((error) =>
      showNotice(`Call history could not be saved: ${error.message}`));
  }

  if (!call || payload?.call_id !== call.id) {
    return;
  }
  if (event === 'call:accepted' && call.direction === 'outgoing') {
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
    if (state.pollTimer) startPolling();
    void sendCallEvent('call:ready', {
      enabled: Boolean(navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined'),
      group_calls: true,
    });
    state.activeRoomId = null;
    state.joinedRoomId = null;
    state.onlineFriendIds.clear();
    updatePresenceViews();
    joinSelectedConversation();
  } else if (event === 'disconnect' || event === 'connect_error') {
    if (event === 'disconnect' && state.call) stopCall('Realtime connection lost; the call ended.');
    state.socketConnected = false;
    startPolling();
    state.activeRoomId = null;
    state.joinedRoomId = null;
    state.onlineFriendIds.clear();
    clearTypingIndicator();
    updatePresenceViews();
    updateCallButtons();
    if (event === 'connect_error' && payload?.message) {
      const message = payload.message === 'Authentication failed'
        ? 'Realtime sign-in was rejected. Please sign in again.'
        : 'Socket server is not accessible. Please check your internet connection and try again.';
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
  } else if (event === 'message.created' || event === 'message.updated') {
    void handleMessagePush(event, payload).catch(() => refreshData());
  } else if (event === 'conversation.read') {
    handleReadPush(payload);
  } else if (event === 'conversation.pins') {
    if (String(payload?.conversation_id) === String(state.selectedConversationId)) {
      void loadMessages({ markRead: false, cacheImages: false }).then(renderMessages).catch(() => {});
    }
  } else if (event === 'conversation.changed' || event === 'friends.changed') {
    void refreshData();
  } else if (event === 'conversation:message' &&
    String(payload?.conversation_id) === String(state.selectedConversationId) &&
    state.messages.some((message) => String(message.id) === String(payload?.message_id))) {
    // Already shown by the API's push.
  } else if (event === 'conversation:message' &&
    Number.isSafeInteger(Number(payload?.conversation_id)) &&
    Number.isSafeInteger(Number(payload?.message_id))) {
    if (String(payload.conversation_id) === String(state.selectedConversationId)) {
      const conversationId = String(state.selectedConversationId);
      void loadMessages({ markRead: false, cacheImages: false }).then(() => {
        if (String(state.selectedConversationId) !== conversationId) return;
        renderMessages();
        renderSidebar();
        void cacheMessageImages(conversationId, state.messages);
        if (document.hasFocus() && hasUnreadFromOthers()) {
          void api(`/conversations/${encodeURIComponent(conversationId)}/read`, { method: 'POST' })
            .then(() => announceRead(conversationId))
            .then(() => loadMessages({ markRead: false, cacheImages: false }))
            .then(() => {
              if (String(state.selectedConversationId) === conversationId) {
                renderMessages();
                renderSidebar();
              }
            })
            .catch((error) => showNotice(`Message received, but read status could not be updated: ${error.message}`));
        } else if (!document.hasFocus()) {
          // The app is in the background: refresh unread counts, which shows the
          // desktop notification for this chat too.
          void refreshData();
        }
      }).catch((error) => showNotice(`A new message arrived, but could not be loaded: ${error.message}`));
    } else {
      void refreshData();
    }
  } else if (event === 'conversation:read' &&
    String(payload?.conversation_id) === String(state.selectedConversationId) &&
    String(payload?.user_id) !== String(state.user?.id)) {
    const conversationId = String(state.selectedConversationId);
    void loadMessages({ markRead: false, cacheImages: false }).then(() => {
      if (String(state.selectedConversationId) === conversationId) renderMessages();
    }).catch(() => {});
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
  } else if (event.startsWith('group-call:')) {
    handleGroupCallSocketEvent(event, payload);
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
  if (isReadOnly(selectedConversation())) return;
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
  state.pollTimer = setInterval(
    () => refreshData(),
    state.socketConnected ? CONNECTED_REFRESH_INTERVAL : REFRESH_INTERVAL,
  );
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
  if (String(state.selectedConversationId) !== String(conversation.id)) cancelVoiceRecording();
  state.sidebarTool = null;
  state.chatListTab = isOthersConversation(conversation) ? 'others' : 'chats';
  state.selectedConversationId = conversation.id;
  state.messages = [];
  state.replyTarget = null;
  state.selectedAttachment = null;
  clearAttachmentPreview();
  state.hasOlderMessages = false;
  state.messagesLoading = true;
  render();
  joinSelectedConversation();
  try {
    await loadMessages();
  } finally {
    state.messagesLoading = false;
  }
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
  if (String(state.selectedConversationId) !== String(conversation.id)) cancelVoiceRecording();
  state.sidebarTool = null;
  state.chatListTab = isOthersConversation(conversation) ? 'others' : 'chats';
  state.selectedConversationId = conversation.id;
  state.messages = [];
  state.replyTarget = null;
  state.selectedAttachment = null;
  clearAttachmentPreview();
  state.hasOlderMessages = false;
  state.messagesLoading = true;
  render();
  joinSelectedConversation();
  try {
    await loadMessages();
  } finally {
    state.messagesLoading = false;
  }
  renderMessages();
}

async function handleAuthSubmit(form) {
  const formData = new FormData(form);
  const body = Object.fromEntries(formData.entries());
  body.device_name = 'dailyconnect-desktop';
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

async function handleEditName(form) {
  const name = new FormData(form).get('name')?.toString().trim() || '';
  if (!name) throw new Error('Enter your name.');
  if (name === state.user?.name) {
    closeModal();
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const payload = await api('/user/profile', { method: 'PATCH', body: { name } });
    storeUser({ ...state.user, ...payload.user });
    closeModal();
    render();
    showNotice('Your name has been updated.', 'success');
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function handleChangePassword(form) {
  const formData = new FormData(form);
  const currentPassword = formData.get('current_password')?.toString() || '';
  const newPassword = formData.get('password')?.toString() || '';
  if (newPassword.length < 8) throw new Error('Your new password must be at least 8 characters.');
  if (newPassword === currentPassword) throw new Error('Choose a password different from your current one.');
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    await api('/user/password', {
      method: 'PATCH',
      body: { current_password: currentPassword, password: newPassword },
    });
    closeModal();
    showNotice('Your password has been changed.', 'success');
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function handleForgotRequest(form) {
  const phone = new FormData(form).get('phone')?.toString().trim() || '';
  if (!phone) throw new Error('Enter your phone number.');
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const payload = await api('/auth/forgot-password', { method: 'POST', body: { phone } });
    state.forgotPhone = phone;
    state.forgotEmailHint = payload?.email_hint || '';
    state.forgotStage = 'verify';
    render();
    showNotice(payload?.message || 'If that number has an account, a reset code is on its way.', 'success');
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function handleResetPassword(form) {
  const formData = new FormData(form);
  const body = {
    phone: formData.get('phone')?.toString().trim() || state.forgotPhone,
    code: formData.get('code')?.toString().trim() || '',
    password: formData.get('password')?.toString() || '',
  };
  if (!/^[0-9]{6}$/.test(body.code)) throw new Error('Enter the 6-digit code from the email.');
  if (body.password.length < 8) throw new Error('Your new password must be at least 8 characters.');
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const payload = await api('/auth/reset-password', { method: 'POST', body });
    state.authMode = 'login';
    state.forgotStage = 'request';
    state.forgotEmailHint = '';
    render();
    showNotice(payload?.message || 'Your password has been reset. Sign in with your new password.', 'success');
  } finally {
    if (submit) submit.disabled = false;
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
  if (!name) throw new Error('Enter a group name.');
  if (!friendIds.length) throw new Error('Choose at least one friend to add to the group.');
  const submit = form.querySelector('#create-group-submit');
  submit.dataset.busy = 'true';
  submit.disabled = true;
  submit.textContent = 'Creating…';
  let conversation;
  try {
    conversation = await api('/groups', {
      method: 'POST',
      body: { name, friend_ids: friendIds },
    });
  } finally {
    delete submit.dataset.busy;
    updateCreateGroupView();
  }
  closeModal();
  state.groupName = '';
  state.groupFriendQuery = '';
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
  const confirmed = window.confirm(`Remove ${friendName} from your friends list? Your chat history will be kept if you add them again.`);
  if (!confirmed) return;

  await api(`/friends/${encodeURIComponent(friendId)}`, { method: 'DELETE' });
  if (state.activeRoomId) window.chatSocket?.leaveConversation(state.activeRoomId);
  state.selectedConversationId = null;
  state.messages = [];
  state.activeRoomId = null;
  state.joinedRoomId = null;
  stopLocalTyping();
  clearTypingIndicator();
  render();
  await refreshData();
  showNotice('Friend removed.', 'success');
}

async function handleBlockUser(userId) {
  const friend = state.friends.find((person) => String(person.id) === String(userId));
  const userName = friend?.name || 'this user';
  if (!window.confirm(`Block ${userName}? Neither of you will be able to send messages. Your old messages stay readable.`)) return;

  await api(`/users/${encodeURIComponent(userId)}/block`, { method: 'POST' });
  if (String(selectedConversation()?.friend?.id) === String(userId) && state.activeRoomId) {
    window.chatSocket?.leaveConversation(state.activeRoomId);
    state.activeRoomId = null;
    state.joinedRoomId = null;
    stopLocalTyping();
    clearTypingIndicator();
  }
  await refreshData();
  showNotice(`${userName} blocked. You can unblock them here or from Blocked users.`, 'success');
}

async function handleUnblockUser(userId) {
  const blockedUser = state.blockedUsers.find((person) => String(person.id) === String(userId));
  await api(`/users/${encodeURIComponent(userId)}/block`, { method: 'DELETE' });
  await refreshData();
  joinSelectedConversation();
  showNotice(`${blockedUser?.name || 'User'} unblocked.`, 'success');
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

function setGroupIcon(conversationId, iconUrl) {
  const key = String(conversationId);
  state.conversations = state.conversations.map((conversation) =>
    String(conversation.id) === key ? { ...conversation, icon_url: iconUrl } : conversation);
  renderFriendList();
  if (String(state.selectedConversationId) === key) renderThread();
  const updated = state.conversations.find((conversation) => String(conversation.id) === key);
  if (updated && document.querySelector('#group-modal-title')) renderGroupMembersModal(updated);
}

async function updateGroupIcon(conversationId, file) {
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (!allowedTypes.has(file.type) || file.size > 5 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG, GIF, or WEBP image under 5 MB.');
  }
  const formData = new FormData();
  formData.append('icon', file);
  const payload = await api(`/groups/${encodeURIComponent(conversationId)}/icon`, { method: 'POST', body: formData });
  setGroupIcon(conversationId, payload?.icon_url || null);
  showNotice('Group icon updated.', 'success');
}

async function removeGroupIcon(conversationId) {
  if (!window.confirm('Remove the group icon?')) return;
  await api(`/groups/${encodeURIComponent(conversationId)}/icon`, { method: 'DELETE' });
  setGroupIcon(conversationId, null);
  showNotice('Group icon removed.', 'success');
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
  if (state.editTarget) {
    if (String(state.editTarget.conversation_id) === String(state.selectedConversationId)) {
      await saveEditedMessage(state.editTarget, field);
      return;
    }
    state.editTarget = null;
  }
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
  if (!file) {
    await sendTextMessage(conversation, body, replyTarget);
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const encryptedFile = await encryptFileBytes(new Uint8Array(await file.arrayBuffer()));
    const fileDetails = {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      key: encryptedFile.key,
      iv: encryptedFile.iv,
    };
    const sentMessage = await decryptForDisplay(conversation.id, await sendEncrypted(
      conversation.id,
      { text: body || null, file: fileDetails },
      (encrypted) => {
        const payload = new FormData();
        payload.append('body', encrypted.body);
        payload.append('encrypted', '1');
        payload.append('key_version', String(encrypted.key_version));
        payload.append('attachment', new Blob([encryptedFile.data], { type: 'application/octet-stream' }), 'encrypted.bin');
        if (replyTarget) payload.append('reply_to_message_id', replyTarget.id);
        return api(`/conversations/${encodeURIComponent(conversation.id)}/messages`, { method: 'POST', body: payload });
      },
    ));
    field.value = '';
    state.replyTarget = null;
    updateReplyPreview();
    state.selectedAttachment = null;
    const attachmentInput = form.querySelector('#attachment-input');
    if (attachmentInput) attachmentInput.value = '';
    clearAttachmentPreview();
    if (CACHED_IMAGE_TYPES.has(sentMessage.attachment?.mime)) {
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
    applySentMessage(conversation.id, sentMessage);
    void notifyMessageSent(conversation.id, sentMessage.id);
  } finally {
    submitButton.disabled = false;
    field.focus();
  }
}

// Text messages appear immediately with a "sending" clock and are confirmed in
// place when the server responds. Sends are queued so they arrive in order.
async function sendTextMessage(conversation, body, replyTarget) {
  const tempId = `pending-${crypto.randomUUID()}`;
  const pendingMessage = {
    id: tempId,
    pending: true,
    conversation_id: conversation.id,
    sender: { id: state.user.id, name: state.user.name, avatar_url: state.user.avatar_url },
    body,
    type: 'text',
    reply_to: replyTarget ? {
      id: replyTarget.id,
      sender: { id: replyTarget.sender?.id, name: replyTarget.sender?.name },
      body: replyTarget.body,
      type: replyTarget.type,
      attachment: replyTarget.attachment ? { name: replyTarget.attachment.name } : null,
      deleted_for_everyone_at: replyTarget.deleted_for_everyone_at,
      unavailable: false,
    } : null,
    attachment: null,
    is_forwarded: false,
    created_at: new Date().toISOString(),
    delivered_at: null,
    read_at: null,
  };
  const entry = { conversationId: conversation.id, message: pendingMessage, confirmed: false };
  state.outgoing.set(tempId, entry);

  const field = document.querySelector('#message-form textarea');
  if (field) field.value = '';
  state.replyTarget = null;
  updateReplyPreview();
  showOutgoingChanges(conversation.id, true);

  const request = state.sendQueue.then(() =>
    sendEncrypted(conversation.id, { text: body }, (encrypted) =>
      api(`/conversations/${encodeURIComponent(conversation.id)}/messages`, {
        method: 'POST',
        body: replyTarget ? { ...encrypted, reply_to_message_id: replyTarget.id } : encrypted,
      })));
  state.sendQueue = request.catch(() => {});

  let sentMessage;
  try {
    sentMessage = await decryptForDisplay(conversation.id, await request);
  } catch (error) {
    state.outgoing.delete(tempId);
    showOutgoingChanges(conversation.id);
    if (String(state.selectedConversationId) === String(conversation.id)) {
      const currentField = document.querySelector('#message-form textarea');
      if (currentField && !currentField.value.trim()) currentField.value = body;
      if (replyTarget && !state.replyTarget) {
        state.replyTarget = replyTarget;
        updateReplyPreview();
      }
    }
    throw new Error(`Message not sent: ${error.message}`);
  }

  entry.message = sentMessage;
  entry.confirmed = true;
  applySentMessage(conversation.id, sentMessage);
  void notifyMessageSent(conversation.id, sentMessage.id);
}

// Merges this device's outgoing messages into a list loaded from the server
// (newest first). A sent message is dropped from the outgoing list once the
// server's list includes it.
function withOutgoing(conversationId, messages) {
  const base = messages.filter((message) => !message.pending);
  const ids = new Set(base.map((message) => String(message.id)));
  const extra = [];
  for (const [key, entry] of state.outgoing) {
    if (String(entry.conversationId) !== String(conversationId)) continue;
    if (entry.confirmed && ids.has(String(entry.message.id))) {
      state.outgoing.delete(key);
      continue;
    }
    extra.push(entry.message);
  }
  return [...extra.reverse(), ...base];
}

function showOutgoingChanges(conversationId, scrollToBottom = false) {
  if (String(state.selectedConversationId) !== String(conversationId)) return;
  const outgoingIds = new Set([...state.outgoing.values()].map((entry) => String(entry.message.id)));
  state.messages = withOutgoing(
    conversationId,
    state.messages.filter((message) => !message.pending && !outgoingIds.has(String(message.id))),
  );
  renderMessages();
  if (scrollToBottom) {
    const list = document.querySelector('#message-list');
    if (list) list.scrollTop = list.scrollHeight;
  }
}

// Shows a message the server has accepted without reloading everything.
function applySentMessage(conversationId, message) {
  const key = String(conversationId);
  if (String(state.selectedConversationId) === key &&
    !state.messages.some((item) => String(item.id) === String(message.id))) {
    const confirmedOutgoing = [...state.outgoing.values()].some((entry) =>
      String(entry.message.id) === String(message.id));
    if (!confirmedOutgoing) state.messages = [message, ...state.messages];
  }
  showOutgoingChanges(conversationId, true);
  state.conversations = sortConversationsByLatest(state.conversations.map((conversation) =>
    String(conversation.id) === key
      ? { ...conversation, last_message: message, updated_at: message.created_at }
      : conversation));
  renderFriendList();
}

// Removes every message in this chat from my view only; the other people in the
// chat still see them unless they clear it too.
async function handleClearChat() {
  const conversation = selectedConversation();
  if (!conversation) return;
  const others = conversation.type === 'group'
    ? 'Other members'
    : conversation.friend?.name || 'The other person';
  if (!window.confirm(`Clear this chat? All messages will be removed from your view only. ${others} will still see them.`)) return;

  await api(`/conversations/${encodeURIComponent(conversation.id)}/clear`, { method: 'POST' });
  const conversationId = String(conversation.id);
  for (const [key, entry] of state.outgoing) {
    if (String(entry.conversationId) === conversationId) state.outgoing.delete(key);
  }
  if (String(state.selectedConversationId) === conversationId) {
    state.messages = [];
    state.pinnedMessages = [];
    state.readCursors = [];
    state.hasOlderMessages = false;
    state.replyTarget = null;
    state.editTarget = null;
    updateReplyPreview();
    renderMessages();
  }
  state.conversations = state.conversations.map((item) => String(item.id) === conversationId
    ? { ...item, last_message: null, unread_count: 0 }
    : item);
  renderFriendList();
  syncUnreadIndicators();
  showNotice(`Chat cleared for you. ${others} can still see the messages.`, 'success');
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
  state.messages = forEveryone
    ? state.messages.map((item) => String(item.id) === String(message.id)
      ? { ...item, body: null, attachment: null, deleted_for_everyone_at: new Date().toISOString() }
      : item)
    : state.messages.filter((item) => String(item.id) !== String(message.id));
  await loadMessages();
  renderMessages();
  await refreshData();
  if (state.lastRefreshError) return;
  showNotice(
    `${forEveryone ? 'Message deleted for everyone.' : 'Message deleted for you.'}${cleanupWarning}`,
    cleanupWarning ? 'error' : 'success',
  );
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

  return new File([image], `DailyConnect-snippet-${Date.now()}.${extension}`, {
    type: image.type,
    lastModified: Date.now(),
  });
}

function clearAttachmentPreview() {
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
  const icon = document.createElement('span');
  icon.className = 'attachment-preview-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = extension.slice(0, 4);
  details.append(icon);

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

  applyUpdatedProfile(payload.user);
  showNotice('Profile picture updated.', 'success');
}

// Re-renders everything showing your picture, keeping whichever panel or
// dialog you changed it from open.
function applyUpdatedProfile(user) {
  const profileModalOpen = Boolean(document.querySelector('#profile-modal-title'));
  state.user = user;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  render();
  if (profileModalOpen) renderProfileModal();
}

async function removeProfilePicture() {
  if (!window.confirm('Remove your profile picture?')) return;
  const payload = await api('/user/profile-picture', { method: 'DELETE' });
  if (!payload?.user) throw new Error('The server did not return the updated profile.');
  applyUpdatedProfile(payload.user);
  showNotice('Profile picture removed.', 'success');
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
  if (version && state.appVersion) version.textContent = `DailyConnect v${state.appVersion}`;
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
    if (form.id === 'forgot-password-form') await handleForgotRequest(form);
    if (form.id === 'reset-password-form') await handleResetPassword(form);
    if (form.id === 'edit-name-form') await handleEditName(form);
    if (form.id === 'change-password-form') await handleChangePassword(form);
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
    if (form.id === 'forward-message-form') await handleForwardMessage(form);
    if (form.id === 'protected-message-form') await handleSendProtected(form);
    if (form.id === 'unlock-protected-form') await handleUnlockProtected(form);
  } catch (error) {
    showNotice(error.message || 'Something went wrong. Please try again.');
  }
});

app.addEventListener('click', async (event) => {
  if (!event.target.closest('.message-menu')) {
    document.querySelectorAll('.message-menu[open]').forEach((menu) => menu.removeAttribute('open'));
  }
  if (event.target.matches('.modal-backdrop:not([data-sticky])')) {
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
    if (action === 'open-external-link') {
      event.preventDefault();
      await window.desktopApp.openExternal(button.dataset.url);
    } else if (action === 'toggle-password-visibility') {
      const password = document.querySelector('#password');
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      button.setAttribute('title', visible ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(visible));
      button.classList.toggle('is-visible', visible);
      password.focus();
    } else if (action === 'toggle-field-visibility') {
      const field = document.querySelector(`#${button.dataset.target}`);
      if (field) {
        const visible = field.type === 'password';
        field.type = visible ? 'text' : 'password';
        button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        button.setAttribute('title', visible ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', String(visible));
        button.classList.toggle('is-visible', visible);
        field.focus();
      }
    } else if (action === 'forgot-password') {
      state.authMode = 'forgot';
      state.forgotStage = 'request';
      state.forgotEmailHint = '';
      render();
    } else if (action === 'forgot-resend') {
      state.forgotStage = 'request';
      render();
    } else if (action === 'back-to-login') {
      state.authMode = 'login';
      state.forgotStage = 'request';
      state.forgotEmailHint = '';
      render();
    } else if (action === 'edit-name') {
      renderEditNameModal();
    } else if (action === 'change-password') {
      renderChangePasswordModal();
    } else if (action === 'toggle-auth') {
      state.authMode = state.authMode === 'login' ? 'signup' : 'login';
      render();
    } else if (action === 'toggle-sidebar-tool') {
      state.sidebarTool = state.sidebarTool === button.dataset.tool ? null : button.dataset.tool;
      renderSidebar();
      if (state.sidebarTool === 'calls') {
        void loadCallHistory();
        markMissedCallsSeen();
      }
      if (state.sidebarTool === 'search') {
        document.querySelector('#friend-search')?.focus();
      }
    } else if (action === 'open-profile') {
      renderProfileModal();
    } else if (action === 'open-user-profile') {
      const user = userForProfile(id);
      if (!user) throw new Error('This user profile is no longer available.');
      if (String(user.id) === String(state.user?.id)) renderProfileModal();
      else renderUserProfileModal(user);
    } else if (action === 'profile-open-chat') {
      closeModal();
      await openFriend(id);
    } else if (action === 'open-group-members') {
      const conversation = state.conversations.find((item) =>
        String(item.id) === String(id) && item.type === 'group');
      if (!conversation) throw new Error('This group is no longer available.');
      renderGroupMembersModal(conversation);
    } else if (action === 'close-modal') {
      closeModal();
    } else if (action === 'open-chat-search') {
      openChatSearch();
    } else if (action === 'close-chat-search') {
      closeChatSearch();
    } else if (action === 'open-search-result') {
      await openSearchResult(button.dataset.conversationId, button.dataset.messageId);
    } else if (action === 'remove-profile-picture') {
      await removeProfilePicture();
    } else if (action === 'choose-group-icon') {
      document.querySelector('#group-icon-input')?.click();
    } else if (action === 'remove-group-icon') {
      await removeGroupIcon(id);
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
      if (state.sidebarTool === 'calls') await loadCallHistory();
    } else if (action === 'refresh-call-history') {
      await loadCallHistory();
    } else if (action === 'load-more-call-history') {
      await loadCallHistory({ append: true });
    } else if (action === 'call-audio' || action === 'call-video') {
      await startCall(action === 'call-video' ? 'video' : 'audio');
    } else if (action === 'chat-list-tab') {
      state.chatListTab = button.dataset.tab === 'others' ? 'others' : 'chats';
      renderFriendList();
    } else if (action === 'add-friend-from-chat') {
      button.disabled = true;
      await api('/friends/requests', { method: 'POST', body: { phone: button.dataset.phone } });
      showNotice('Friend request sent. The chat moves to Chats once they accept.', 'success');
      await refreshData();
    } else if (action === 'clear-chat') {
      await handleClearChat();
    } else if (action === 'message-by-phone') {
      const input = document.querySelector('#friend-phone');
      const phone = input?.value.trim();
      if (!phone || !input.checkValidity()) throw new Error('Enter the phone number in international format, e.g. +923001234567.');
      const conversation = await api('/conversations', { method: 'POST', body: { phone } });
      state.conversations = sortConversationsByLatest([
        conversation, ...state.conversations.filter((item) => String(item.id) !== String(conversation.id)),
      ]);
      state.addFriendPhone = '';
      await openFriend(conversation.friend.id);
    } else if (action === 'accept-request' || action === 'decline-request') {
      const accept = action === 'accept-request';
      await api(`/conversations/${encodeURIComponent(id)}/request/${accept ? 'accept' : 'decline'}`, { method: 'POST' });
      if (!accept && String(state.selectedConversationId) === String(id)) {
        document.querySelector('[data-action="show-friends"]')?.click();
      }
      await refreshData();
      showNotice(accept ? 'Message request accepted.' : 'Message request declined.', 'success');
    } else if (action === 'toggle-pin') {
      button.closest('.message-menu')?.removeAttribute('open');
      const conversation = selectedConversation();
      const messageId = button.dataset.messageId;
      const pinned = state.pinnedMessages.some((item) => String(item.id) === String(messageId));
      await api(
        `/conversations/${encodeURIComponent(conversation.id)}/messages/${encodeURIComponent(messageId)}/pin`,
        { method: pinned ? 'DELETE' : 'POST' },
      );
      await loadMessages({ markRead: false, cacheImages: false });
      renderMessages();
      showNotice(pinned ? 'Message unpinned.' : 'Message pinned for everyone in this chat.', 'success');
    } else if (action === 'jump-to-pin') {
      const messageId = button.dataset.messageId;
      // Each click moves on to the next pin, as in WhatsApp.
      if (state.pinnedMessages.length > 1) state.pinIndex = (state.pinIndex + 1) % state.pinnedMessages.length;
      await jumpToMessage(messageId);
      renderPinnedBar();
    } else if (action === 'call-filter') {
      state.callHistoryFilter = button.dataset.filter === 'missed' ? 'missed' : 'all';
      state.callHistory = [];
      state.callHistoryPage = 0;
      await loadCallHistory();
    } else if (action === 'test-notification') {
      const shown = await window.desktopApp?.testNotification?.();
      showNotice(shown
        ? 'Test notification sent. If it did not appear, open Windows Settings > System > Notifications, make sure DailyConnect is allowed, and turn off Do not disturb.'
        : 'This computer does not support desktop notifications.', shown ? 'success' : 'error');
    } else if (action === 'open-create-group') {
      renderCreateGroupModal();
    } else if (action === 'remove-group-chip') {
      state.selectedGroupFriendIds.delete(String(id));
      const checkbox = document.querySelector(`#create-group-form input[name="friend_ids"][value="${CSS.escape(String(id))}"]`);
      if (checkbox) checkbox.checked = false;
      updateCreateGroupView();
    } else if (action === 'open-add-friend-from-group') {
      closeModal();
      state.sidebarTool = 'add';
      renderSidebar();
      document.querySelector('#friend-phone')?.focus();
    } else if (action === 'open-protected-composer') {
      renderProtectedComposeModal();
    } else if (action === 'copy-protected-password') {
      await window.desktopApp.copyText(button.dataset.password);
      showNotice('Password copied. Share it with the recipient in person.', 'success');
    } else if (action === 'unlock-protected') {
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      if (!message?.protected) throw new Error('This message is no longer available.');
      renderUnlockModal(message);
    } else if (action === 'lock-protected') {
      state.unlockedMessages.delete(String(button.dataset.messageId));
      renderMessages();
    } else if (action === 'start-voice-recording') {
      await startVoiceRecording();
    } else if (action === 'cancel-voice-recording') {
      cancelVoiceRecording();
    } else if (action === 'send-voice-recording') {
      button.disabled = true;
      await finishVoiceRecording(true);
    } else if (action === 'toggle-voice') {
      await toggleVoicePlayback(button.dataset.messageId);
    } else if (action === 'seek-voice') {
      seekVoice(button, event.clientX);
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
      cancelVoiceRecording();
      stopLocalTyping();
      clearTypingIndicator();
      render();
    } else if (action === 'remove-attachment') {
      state.selectedAttachment = null;
      const attachmentInput = document.querySelector('#attachment-input');
      if (attachmentInput) attachmentInput.value = '';
      clearAttachmentPreview();
    } else if (action === 'toggle-emoji-picker') {
      toggleEmojiPicker();
    } else if (button.dataset.emoji) {
      insertEmoji(button.dataset.emoji);
    } else if (action === 'edit-message') {
      button.closest('.message-menu')?.removeAttribute('open');
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      if (!message) throw new Error('This message is no longer available.');
      beginEdit(message);
    } else if (action === 'cancel-edit') {
      cancelEdit();
    } else if (action === 'reply-message') {
      button.closest('.message-menu')?.removeAttribute('open');
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      if (!message) throw new Error('This message is no longer available.');
      beginReply(message);
    } else if (action === 'forward-message') {
      button.closest('.message-menu')?.removeAttribute('open');
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      if (!message) throw new Error('This message is no longer available.');
      renderForwardModal(message);
    } else if (action === 'copy-message') {
      button.closest('.message-menu')?.removeAttribute('open');
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      if (!message) throw new Error('This message is no longer available.');
      const text = state.unlockedMessages.get(String(message.id)) || message.body || message.attachment?.name;
      if (!text) throw new Error('This message has no text to copy.');
      await window.desktopApp.copyText(text);
      showNotice('Message copied.', 'success');
    } else if (action === 'cancel-reply') {
      state.replyTarget = null;
      updateReplyPreview();
    } else if (action === 'delete-message-for-me') {
      button.closest('.message-menu')?.removeAttribute('open');
      await handleDeleteMessage(button.dataset.messageId, 'me');
    } else if (action === 'delete-message-for-everyone') {
      button.closest('.message-menu')?.removeAttribute('open');
      await handleDeleteMessage(button.dataset.messageId, 'everyone');
    } else if (action === 'download-attachment') {
      const message = state.messages.find((item) => String(item.id) === String(button.dataset.messageId));
      await downloadAttachment(message);
    } else if (action === 'respond-request') {
      await handleRequestResponse(button);
    } else if (action === 'unfriend') {
      await handleUnfriend(id);
    } else if (action === 'block-user') {
      await handleBlockUser(id);
    } else if (action === 'unblock-user') {
      button.disabled = true;
      await handleUnblockUser(id);
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
  if (event.target.id === 'chat-search-input') {
    state.chatSearch.query = event.target.value;
    scheduleChatSearch();
  }
  if (event.target.id === 'friend-phone') {
    state.addFriendPhone = event.target.value;
  }
  if (event.target.id === 'group-name') {
    state.groupName = event.target.value;
    updateCreateGroupView();
  }
  if (event.target.id === 'group-friend-search') {
    state.groupFriendQuery = event.target.value;
    updateCreateGroupView();
  }
  if (event.target.matches('#message-form textarea')) handleMessageTyping();
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'setting-notifications') {
    updateSettings({ notifications: event.target.checked });
    return;
  }
  if (event.target.id === 'setting-blur-messages') {
    updateSettings({ blurMessages: event.target.checked });
    return;
  }
  if (event.target.id === 'setting-edit-minutes') {
    const select = event.target;
    const previous = messageEditMinutes();
    select.disabled = true;
    void api('/user/settings', {
      method: 'PATCH',
      body: { message_edit_minutes: Number(select.value) },
    }).then((result) => {
      storeUser({ ...state.user, ...result.user });
      renderMessages();
      showNotice('Edit time saved.', 'success');
    }).catch((error) => {
      select.value = String(previous);
      showNotice(`The edit time could not be saved: ${error.message}`);
    }).finally(() => {
      select.disabled = false;
    });
    return;
  }
  if (event.target.matches('#forward-message-form input[name="target_conversation_ids"]')) {
    const count = document.querySelector('#forward-selection-count');
    if (count) {
      const selectedCount = document.querySelectorAll('#forward-message-form input[name="target_conversation_ids"]:checked').length;
      count.textContent = `${selectedCount} selected`;
    }
    return;
  }
  if (event.target.matches('#create-group-form input[name="friend_ids"]')) {
    const friendId = String(event.target.value);
    if (event.target.checked) state.selectedGroupFriendIds.add(friendId);
    else state.selectedGroupFriendIds.delete(friendId);
    updateCreateGroupView();
    return;
  }
  if (event.target.id === 'group-icon-input') {
    const file = event.target.files?.[0] || null;
    const conversationId = event.target.dataset.conversationId;
    event.target.value = '';
    if (!file || !conversationId) return;
    void updateGroupIcon(conversationId, file).catch((error) => {
      showNotice(error.message || 'The group icon could not be updated.');
    });
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
  if (event.key === 'Escape' && document.querySelector('.modal-backdrop:not([data-sticky])')) {
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
  if (event.target.matches('#message-form textarea') && event.key === 'Escape' && state.editTarget) {
    cancelEdit();
    return;
  }
  if (event.target.matches('#message-form textarea') && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.voiceRecording) cancelVoiceRecording();
  if (event.key === 'Escape' && state.chatSearch.open && document.activeElement?.id === 'chat-search-input') {
    closeChatSearch();
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && selectedConversation() && state.token) {
    event.preventDefault();
    openChatSearch();
  }
});

app.addEventListener('scroll', (event) => {
  if (event.target.id === 'message-list' && event.target.scrollTop < 150) void loadOlderMessages();
}, true);

window.addEventListener('focus', () => {
  const conversationId = String(state.selectedConversationId || '');
  if (!state.token || !conversationId || !hasUnreadFromOthers()) return;
  void loadMessages({ cacheImages: false }).then(() => {
    if (String(state.selectedConversationId) === conversationId) renderMessages();
  }).catch(() => {});
});

// Log the resolved endpoints at startup so a wrong (e.g. stale) API URL is
// obvious in DevTools when login fails. Open with Ctrl+Shift+I to see it.
console.info(`[DailyConnect] API base: ${state.apiUrl} | Socket: ${state.socketUrl}`);
applySettings();
window.desktopApp?.onOpenConversation?.((conversationId) => {
  void openConversationById(conversationId).catch((error) =>
    showNotice(error.message || 'The conversation could not be opened.'));
});
window.chatSocket?.onEvent(handleSocketEvent);
checkForUpdates(false);

if (state.token && state.user) {
  void api('/user').then((user) => {
    if (user?.id && String(user.id) === String(state.user?.id)) {
      storeUser({ ...state.user, message_edit_minutes: user.message_edit_minutes ?? DEFAULT_MESSAGE_EDIT_MINUTES });
    }
  }).catch(() => {});
  render();
  refreshData().then(startPolling).then(loadMissedCallBadge);
  connectSocket();
} else {
  render();
}
