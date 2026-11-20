# Socket server

Standalone Node.js + Socket.IO service for authenticated chat presence and
typing indicators. Laravel remains the source of truth for users, friendships,
conversations, messages, and read receipts.

## Run locally

Requirements: Node.js 20+, npm, and the Laravel API running at
`http://127.0.0.1:8000/api`.

```powershell
npm install
Copy-Item .env.example .env
npm start
```

The service listens on `http://localhost:3001` by default. Configure the
desktop client's **Socket.IO URL** as `http://127.0.0.1:3001`. Set
`LARAVEL_API_URL` to the Laravel API address ending in `/api`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP and Socket.IO listening port |
| `HOST` | `0.0.0.0` | Network interface to bind |
| `LARAVEL_API_URL` | `http://127.0.0.1:8000/api` | Laravel API base URL ending in `/api` |
| `CORS_ORIGINS` | Common local development origins | Comma-separated browser origins allowed to connect |
| `STUN_SERVER_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs sent to call-capable clients |
| `TURN_SERVER_URLS` | Empty | Optional comma-separated TURN/TURNS URLs |
| `TURN_SERVER_USERNAME` | Empty | TURN username; required with TURN URLs |
| `TURN_SERVER_CREDENTIAL` | Empty | TURN credential; required with TURN URLs |

Use HTTPS for both deployed services. Set browser origins to the exact
production origins; native desktop connections without an Origin header are
supported. Every connection still requires a valid Sanctum bearer token.
Calls between different networks generally need a TURN relay; the default public
STUN server alone cannot relay media when either network blocks direct
peer-to-peer traffic. Configure `TURN_SERVER_URLS`, `TURN_SERVER_USERNAME`, and
`TURN_SERVER_CREDENTIAL` on the deployed socket server, then restart it. Use
short-lived credentials where your relay supports them. The server sends its ICE
configuration only to authenticated, call-capable sockets.

## Socket events

- Client connects with Socket.IO auth `{ token }`. The server validates the
  token through `GET /api/auth/socket-identity` and loads accepted friends from
  `GET /api/friends`.
- Server emits `presence:sync` with `{ user_id, is_online }[]` on connection and
  `presence:update` with `{ user_id, is_online }` to accepted friends when a
  user's first device comes online or last device goes offline.
- Client requests a room with `conversation:join` and
  `{ conversation_id }`. The server joins only after Laravel authorizes
  `GET /api/conversations/{id}/socket-access`.
- In an authorized room, clients can send `conversation:typing` and
  `conversation:stop-typing` with `{ conversation_id }`. The server derives
  the user ID from the authenticated socket, relays to other room members, and
  automatically clears stale typing state.
- Call-capable clients announce `call:ready` with `{ enabled: true }`. A caller
  sends `call:invite` with `{ call_id, conversation_id, target_user_id,
  media_type }`. The server verifies the caller is in the authorized one-to-one
  room, the target is the conversation peer and an accepted friend, and the
  target has a call-capable socket. The receiver responds with `call:accept` or
  `call:reject`; `call:signal` relays bounded WebRTC SDP/ICE payloads only
  between the two authenticated call participants. `call:cancel` and
  `call:end` release call state. Invitations expire after 30 seconds. Call
  signaling is ephemeral and does not store media or call history.
- Group calls use a mesh (one WebRTC connection per pair of participants, up to
  8 people) and separate `group-call:*` events, so one-to-one clients are
  unaffected. Clients opt in with `call:ready` `{ enabled: true, group_calls: true }`.
  `group-call:start` `{ call_id, conversation_id, media_type }` is verified
  against Laravel's group membership and rings every member with
  `group-call:invite`; starting in a group that already has a call joins it
  instead. Members answer with `group-call:join` (or `group-call:decline`) and
  receive `group-call:joined` with the current participants; the joiner offers
  to each of them through `group-call:signal` `{ call_id, to_user_id, signal }`,
  which is delivered with `from_user_id`. `group-call:leave` (or a disconnect)
  removes a participant. The call ends when one person is left after it
  connected, or after 45 seconds with nobody answering, and every member
  receives `group-call:ended` with a missed/completed summary. A user in a group
  call is busy for one-to-one calls.
- The server responds to enabled clients with `call:config` and its
  `{ ice_servers }` list, built from the STUN/TURN environment settings.
- WebRTC media is peer-to-peer when possible and uses the configured TURN relay
  when direct connectivity is blocked. STUN-only setup is not sufficient for
  many combinations of office, mobile, and home networks. Deploy the service
  over HTTPS/WSS; browsers require a secure context for microphone/camera access.
- `GET /health` returns `{"status":"ok"}`.

Typing and presence are ephemeral in-memory socket state; they are not stored
in Laravel. The current implementation is single-process. For a multi-instance
deployment, use a shared Socket.IO adapter and shared presence/typing storage.

## Tests

```powershell
npm test
```
