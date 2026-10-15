# Daylight Desktop

Electron desktop client for the Laravel chat API.

## Start

Start the Laravel backend first (default API address is
`http://127.0.0.1:8000/api`), then run these commands from this folder:

```powershell
npm install
npm start
```

Use **API connection settings** on the sign-in page to save a different
Laravel API URL (ending in `/api`) or Socket.IO server origin. Both settings
are saved locally for this desktop user. The default socket URL is
`http://127.0.0.1:3001`.

## Included

- Sign-up with name, international phone number, email, date of birth, and
  password.
- Sign-in with phone number and password.
- Bearer-token session and sign-out.
- Friend requests by phone, incoming request accept/reject, and accepted
  friends list.
- One-to-one chat with paginated message history, send, unread counts, and
  seen/delivered receipt display.
- Attach and download JPEG, PNG, GIF, WebP, PDF, and plain-text files (5 MiB
  maximum). The desktop checks the size before sending; Laravel performs the
  authoritative size, type, and content validation.
- Image attachments are cached per signed-in user in Electron's local
  application data folder on both sender and recipient devices. Cached images
  appear inline in chat and remain available after restarting the desktop app.
- One-to-one voice and video calls with incoming-call, mute, camera, and
  hang-up controls. Electron asks permission for microphone and camera access;
  configure OS-level device permissions as well.

The desktop client connects to the authenticated Socket.IO service for online
presence and typing indicators. The service validates Sanctum tokens and
conversation membership with Laravel. Friend, conversation, and message lists
continue to refresh via the REST API every five seconds.
Calls use WebRTC peer-to-peer media and the Socket.IO service for authorized
signaling. A TURN relay is recommended for reliable connections across mobile
networks and restrictive firewalls.

For packaging, use `npm run make` with Electron Forge.
