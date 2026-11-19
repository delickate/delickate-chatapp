const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { version: APP_VERSION } = require('../package.json');

// Our API/socket servers are dual-stack behind Cloudflare. On networks with
// broken IPv6, Chromium's Happy Eyeballs sometimes connects over IPv6 and every
// request in that session fails with ERR_CONNECTION_RESET ("Failed to fetch"),
// while IPv4 works fine. We force IPv4:
//   - Node (socket.io-client runs in this process) prefers IPv4 addresses.
//   - Chromium (renderer fetch + net.fetch) has no "prefer IPv4" switch, so we
//     resolve each host's IPv4 at startup and pin it via host-resolver-rules.
// Also disable QUIC so connections use reliable TCP. Must run before app ready.
require('node:dns').setDefaultResultOrder('ipv4first');
app.commandLine.appendSwitch('disable-quic');

// Resolve each host's IPv4 synchronously so host-resolver-rules is set BEFORE
// Electron's network service starts. (An async resolve races app readiness and
// often lands too late.) We run the bundled binary as Node to do the lookup.
const REALTIME_HOSTS = ['api.sanjakarobar.com', 'socket.sanjakarobar.com'];
function resolveIpv4Sync(host) {
  try {
    const script = `require('dns').resolve4(${JSON.stringify(host)},(e,a)=>{if(e||!a||!a[0])process.exit(1);process.stdout.write(a[0]);});`;
    const out = require('node:child_process').execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 4000, encoding: 'utf8',
    });
    return /^\d+\.\d+\.\d+\.\d+$/.test(out.trim()) ? out.trim() : null;
  } catch {
    return null; // Fall back to Chromium's default resolution for this host.
  }
}
const hostRules = REALTIME_HOSTS
  .map((host) => { const ip = resolveIpv4Sync(host); return ip ? `MAP ${host} ${ip}` : null; })
  .filter(Boolean);
if (hostRules.length) app.commandLine.appendSwitch('host-resolver-rules', hostRules.join(', '));

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const WINDOW_TITLE = 'DailyConnect — Messages';
const RELEASES_API_URL = 'https://api.github.com/repos/delickate/delickate-chatapp/releases/latest';
const RELEASES_DOWNLOAD_URL = 'https://github.com/delickate/delickate-chatapp/releases/download';
const IMAGE_TYPES = {
  'image/jpeg': {
    extension: 'jpg',
    signature: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  },
  'image/png': {
    extension: 'png',
    signature: (data) => data.subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/gif': {
    extension: 'gif',
    signature: (data) => data.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null,
  },
  'image/webp': {
    extension: 'webp',
    signature: (data) => data.length >= 12 &&
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  'image/bmp': {
    extension: 'bmp',
    signature: (data) => data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM',
  },
  'image/avif': {
    extension: 'avif',
    signature: (data) => data.length >= 12 &&
      data.subarray(4, 8).toString('ascii') === 'ftyp' &&
      ['avif', 'avis'].includes(data.subarray(8, 12).toString('ascii')),
  },
};

const SOCKET_EVENTS = [
  'connect',
  'disconnect',
  'connect_error',
  'presence:sync',
  'presence:update',
  'conversation:joined',
  'conversation:message',
  'conversation:read',
  'message.created',
  'message.updated',
  'conversation.read',
  'conversation.pins',
  'conversation.changed',
  'friends.changed',
  'conversation:typing',
  'conversation:stop-typing',
  'server:error',
  'call:config',
  'call:invite',
  'call:accepted',
  'call:answered-elsewhere',
  'call:rejected',
  'call:unavailable',
  'call:timeout',
  'call:ended',
  'call:signal',
  'call:busy',
  'call:error',
  'group-call:invite',
  'group-call:joined',
  'group-call:participant-joined',
  'group-call:participant-left',
  'group-call:signal',
  'group-call:dismissed',
  'group-call:ended',
  'group-call:error',
];
const MEDIA_PERMISSIONS = new Set(['media', 'camera', 'microphone']);
const CALL_CLIENT_EVENTS = new Set([
  'call:ready',
  'call:invite',
  'call:accept',
  'call:reject',
  'call:cancel',
  'call:end',
  'call:connected',
  'call:signal',
  'group-call:start',
  'group-call:join',
  'group-call:decline',
  'group-call:leave',
  'group-call:signal',
]);
let mainWindow;
let socketClient;
let tray = null;
let isQuitting = false;
let trayBalloonShown = false;

// Running in the tray keeps the socket alive so message notifications still
// arrive after the window is closed. These prefs live in a small file in the
// user-data dir (the renderer's localStorage isn't reachable from here).
function trayPrefsPath() {
  return path.join(app.getPath('userData'), 'tray-prefs.json');
}
function closeToTrayEnabled() {
  try {
    return JSON.parse(fsSync.readFileSync(trayPrefsPath(), 'utf8')).closeToTray !== false;
  } catch {
    return true; // default: keep running in the tray
  }
}
function setCloseToTray(value) {
  try {
    fsSync.writeFileSync(trayPrefsPath(), JSON.stringify({ closeToTray: Boolean(value) }));
  } catch (error) {
    console.error('Could not save tray preference:', error);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open DailyConnect', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: 'Keep running in the tray when closed',
      type: 'checkbox',
      checked: closeToTrayEnabled(),
      click: (item) => setCloseToTray(item.checked),
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({
        openAtLogin: item.checked,
        args: ['--hidden'],
      }),
    },
    { type: 'separator' },
    { label: 'Quit DailyConnect', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? iconPath : image);
  tray.setToolTip('DailyConnect');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  if (!match) {
    throw new Error(`Invalid application version: ${value}`);
  }
  return match.slice(1).map(Number);
}

function normalizeReleaseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? match[0].replace(/^v/i, '') : null;
}

function getReleaseDownloadUrl(release, version) {
  const exactVersion = version ? String(version).trim() : '';
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const installerAsset = assets.find((asset) => {
    const assetName = String(asset?.name || '').toLowerCase();
    return assetName.includes('dailyconnect') && (assetName.endsWith('.exe') || assetName.includes('setup'));
  });

  if (installerAsset?.browser_download_url) {
    return installerAsset.browser_download_url;
  }

  if (exactVersion) {
    const [major, minor, patch] = parseVersion(exactVersion);
    return `${RELEASES_DOWNLOAD_URL}/v${major}.${minor}.${patch}/DailyConnectSetup.exe`;
  }

  return release?.html_url || 'https://github.com/delickate/delickate-chatapp/releases';
}

function isNewerVersion(candidate, current) {
  const candidateParts = parseVersion(candidate);
  const currentParts = parseVersion(current);
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

function isMainWindowEvent(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents);
}

ipcMain.handle('desktop:check-updates', async (event) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Update checks are only available to the app window.');
  }

  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DailyConnect-Desktop',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'No DailyConnect release has been published yet.'
      : `GitHub update check failed (${response.status}).`);
  }

  const release = await response.json();
  const latestVersion = normalizeReleaseVersion(release?.tag_name);
  if (!latestVersion) {
    throw new Error('The latest GitHub release does not have a valid semantic version tag.');
  }

  parseVersion(latestVersion);
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, APP_VERSION),
  };
});

ipcMain.handle('desktop:download-update', async (event, version) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Updates can only be downloaded by the app window.');
  }

  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DailyConnect-Desktop',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status}).`);
  }

  const release = await response.json();
  const candidateUrl = getReleaseDownloadUrl(release, version);
  return shell.openExternal(candidateUrl);
});

ipcMain.handle('desktop:open-external', async (event, value) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Links can only be opened by the app window.');
  }
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('The link is invalid.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The link is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS links can be opened.');
  }

  return shell.openExternal(url.href);
});

ipcMain.handle('desktop:copy-text', (event, value) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Clipboard access is only available to the app window.');
  }
  if (typeof value !== 'string' || value.length > 10000) {
    throw new Error('The message text is invalid.');
  }

  clipboard.writeText(value);
  return true;
});

// Incoming-call invites must surface the window even when the app is minimized
// or in the background. Minimized windows have their renderer throttled, so the
// call popup would otherwise only appear after the user opens the app by hand.
const INCOMING_CALL_EVENTS = new Set(['call:invite', 'group-call:invite']);

function bringWindowToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  // Briefly force the window above others so the ringing UI is actually seen,
  // then drop always-on-top so it behaves like a normal window afterwards.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 1500);
  if (process.platform === 'win32' && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
}

function sendSocketEvent(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (INCOMING_CALL_EVENTS.has(event)) bringWindowToFront();
    mainWindow.webContents.send('chat:socket-event', { event, payload });
  }
}

function disconnectSocket() {
  if (socketClient) {
    socketClient.removeAllListeners();
    socketClient.disconnect();
    socketClient = null;
  }
}

ipcMain.handle('chat:socket-connect', async (_event, { url, token } = {}) => {
  let socketUrl;

  try {
    socketUrl = new URL(url);
  } catch {
    throw new Error('Enter a valid Socket.IO server URL.');
  }

  if (
    !['http:', 'https:'].includes(socketUrl.protocol) ||
    socketUrl.username ||
    socketUrl.password ||
    socketUrl.search ||
    socketUrl.hash ||
    socketUrl.pathname !== '/'
  ) {
    throw new Error('The Socket.IO URL must be an HTTP(S) server origin without a path.');
  }

  if (typeof token !== 'string' || token.length < 20 || token.length > 512) {
    throw new Error('A valid sign-in token is required for the socket connection.');
  }

  disconnectSocket();
  socketClient = io(socketUrl.origin, {
    auth: { token },
    timeout: 8000,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  for (const event of SOCKET_EVENTS) {
    socketClient.on(event, (payload) => {
      const safePayload = event === 'connect_error'
        ? { message: payload?.message || 'Socket connection failed.' }
        : payload;
      sendSocketEvent(event, safePayload);
    });
  }

  return true;
});

ipcMain.handle('chat:socket-disconnect', () => {
  disconnectSocket();
  return true;
});

ipcMain.handle('chat:socket-room', (_event, { conversationId, action } = {}) => {
  if (!socketClient?.connected || !Number.isSafeInteger(Number(conversationId)) || Number(conversationId) < 1) {
    return false;
  }

  const event = action === 'leave' ? 'conversation:leave' : 'conversation:join';
  socketClient.emit(event, { conversation_id: Number(conversationId) });
  return true;
});

ipcMain.handle('chat:socket-typing', (_event, { conversationId, isTyping } = {}) => {
  if (!socketClient?.connected || !Number.isSafeInteger(Number(conversationId)) || Number(conversationId) < 1) {
    return false;
  }

  socketClient.emit(isTyping ? 'conversation:typing' : 'conversation:stop-typing', {
    conversation_id: Number(conversationId),
  });
  return true;
});

ipcMain.handle('chat:message-event', (_event, { conversationId, messageId } = {}) => {
  if (!socketClient?.connected) return false;
  if (!Number.isSafeInteger(Number(conversationId)) || Number(conversationId) < 1 ||
    !Number.isSafeInteger(Number(messageId)) || Number(messageId) < 1) {
    throw new Error('The message notification is invalid.');
  }

  socketClient.emit('conversation:message', {
    conversation_id: Number(conversationId),
    message_id: Number(messageId),
  });
  return true;
});

ipcMain.handle('chat:read-event', (_event, { conversationId } = {}) => {
  if (!socketClient?.connected) return false;
  if (!Number.isSafeInteger(Number(conversationId)) || Number(conversationId) < 1) {
    throw new Error('The read notification is invalid.');
  }
  socketClient.emit('conversation:read', { conversation_id: Number(conversationId) });
  return true;
});

ipcMain.handle('chat:call-event', (_event, { event, payload } = {}) => {
  if (!CALL_CLIENT_EVENTS.has(event)) {
    throw new Error('Unsupported call event.');
  }
  if (!socketClient?.connected) {
    return false;
  }
  socketClient.emit(event, payload);
  return true;
});

// Windows only shows toasts for an app whose ID matches its Start-menu
// shortcut; Squirrel names it com.squirrel.<package name>.<executable name>.
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.squirrel.desktop.DailyConnect' : process.execPath);
}

const activeNotifications = new Set();

function showDesktopNotification({ title, body, conversationId }) {
  const notification = new Notification({
    title: title.slice(0, 120),
    body: body.slice(0, 240),
  });
  // Keep a reference so the notification is not garbage-collected before it is clicked.
  activeNotifications.add(notification);
  const release = () => activeNotifications.delete(notification);
  notification.on('close', release);
  notification.on('click', () => {
    release();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (conversationId) mainWindow.webContents.send('desktop:open-conversation', conversationId);
  });
  notification.on('failed', (_event, error) => {
    release();
    console.error('Windows could not show the notification:', error);
  });
  notification.show();
}

ipcMain.on('desktop:notify', (event, { title, body, conversationId } = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (typeof title !== 'string' || typeof body !== 'string' ||
    !Number.isSafeInteger(conversationId) || conversationId < 1) {
    console.error('Ignoring an invalid notification request from the renderer.');
    return;
  }
  if (mainWindow.isFocused() || !Notification.isSupported()) return;
  showDesktopNotification({ title, body, conversationId });
});

// Settings > "Send a test notification": shown even while the app is focused,
// so people can check that Windows allows DailyConnect's notifications.
ipcMain.handle('desktop:test-notification', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  if (!Notification.isSupported()) return false;
  showDesktopNotification({
    title: 'DailyConnect',
    body: 'Notifications are working. New messages will appear like this when the app is in the background.',
  });
  return true;
});

// Shows the unread count as a red badge on the app's taskbar / dock icon.
// Windows has no numeric taskbar badge, so we overlay a small red counter
// image (rendered by the renderer) on the bottom-right of the icon; macOS and
// Linux (Unity) show a real numeric badge via setBadgeCount.
function updateIconBadge(count, badge) {
  if (process.platform !== 'win32') {
    app.setBadgeCount(count);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (count < 1 || typeof badge !== 'string' ||
    !badge.startsWith('data:image/png;base64,') || badge.length > 50000) {
    mainWindow.setOverlayIcon(null, '');
    return;
  }

  const overlay = nativeImage.createFromDataURL(badge);
  if (overlay.isEmpty()) {
    mainWindow.setOverlayIcon(null, '');
    return;
  }
  mainWindow.setOverlayIcon(overlay, `${count} unread message${count === 1 ? '' : 's'}`);
}

ipcMain.on('chat:unread-count', (event, { count, notify, badge } = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (!Number.isSafeInteger(count) || count < 0 || typeof notify !== 'boolean') {
    console.error('Ignoring invalid unread-message count from the renderer.');
    return;
  }

  mainWindow.setTitle(count ? `(${count}) ${WINDOW_TITLE}` : WINDOW_TITLE);
  if (count === 0 || mainWindow.isFocused()) {
    mainWindow.flashFrame(false);
  } else if (notify) {
    mainWindow.flashFrame(true);
  }

  updateIconBadge(count, badge);
});

function attachmentCachePath(userId, conversationId, messageId, mime) {
  const user = Number(userId);
  const conversation = Number(conversationId);
  const message = Number(messageId);
  const imageType = IMAGE_TYPES[mime];
  if (!Number.isSafeInteger(user) || user < 1 ||
    !Number.isSafeInteger(conversation) || conversation < 1 ||
    !Number.isSafeInteger(message) || message < 1 || !imageType) {
    throw new Error('The image attachment details are invalid.');
  }

  return {
    imageType,
    path: path.join(
      app.getPath('userData'),
      'attachments',
      String(user),
      String(conversation),
      `${message}.${imageType.extension}`,
    ),
  };
}

function validateCachedImage(value, mime) {
  const imageType = IMAGE_TYPES[mime];
  if (!imageType) {
    throw new Error('This image format cannot be saved locally.');
  }

  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!data.length || data.length > MAX_ATTACHMENT_SIZE || !imageType.signature(data)) {
    throw new Error('The image data is invalid or exceeds the 5 MiB limit.');
  }

  return data;
}

ipcMain.handle('chat:attachment-save', async (_event, { userId, conversationId, messageId, mime, bytes } = {}) => {
  const { path: filePath } = attachmentCachePath(userId, conversationId, messageId, mime);
  const data = validateCachedImage(bytes, mime);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, data, { mode: 0o600 });
  return `data:${mime};base64,${data.toString('base64')}`;
});

ipcMain.handle('chat:attachment-read', async (_event, { userId, conversationId, messageId, mime } = {}) => {
  const { path: filePath } = attachmentCachePath(userId, conversationId, messageId, mime);
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const validated = validateCachedImage(data, mime);
  return `data:${mime};base64,${validated.toString('base64')}`;
});

ipcMain.handle('chat:attachment-delete', async (event, { userId, conversationId, messageId, mime } = {}) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Attachment deletion is only available to the app window.');
  }
  const { path: filePath } = attachmentCachePath(userId, conversationId, messageId, mime);
  await fs.rm(filePath, { force: true });
});

// Exports a chat transcript the renderer has already assembled (and decrypted).
// Opens a native Save dialog; the chosen extension (.txt or .html) picks format.
const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
ipcMain.handle('chat:export-save', async (event, { defaultName, text, html } = {}) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Chat export is only available to the app window.');
  }
  const hasText = typeof text === 'string';
  const hasHtml = typeof html === 'string';
  if (!hasText && !hasHtml) {
    throw new Error('There is nothing to export.');
  }
  if ((hasText && text.length > EXPORT_MAX_BYTES) || (hasHtml && html.length > EXPORT_MAX_BYTES)) {
    throw new Error('This conversation is too large to export.');
  }

  const base = String(defaultName || 'chat-export')
    .replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat-export';
  const filters = [];
  if (hasText) filters.push({ name: 'Text file', extensions: ['txt'] });
  if (hasHtml) filters.push({ name: 'Web page', extensions: ['html'] });

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export chat',
    defaultPath: `${base}.${hasText ? 'txt' : 'html'}`,
    filters,
  });
  if (canceled || !filePath) return { saved: false };

  const wantsHtml = path.extname(filePath).toLowerCase() === '.html' && hasHtml;
  const content = wantsHtml ? html : (hasText ? text : html);
  await fs.writeFile(filePath, content, 'utf8');
  return { saved: true, filePath };
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f4f7f6',
    autoHideMenuBar: true,
    // Launched at login with --hidden: start in the tray (still connects and
    // shows notifications), so Windows startup isn't interrupted by the window.
    show: !process.argv.includes('--hidden'),
    // Window / taskbar icon while running unpackaged (npm run start). Packaged
    // builds get their icon embedded in the .exe via packagerConfig.icon.
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
  });
  // Closing the window hides it to the tray (so notifications keep coming)
  // unless the user is really quitting or has turned that preference off.
  mainWindow.on('close', (event) => {
    if (!isQuitting && closeToTrayEnabled()) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayBalloonShown && process.platform === 'win32' && tray) {
        trayBalloonShown = true;
        tray.displayBalloon({
          title: 'DailyConnect is still running',
          content: 'It stays in the tray so you keep getting message notifications. Right-click the tray icon to quit.',
        });
      }
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  let mediaPermissionGranted = false;
  const requestMediaPermission = () => new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(false);
      return;
    }

    dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Allow microphone and camera',
      message: 'DailyConnect needs access to your microphone and camera for calls and voice messages.',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => {
      mediaPermissionGranted = response === 0;
      resolve(mediaPermissionGranted);
    }).catch((error) => {
      console.error('Media permission prompt failed:', error);
      resolve(false);
    });
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (!MEDIA_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }
    if (mediaPermissionGranted) {
      callback(true);
      return;
    }
    requestMediaPermission().then((granted) => callback(granted)).catch(() => callback(false));
  });
  createWindow();
  createTray();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // Stay alive in the tray (socket connected) when the user only closed the
  // window and tray-running is on; otherwise quit as usual.
  if (!isQuitting && closeToTrayEnabled()) {
    return;
  }
  disconnectSocket();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  disconnectSocket();
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
