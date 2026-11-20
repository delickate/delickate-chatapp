"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { afterEach, test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const {
  createSocketServer,
  getApiBaseUrl,
  getIceServers,
  parseAllowedOrigins,
  parsePort
} = require("./server");

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ io }) => new Promise((resolve) => io.close(resolve))));
});

async function startTestServer(options = {}) {
  const server = createSocketServer({
    allowedOrigins: ["http://localhost:3000"],
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch(),
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    ...options
  });
  servers.push(server);

  await new Promise((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });

  return `http://127.0.0.1:${server.httpServer.address().port}`;
}

function mockLaravelFetch({ deniedConversationId, mismatchedPeerConversationId } = {}) {
  return async (url, options) => {
    const token = options.headers.Authorization.replace("Bearer ", "");
    const userId = Number(token.split("-").at(-1));
    const pathname = new URL(url).pathname;

    if (pathname.endsWith("/auth/socket-identity")) {
      return Response.json({ id: userId, name: `User ${userId}`, phone: `+1555000000${userId}` });
    }

    if (pathname.endsWith("/friends")) {
      const friendId = userId === 1 ? 2 : 1;
      return Response.json({ data: [{ id: friendId, name: `User ${friendId}`, phone: `+1555000000${friendId}` }] });
    }

    if (pathname.includes("/socket-access")) {
      const conversationId = Number(pathname.split("/").at(-2));

      if (conversationId === deniedConversationId) {
        return Response.json({ message: "Not found." }, { status: 404 });
      }

      const peerId = conversationId === mismatchedPeerConversationId
        ? 3
        : userId === 1 ? 2 : 1;
      return Response.json({
        conversation_id: conversationId,
        peer_id: peerId,
        participant_ids: [userId, peerId]
      });
    }

    return Response.json({ message: "Not found." }, { status: 404 });
  };
}

async function connectClient(baseUrl, userId) {
  const client = createClient(baseUrl, {
    auth: { token: `a-valid-sanctum-token-for-user-${userId}` },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000
  });
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
  return client;
}

function waitForEvent(client, event) {
  return new Promise((resolve) => client.once(event, resolve));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
      });
    }).on("error", reject);
  });
}

test("health endpoint reports the server as ready", async () => {
  const baseUrl = await startTestServer();

  assert.deepEqual(await getJson(`${baseUrl}/health`), {
    statusCode: 200,
    body: { status: "ok" }
  });
});

test("unknown HTTP paths return a JSON 404", async () => {
  const baseUrl = await startTestServer();

  assert.deepEqual(await getJson(`${baseUrl}/unknown`), {
    statusCode: 404,
    body: { error: "Not found" }
  });
});

test("socket clients can ping and receive a timestamped pong", async () => {
  const baseUrl = await startTestServer();
  const client = createClient(baseUrl, {
    auth: { token: "a-valid-sanctum-token-for-user-1" },
    transports: ["websocket"]
  });

  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });

    const pong = new Promise((resolve) => client.once("server:pong", resolve));
    client.emit("client:ping");
    const response = await pong;

    assert.equal(typeof response.timestamp, "string");
    assert.equal(Number.isNaN(Date.parse(response.timestamp)), false);
  } finally {
    client.close();
  }
});

test("new message notifications reach all authorized conversation participants", async () => {
  const baseUrl = await startTestServer();
  const sender = await connectClient(baseUrl, 1);
  const recipient = await connectClient(baseUrl, 2);

  try {
    const notification = waitForEvent(recipient, "conversation:message");
    sender.emit("conversation:message", { conversation_id: 42, message_id: 108 });

    assert.deepEqual(await notification, { conversation_id: 42, message_id: 108 });
  } finally {
    sender.close();
    recipient.close();
  }
});

test("call invites cannot target a friend outside the selected conversation", async () => {
  const baseUrl = await startTestServer({
    fetchImpl: mockLaravelFetch({ mismatchedPeerConversationId: 42 })
  });
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const rejected = waitForEvent(caller, "call:error");
    caller.emit("call:invite", {
      call_id: "test-call-id-222222",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    assert.deepEqual(await rejected, {
      call_id: "test-call-id-222222",
      message: "Conversation access denied."
    });
  } finally {
    caller.close();
    callee.close();
  }
});

test("socket connections from origins outside the allowlist are rejected", async () => {
  const baseUrl = await startTestServer();
  const client = createClient(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { Origin: "https://untrusted.example" },
    reconnection: false,
    timeout: 2000
  });

  try {
    await assert.rejects(new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    }));
  } finally {
    client.close();
  }
});

test("configuration rejects malformed origins and ports", () => {
  assert.throws(() => parseAllowedOrigins("https://example.com/path"), /without paths/);
  assert.throws(() => parsePort("not-a-port"), /Invalid PORT/);
  assert.throws(() => getApiBaseUrl("file:///api"), /HTTP\(S\).*ending in \/api/);
  assert.deepEqual(getIceServers({
    stunUrls: "stun:stun.example.test:3478",
    turnUrls: "turn:relay.example.test:3478,turns:relay.example.test:5349",
    turnUsername: "pitbconnect-test-user",
    turnCredential: "secret"
  }), [
    { urls: "stun:stun.example.test:3478" },
    {
      urls: ["turn:relay.example.test:3478", "turns:relay.example.test:5349"],
      username: "pitbconnect-test-user",
      credential: "secret"
    }
  ]);
  assert.throws(() => getIceServers({
    stunUrls: "stun:stun.example.test:3478",
    turnUrls: "turn:relay.example.test:3478"
  }), /TURN_SERVER_USERNAME and TURN_SERVER_CREDENTIAL/);
});

test("socket authentication rejects missing or invalid tokens", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch()
  });
  const client = createClient(baseUrl, {
    auth: { token: "short" },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000
  });

  try {
    await assert.rejects(waitForConnection(client), /Authentication required/);
  } finally {
    client.close();
  }
});

function waitForConnection(client) {
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
}

test("friends receive online presence updates and an initial presence snapshot", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch()
  });
  const first = createClient(baseUrl, {
    auth: { token: "a-valid-sanctum-token-for-user-1" },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000
  });
  const firstSnapshot = waitForEvent(first, "presence:sync");
  await waitForConnection(first);
  let second;

  try {
    assert.deepEqual(await firstSnapshot, [{ user_id: 2, is_online: false }]);

    const online = waitForEvent(first, "presence:update");
    second = createClient(baseUrl, {
      auth: { token: "a-valid-sanctum-token-for-user-2" },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2000
    });
    const secondSnapshot = waitForEvent(second, "presence:sync");
    await waitForConnection(second);
    assert.deepEqual(await online, { user_id: 2, is_online: true });

    assert.deepEqual(await secondSnapshot, [{ user_id: 1, is_online: true }]);

    const offline = waitForEvent(first, "presence:update");
    second.disconnect();
    assert.deepEqual(await offline, { user_id: 2, is_online: false });
  } finally {
    first.close();
    second?.close();
  }
});

test("authorized conversation members receive typing updates without trusting client user IDs", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch()
  });
  const first = await connectClient(baseUrl, 1);
  const second = await connectClient(baseUrl, 2);

  try {
    const firstJoined = waitForEvent(first, "conversation:joined");
    const secondJoined = waitForEvent(second, "conversation:joined");
    first.emit("conversation:join", { conversation_id: 42 });
    second.emit("conversation:join", { conversation_id: 42 });
    assert.deepEqual(await firstJoined, { conversation_id: 42 });
    assert.deepEqual(await secondJoined, { conversation_id: 42 });

    const typing = waitForEvent(second, "conversation:typing");
    first.emit("conversation:typing", { conversation_id: 42, user_id: 999 });
    assert.deepEqual(await typing, {
      conversation_id: 42,
      user_id: 1,
      name: "User 1"
    });

    const stopped = waitForEvent(second, "conversation:stop-typing");
    first.emit("conversation:stop-typing", { conversation_id: 42 });
    assert.deepEqual(await stopped, { conversation_id: 42, user_id: 1 });
  } finally {
    first.close();
    second.close();
  }
});

test("socket server does not join a conversation rejected by Laravel", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch({ deniedConversationId: 43 })
  });
  const client = await connectClient(baseUrl, 1);
  const friend = await connectClient(baseUrl, 2);

  try {
    const error = waitForEvent(client, "server:error");
    client.emit("conversation:join", { conversation_id: 43 });
    assert.deepEqual(await error, { message: "You do not have access to this conversation." });

    let receivedTyping = false;
    friend.once("conversation:typing", () => {
      receivedTyping = true;
    });
    client.emit("conversation:typing", { conversation_id: 43 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receivedTyping, false);
  } finally {
    client.close();
    friend.close();
  }
});

test("friends can establish an authorized one-to-one call and relay WebRTC signals", async () => {
  const baseUrl = await startTestServer();
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    const iceConfig = waitForEvent(callee, "call:config");
    callee.emit("call:ready", { enabled: true });
    assert.deepEqual(await iceConfig, {
      ice_servers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const invite = waitForEvent(callee, "call:invite");
    caller.emit("call:invite", {
      call_id: "test-call-id-123456",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "video"
    });
    assert.deepEqual(await invite, {
      call_id: "test-call-id-123456",
      conversation_id: 42,
      caller_id: 1,
      caller_name: "User 1",
      media_type: "video"
    });

    const accepted = waitForEvent(caller, "call:accepted");
    callee.emit("call:accept", { call_id: "test-call-id-123456" });
    assert.deepEqual(await accepted, { call_id: "test-call-id-123456" });

    const signal = waitForEvent(callee, "call:signal");
    caller.emit("call:signal", {
      call_id: "test-call-id-123456",
      signal: { type: "offer", sdp: "test-sdp" }
    });
    assert.deepEqual(await signal, {
      call_id: "test-call-id-123456",
      signal: { type: "offer", sdp: "test-sdp" }
    });

    caller.emit("call:connected", { call_id: "test-call-id-123456" });
    const ended = waitForEvent(callee, "call:ended");
    caller.emit("call:end", { call_id: "test-call-id-123456" });
    const endedPayload = await ended;
    assert.equal(endedPayload.call_id, "test-call-id-123456");
    assert.equal(endedPayload.conversation_id, 42);
    assert.equal(endedPayload.caller_id, 1);
    assert.equal(endedPayload.media_type, "video");
    assert.equal(endedPayload.call_status, "completed");
    assert.equal(Number.isInteger(endedPayload.duration_seconds), true);
  } finally {
    caller.close();
    callee.close();
  }
});

test("declined calls are reported as missed call summaries", async () => {
  const baseUrl = await startTestServer();
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    callee.emit("call:ready", { enabled: true });
    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const invite = waitForEvent(callee, "call:invite");
    caller.emit("call:invite", {
      call_id: "test-call-id-987654",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    await invite;

    const missed = waitForEvent(caller, "call:rejected");
    callee.emit("call:reject", { call_id: "test-call-id-987654" });
    const missedPayload = await missed;
    assert.equal(missedPayload.call_id, "test-call-id-987654");
    assert.equal(missedPayload.call_status, "missed");
    assert.equal(missedPayload.conversation_id, 42);
    assert.equal(missedPayload.caller_id, 1);
    assert.equal(missedPayload.media_type, "audio");
  } finally {
    caller.close();
    callee.close();
  }
});

test("calls cancelled while ringing are reported as missed call summaries", async () => {
  const baseUrl = await startTestServer();
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    callee.emit("call:ready", { enabled: true });
    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const invite = waitForEvent(callee, "call:invite");
    caller.emit("call:invite", {
      call_id: "test-call-id-cancel1",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "video"
    });
    await invite;

    const endedForCaller = waitForEvent(caller, "call:ended");
    const endedForCallee = waitForEvent(callee, "call:ended");
    caller.emit("call:cancel", { call_id: "test-call-id-cancel1" });
    for (const payload of await Promise.all([endedForCaller, endedForCallee])) {
      assert.equal(payload.call_id, "test-call-id-cancel1");
      assert.equal(payload.call_status, "missed");
      assert.equal(payload.caller_id, 1);
      assert.equal(payload.media_type, "video");
      assert.equal(payload.duration_seconds, 0);
    }
  } finally {
    caller.close();
    callee.close();
  }
});

test("call signaling requires an enabled friend in the authorized conversation", async () => {
  const baseUrl = await startTestServer();
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    callee.emit("call:ready", { enabled: true });
    const rejected = waitForEvent(caller, "call:error");
    caller.emit("call:invite", {
      call_id: "test-call-id-123456",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    assert.deepEqual(await rejected, {
      call_id: "test-call-id-123456",
      message: "This call could not be started."
    });

    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const invalidPeer = waitForEvent(caller, "call:error");
    caller.emit("call:invite", {
      call_id: "test-call-id-654321",
      conversation_id: 42,
      target_user_id: 1,
      media_type: "audio"
    });
    assert.deepEqual(await invalidPeer, {
      call_id: "test-call-id-654321",
      message: "This call could not be started."
    });

    callee.emit("call:ready", { enabled: false });
    const unavailable = waitForEvent(caller, "call:unavailable");
    caller.emit("call:invite", {
      call_id: "test-call-id-111111",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    assert.equal((await unavailable).call_id, "test-call-id-111111");
  } finally {
    caller.close();
    callee.close();
  }
});

const GROUP_CONVERSATION_ID = 77;

function mockGroupFetch() {
  const direct = mockLaravelFetch();
  return async (url, options) => {
    const token = options.headers.Authorization.replace("Bearer ", "");
    const userId = Number(token.split("-").at(-1));
    const pathname = new URL(url).pathname;

    if (pathname.endsWith("/friends")) {
      const friendIds = [1, 2, 3, 4].filter((id) => id !== userId);
      return Response.json({ data: friendIds.map((id) => ({ id, name: `User ${id}` })) });
    }
    if (pathname.endsWith(`/conversations/${GROUP_CONVERSATION_ID}/socket-access`)) {
      if (userId === 4) return Response.json({ message: "Not found." }, { status: 404 });
      return Response.json({ conversation_id: GROUP_CONVERSATION_ID, peer_id: null, participant_ids: [1, 2, 3] });
    }
    return direct(url, options);
  };
}

async function connectGroupClient(baseUrl, userId) {
  const client = await connectClient(baseUrl, userId);
  const config = waitForEvent(client, "call:config");
  client.emit("call:ready", { enabled: true, group_calls: true });
  await config;
  return client;
}

test("group members can start, join, signal, and leave a mesh group call", async () => {
  const baseUrl = await startTestServer({ fetchImpl: mockGroupFetch() });
  const [first, second, third] = await Promise.all([1, 2, 3].map((id) => connectGroupClient(baseUrl, id)));
  const callId = "group-call-id-123456";

  try {
    const starterJoined = waitForEvent(first, "group-call:joined");
    const secondInvite = waitForEvent(second, "group-call:invite");
    const thirdInvite = waitForEvent(third, "group-call:invite");
    first.emit("group-call:start", { call_id: callId, conversation_id: GROUP_CONVERSATION_ID, media_type: "audio" });
    assert.deepEqual(await starterJoined, {
      call_id: callId,
      conversation_id: GROUP_CONVERSATION_ID,
      caller_id: 1,
      media_type: "audio",
      participants: []
    });
    const expectedInvite = {
      call_id: callId,
      conversation_id: GROUP_CONVERSATION_ID,
      caller_id: 1,
      caller_name: "User 1",
      media_type: "audio"
    };
    assert.deepEqual(await secondInvite, expectedInvite);
    assert.deepEqual(await thirdInvite, expectedInvite);

    const secondJoined = waitForEvent(second, "group-call:joined");
    const firstSawSecond = waitForEvent(first, "group-call:participant-joined");
    second.emit("group-call:join", { call_id: callId });
    assert.deepEqual((await secondJoined).participants, [{ user_id: 1, name: "User 1" }]);
    assert.deepEqual(await firstSawSecond, { call_id: callId, user_id: 2, name: "User 2" });

    const relayed = waitForEvent(first, "group-call:signal");
    second.emit("group-call:signal", { call_id: callId, to_user_id: 1, signal: { description: { type: "offer", sdp: "x" } } });
    assert.deepEqual(await relayed, {
      call_id: callId,
      from_user_id: 2,
      signal: { description: { type: "offer", sdp: "x" } }
    });

    const thirdJoined = waitForEvent(third, "group-call:joined");
    third.emit("group-call:join", { call_id: callId });
    assert.deepEqual((await thirdJoined).participants.map((item) => item.user_id), [1, 2]);

    const firstSawThirdLeave = waitForEvent(first, "group-call:participant-left");
    third.emit("group-call:leave", { call_id: callId });
    assert.deepEqual(await firstSawThirdLeave, { call_id: callId, user_id: 3 });

    // With only one person left the call ends for every group member.
    const endedForThird = waitForEvent(third, "group-call:ended");
    second.emit("group-call:leave", { call_id: callId });
    const summary = await endedForThird;
    assert.equal(summary.call_id, callId);
    assert.equal(summary.conversation_id, GROUP_CONVERSATION_ID);
    assert.equal(summary.caller_id, 1);
    assert.equal(summary.call_status, "completed");
    assert.equal(Number.isInteger(summary.duration_seconds), true);
  } finally {
    first.close();
    second.close();
    third.close();
  }
});

test("an unanswered group call ends as missed and non-members cannot join", async () => {
  const baseUrl = await startTestServer({ fetchImpl: mockGroupFetch(), groupCallRingMs: 80 });
  const [first, outsider] = await Promise.all([1, 4].map((id) => connectGroupClient(baseUrl, id)));
  const callId = "group-call-id-654321";

  try {
    const joined = waitForEvent(first, "group-call:joined");
    first.emit("group-call:start", { call_id: callId, conversation_id: GROUP_CONVERSATION_ID, media_type: "video" });
    await joined;

    const rejected = waitForEvent(outsider, "group-call:error");
    outsider.emit("group-call:join", { call_id: callId });
    assert.equal((await rejected).call_id, callId);

    const ended = await waitForEvent(first, "group-call:ended");
    assert.equal(ended.call_status, "missed");
    assert.equal(ended.duration_seconds, 0);
    assert.equal(ended.media_type, "video");
  } finally {
    first.close();
    outsider.close();
  }
});

test("group calls cannot be started in a direct conversation and a second start joins the running call", async () => {
  const baseUrl = await startTestServer({ fetchImpl: mockGroupFetch() });
  const [first, second] = await Promise.all([1, 2].map((id) => connectGroupClient(baseUrl, id)));

  try {
    const directError = waitForEvent(first, "group-call:error");
    first.emit("group-call:start", { call_id: "group-call-direct-0001", conversation_id: 42, media_type: "audio" });
    assert.equal((await directError).message, "Group calls are only available in group chats.");

    const firstJoined = waitForEvent(first, "group-call:joined");
    first.emit("group-call:start", { call_id: "group-call-first-00001", conversation_id: GROUP_CONVERSATION_ID, media_type: "audio" });
    await firstJoined;

    const secondJoined = waitForEvent(second, "group-call:joined");
    second.emit("group-call:start", { call_id: "group-call-second-0001", conversation_id: GROUP_CONVERSATION_ID, media_type: "video" });
    const running = await secondJoined;
    assert.equal(running.call_id, "group-call-first-00001");
    assert.equal(running.media_type, "audio");

    // While in a group call the user is busy for one-to-one calls too.
    const joinedRoom = waitForEvent(first, "conversation:joined");
    first.emit("conversation:join", { conversation_id: 42 });
    await joinedRoom;
    const busy = waitForEvent(first, "call:busy");
    first.emit("call:invite", { call_id: "direct-while-busy-0001", conversation_id: 42, target_user_id: 2, media_type: "audio" });
    assert.equal((await busy).call_id, "direct-while-busy-0001");
  } finally {
    first.close();
    second.close();
  }
});

test("message notifications reuse a cached participant lookup instead of calling Laravel every time", async () => {
  let accessLookups = 0;
  const baseFetch = mockLaravelFetch();
  const baseUrl = await startTestServer({
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname.includes("/socket-access")) accessLookups += 1;
      return baseFetch(url, options);
    }
  });
  const sender = await connectClient(baseUrl, 1);
  const recipient = await connectClient(baseUrl, 2);

  try {
    for (const messageId of [501, 502, 503]) {
      const delivered = waitForEvent(recipient, "conversation:message");
      sender.emit("conversation:message", { conversation_id: 42, message_id: messageId });
      assert.deepEqual(await delivered, { conversation_id: 42, message_id: messageId });
    }
    assert.equal(accessLookups, 1);
  } finally {
    sender.close();
    recipient.close();
  }
});

test("read notifications reach conversation members with the reader's verified id", async () => {
  const baseUrl = await startTestServer();
  const reader = await connectClient(baseUrl, 2);
  const sender = await connectClient(baseUrl, 1);

  try {
    const seen = waitForEvent(sender, "conversation:read");
    reader.emit("conversation:read", { conversation_id: 42, user_id: 999 });
    assert.deepEqual(await seen, { conversation_id: 42, user_id: 2 });
  } finally {
    reader.close();
    sender.close();
  }
});

function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("the API can push events to users through the internal endpoint", async () => {
  const secret = "test-internal-secret-0123456789";
  const baseUrl = await startTestServer({ internalEventsSecret: secret });
  const recipient = await connectClient(baseUrl, 2);
  const bystander = await connectClient(baseUrl, 1);
  let bystanderGotIt = false;
  bystander.on("message.created", () => { bystanderGotIt = true; });

  try {
    const delivered = waitForEvent(recipient, "message.created");
    const response = await postJson(`${baseUrl}/internal/events`, {
      events: [{ event: "message.created", user_ids: [2], payload: { conversation_id: 42, message: { id: 7 } } }]
    }, { Authorization: `Bearer ${secret}` });
    assert.equal(response.status, 202);
    assert.deepEqual(await delivered, { conversation_id: 42, message: { id: 7 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bystanderGotIt, false);

    const wrongSecret = await postJson(`${baseUrl}/internal/events`, { events: [] }, { Authorization: "Bearer nope" });
    assert.equal(wrongSecret.status, 401);

    const badEvent = await postJson(`${baseUrl}/internal/events`, {
      events: [{ event: "call:invite", user_ids: [2], payload: {} }]
    }, { Authorization: `Bearer ${secret}` });
    assert.equal(badEvent.status, 422);
  } finally {
    recipient.close();
    bystander.close();
  }
});

test("the internal endpoint is disabled when no secret is configured", async () => {
  const baseUrl = await startTestServer({ internalEventsSecret: "" });
  const response = await postJson(`${baseUrl}/internal/events`, { events: [] }, { Authorization: "Bearer " });
  assert.equal(response.status, 401);
});
