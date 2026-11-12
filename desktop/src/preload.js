'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SOCKET_EVENTS = new Set([
  'connect',
  'disconnect',
  'connect_error',
  'presence:sync',
  'presence:update',
  'conversation:joined',
  'conversation:message',
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
  notifyMessage: (conversationId, messageId) => ipcRenderer.invoke('chat:message-event', {
    conversationId,
    messageId,
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
  deleteImage: (attachment) => ipcRenderer.invoke('chat:attachment-delete', attachment),
});

contextBridge.exposeInMainWorld('desktopApp', {
  setUnreadCount: (count, notify) => ipcRenderer.send('chat:unread-count', { count, notify }),
  showNotification: (notification) => ipcRenderer.send('desktop:notify', notification),
  onOpenConversation: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, conversationId) => callback(conversationId);
    ipcRenderer.on('desktop:open-conversation', listener);
    return () => ipcRenderer.removeListener('desktop:open-conversation', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  copyText: (text) => ipcRenderer.invoke('desktop:copy-text', text),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: (version) => ipcRenderer.invoke('desktop:download-update', version),
});
