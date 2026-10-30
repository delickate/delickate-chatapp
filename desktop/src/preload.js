'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SOCKET_EVENTS = new Set([
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
]);

contextBridge.exposeInMainWorld('chatSocket', {
  connect: (options) => ipcRenderer.invoke('chat:socket-connect', options),
  disconnect: () => ipcRenderer.invoke('chat:socket-disconnect'),
  joinConversation: (conversationId) => ipcRenderer.invoke('chat:socket-room', {
    conversationId,
    action: 'join',
  }),
  leaveConversation: (conversationId) => ipcRenderer.invoke('chat:socket-room', {
    conversationId,
    action: 'leave',
  }),
  setTyping: (conversationId, isTyping) => ipcRenderer.invoke('chat:socket-typing', {
    conversationId,
    isTyping,
  }),
  sendCallEvent: (event, payload) => ipcRenderer.invoke('chat:call-event', { event, payload }),
  onEvent: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('Socket event handler must be a function.');
    }

    const listener = (_event, message) => {
      if (message && SOCKET_EVENTS.has(message.event)) {
        callback(message.event, message.payload);
      }
    };
    ipcRenderer.on('chat:socket-event', listener);
    return () => ipcRenderer.removeListener('chat:socket-event', listener);
  },
});

contextBridge.exposeInMainWorld('localAttachments', {
  saveImage: (attachment) => ipcRenderer.invoke('chat:attachment-save', attachment),
  readImage: (attachment) => ipcRenderer.invoke('chat:attachment-read', attachment),
});

contextBridge.exposeInMainWorld('desktopApp', {
  setUnreadCount: (count, notify) => ipcRenderer.send('chat:unread-count', { count, notify }),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: (version) => ipcRenderer.invoke('desktop:download-update', version),
});
