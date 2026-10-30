const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { io } = require('socket.io-client');
const { version: APP_VERSION } = require('../package.json');

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const WINDOW_TITLE = 'PITBConnect — Messages';
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
];
const CALL_CLIENT_EVENTS = new Set([
  'call:ready',
  'call:invite',
  'call:accept',
  'call:reject',
  'call:cancel',
  'call:end',
  'call:signal',
]);
let mainWindow;
let socketClient;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid application version: ${value}`);
  }
  return match.slice(1).map(Number);
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
      'User-Agent': 'PITBConnect-Desktop',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(response.status === 404
      ? 'No PITBConnect release has been published yet.'
      : `GitHub update check failed (${response.status}).`);
  }

  const release = await response.json();
  if (typeof release.tag_name !== 'string') {
    throw new Error('The latest GitHub release does not have a valid version tag.');
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  parseVersion(latestVersion);
  return {
    currentVersion: APP_VERSION,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, APP_VERSION),
  };
});

ipcMain.handle('desktop:download-update', (event, version) => {
  if (!isMainWindowEvent(event)) {
    throw new Error('Updates can only be downloaded by the app window.');
  }
  const [major, minor, patch] = parseVersion(version);
  return shell.openExternal(
    `${RELEASES_DOWNLOAD_URL}/v${major}.${minor}.${patch}/PITBConnectSetup.exe`,
  );
});

function sendSocketEvent(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
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

ipcMain.on('chat:unread-count', (event, { count, notify } = {}) => {
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  let mediaPermissionGranted = false;
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }
    if (mediaPermissionGranted) {
      callback(true);
      return;
    }
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Allow microphone and camera',
      message: 'PITBConnect needs access to your microphone and camera for calls.',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
    }).then(({ response }) => {
      mediaPermissionGranted = response === 0;
      callback(mediaPermissionGranted);
    }).catch((error) => {
      console.error('Media permission prompt failed:', error);
      callback(false);
    });
  });
  createWindow();

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
  disconnectSocket();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', disconnectSocket);

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
