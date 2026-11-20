"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const http = require("node:http");
const { Server } = require("socket.io");

const MAX_GROUP_CALL_PARTICIPANTS = 8;
const INTERNAL_EVENTS_MAX_BYTES = 2 * 1024 * 1024;
// Event names the API may push, e.g. "message.created", "conversation.changed".
const INTERNAL_EVENT_NAME = /^(message|conversation|friends)\.[a-z-]{1,40}$/;
const GROUP_CALL_RING_MS = 45_000;

const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8081",
  "http://localhost:19006"
];

function getApiBaseUrl(value = process.env.LARAVEL_API_URL || "https://api.sanjakarobar.com/api") {
  let parsedUrl;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`Invalid LARAVEL_API_URL: ${value}`);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol) || !parsedUrl.pathname.replace(/\/+$/, "").endsWith("/api")) {
    throw new Error("LARAVEL_API_URL must be an HTTP(S) URL ending in /api");
  }

  return value.replace(/\/+$/, "");
}

function parseAllowedOrigins(value = process.env.CORS_ORIGINS) {
  if (value === undefined) {
    return DEFAULT_ORIGINS;
  }

  return value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => {
    let parsedOrigin;

    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }

    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.origin !== origin
    ) {
      throw new Error(`CORS entries must be origins without paths: ${origin}`);
    }

    return origin;
  });
}

function getIceServers({
  stunUrls = process.env.STUN_SERVER_URLS || "stun:stun.l.google.com:19302",
  turnUrls = process.env.TURN_SERVER_URLS || "",
  turnUsername = process.env.TURN_SERVER_USERNAME || "",
  turnCredential = process.env.TURN_SERVER_CREDENTIAL || ""
} = {}) {
  const urls = (value, label) => value.split(",").map((url) => url.trim()).filter(Boolean).map((url) => {
    if (!/^(stun|stuns|turn|turns):[^\s]+$/i.test(url)) {
      throw new Error(`Invalid ${label} URL: ${url}`);
    }
    return url;
  });
  const stunServerUrls = urls(stunUrls, "STUN");
  if (!stunServerUrls.every((url) => /^(stun|stuns):/i.test(url))) {
    throw new Error("STUN_SERVER_URLS may contain only stun: or stuns: URLs");
  }
  const servers = stunServerUrls.map((url) => ({ urls: url }));
  const turnServerUrls = urls(turnUrls, "TURN");

  if (turnServerUrls.length > 0) {
    if (!turnServerUrls.every((url) => /^(turn|turns):/i.test(url))) {
      throw new Error("TURN_SERVER_URLS may contain only turn: or turns: URLs");
    }
    if (!turnUsername || !turnCredential) {
      throw new Error("TURN_SERVER_USERNAME and TURN_SERVER_CREDENTIAL are required when TURN_SERVER_URLS is set");
    }
    servers.push({
      urls: turnServerUrls,
      username: turnUsername,
      credential: turnCredential
    });
  } else if (turnUsername || turnCredential) {
    throw new Error("TURN_SERVER_URLS is required when TURN credentials are set");
  }

  if (servers.length === 0) {
    throw new Error("At least one STUN or TURN server must be configured");
  }
  return servers;
}

function createSocketServer({
  allowedOrigins = parseAllowedOrigins(),
  apiBaseUrl = getApiBaseUrl(),
  iceServers = getIceServers(),
  fetchImpl = globalThis.fetch,
  groupCallRingMs = GROUP_CALL_RING_MS,
  messageAccessCacheMs = 30_000,
  // Shared with the Laravel API (SOCKET_INTERNAL_SECRET there). Without it the
  // internal events endpoint is disabled.
  internalEventsSecret = process.env.INTERNAL_EVENTS_SECRET || ""
} = {}) {
  const messageAccessCache = new Map();
  const originSet = new Set(allowedOrigins);
  const connectedUsers = new Map();
  const calls = new Map();
  const callsByUser = new Map();
  const groupCallsByConversation = new Map();
  const httpServer = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;

    if (request.method === "GET" && pathname === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "POST" && pathname === "/internal/events") {
      handleInternalEvents(request, response);
      return;
    }

    response.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  const io = new Server(httpServer, {
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, !origin || originSet.has(origin));
    },
    cors: {
      origin(origin, callback) {
        if (!origin || originSet.has(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error("Origin not allowed"));
      },
      methods: ["GET", "POST"]
    }
  });

  // The Laravel API posts events here the moment something changes (a message is
  // sent, edited, pinned or read, a chat or friendship changes), so every app gets
  // them instantly no matter which app made the change. Only the API knows the
  // shared secret; events are delivered to the listed users' rooms.
  function sendJson(response, status, body) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify(body));
  }

  function internalRequestAuthorized(request) {
    if (!internalEventsSecret) return false;
    const header = String(request.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${internalEventsSecret}`);
    const received = Buffer.from(header);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  function handleInternalEvents(request, response) {
    if (!internalRequestAuthorized(request)) {
      request.resume();
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > INTERNAL_EVENTS_MAX_BYTES) {
        sendJson(response, 413, { error: "Payload too large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(response, 400, { error: "Invalid JSON" });
        return;
      }

      const events = Array.isArray(body?.events) ? body.events : null;
      const valid = events && events.length <= 100 && events.every((item) =>
        typeof item?.event === "string" && INTERNAL_EVENT_NAME.test(item.event) &&
        Array.isArray(item.user_ids) && item.user_ids.length <= 1000 &&
        item.user_ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
        item.payload && typeof item.payload === "object" && !Array.isArray(item.payload));
      if (!valid) {
        sendJson(response, 422, { error: "Invalid events" });
        return;
      }

      let delivered = 0;
      for (const item of events) {
        for (const userId of new Set(item.user_ids)) {
          io.to(`user:${userId}`).emit(item.event, item.payload);
          delivered += 1;
        }
      }
      sendJson(response, 202, { delivered });
    });
  }

  async function apiGet(path, token) {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const error = new Error(`Laravel API rejected socket request (${response.status})`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  // Group calls use a full mesh: every participant holds one WebRTC connection
  // to every other participant, and this server only relays signalling.
  function groupCallSummary(call) {
    return {
      call_id: call.id,
      conversation_id: call.conversationId,
      caller_id: call.callerUserId,
      media_type: call.mediaType,
      call_status: call.connectedAt ? "completed" : "missed",
      duration_seconds: call.connectedAt
        ? Math.floor((Date.now() - call.connectedAt) / 1000)
        : 0
    };
  }

  function endGroupCall(call) {
    if (call.ended) return;
    call.ended = true;
    clearTimeout(call.timeout);
    calls.delete(call.id);
    if (groupCallsByConversation.get(call.conversationId) === call.id) {
      groupCallsByConversation.delete(call.conversationId);
    }
    for (const participantId of call.participants.keys()) {
      if (callsByUser.get(participantId) === call.id) callsByUser.delete(participantId);
    }
    const summary = groupCallSummary(call);
    for (const memberId of call.memberIds) {
      io.to(`user:${memberId}`).emit("group-call:ended", summary);
    }
  }

  function leaveGroupCall(call, userId) {
    if (call.ended || !call.participants.delete(userId)) return;
    if (callsByUser.get(userId) === call.id) callsByUser.delete(userId);

    // A call that has connected ends once one person is left alone in it; a call
    // that is still ringing ends when its last participant (the starter) leaves.
    if (call.participants.size === 0 || (call.connectedAt && call.participants.size < 2)) {
      endGroupCall(call);
      return;
    }
    for (const participant of call.participants.values()) {
      io.to(participant.socketId).emit("group-call:participant-left", {
        call_id: call.id,
        user_id: userId
      });
    }
  }

  function joinGroupCall(call, socket) {
    const { id: userId, name } = socket.data.user;
    const existing = call.participants.get(userId);

    if (existing) {
      if (existing.socketId !== socket.id) {
        socket.emit("group-call:error", {
          call_id: call.id,
          message: "You are already in this call on another device."
        });
      }
      return;
    }
    if (callsByUser.has(userId)) {
      socket.emit("group-call:error", {
        call_id: call.id,
        message: "Finish your current call before joining another."
      });
      return;
    }
    if (call.participants.size >= MAX_GROUP_CALL_PARTICIPANTS) {
      socket.emit("group-call:error", {
        call_id: call.id,
        message: `This call is full (${MAX_GROUP_CALL_PARTICIPANTS} people maximum).`
      });
      return;
    }

    const others = [...call.participants].map(([participantId, participant]) => ({
      user_id: participantId,
      name: participant.name
    }));
    call.participants.set(userId, { socketId: socket.id, name });
    callsByUser.set(userId, call.id);
    if (call.participants.size >= 2) call.connectedAt ||= Date.now();

    socket.emit("group-call:joined", {
      call_id: call.id,
      conversation_id: call.conversationId,
      caller_id: call.callerUserId,
      media_type: call.mediaType,
      participants: others
    });
    for (const [participantId, participant] of call.participants) {
      if (participantId === userId) continue;
      io.to(participant.socketId).emit("group-call:participant-joined", {
        call_id: call.id,
        user_id: userId,
        name
      });
    }
    // Stop the invite ringing on this user's other devices.
    socket.to(`user:${userId}`).emit("group-call:dismissed", { call_id: call.id });
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || token.length < 20 || token.length > 512) {
      next(new Error("Authentication required"));
      return;
    }

    try {
      const [user, friendResponse] = await Promise.all([
        apiGet("/auth/socket-identity", token),
        apiGet("/friends", token)
      ]);
      const userId = Number(user.id);
      const friends = friendResponse.data;

      if (!Number.isSafeInteger(userId) || !Array.isArray(friends)) {
        throw new Error("Laravel returned an invalid socket identity or friend list");
      }

      socket.data.user = {
        id: userId,
        name: user.name
      };
      socket.data.friendIds = friends
        .map((friend) => Number(friend.id))
        .filter((friendId) => Number.isSafeInteger(friendId) && friendId !== userId);
      next();
    } catch (error) {
      if (error.status === 401) {
        next(new Error("Authentication failed"));
        return;
      }

      console.error("Socket authentication failed:", error.message);
      next(new Error("Unable to authenticate with the Laravel API"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId } = socket.data.user;
    const userRoom = `user:${userId}`;
    const userSockets = connectedUsers.get(userId) || new Set();
    const becameOnline = userSockets.size === 0;
    const typingTimers = new Map();
    socket.data.callingEnabled = false;
    socket.data.groupCallsEnabled = false;

    function finishCall(call, event, payload = {}) {
      removeCall(call);
      // A call that ends before it was answered (including one the caller
      // cancelled while it rang) is a missed call for the person called.
      const callStatus = ["call:timeout", "call:rejected", "call:unavailable"].includes(event)
        ? "missed"
        : event === "call:ended"
          ? (call.acceptedSocketId ? "completed" : "missed")
          : null;
      const summary = callStatus ? {
        conversation_id: call.conversationId,
        caller_id: call.callerUserId,
        media_type: call.mediaType,
        call_status: callStatus,
        duration_seconds: call.connectedAt
          ? Math.floor((Date.now() - call.connectedAt) / 1000)
          : 0
      } : {};
      const eventPayload = { call_id: call.id, ...summary, ...payload };
      io.to(`user:${call.callerUserId}`).emit(event, eventPayload);
      io.to(`user:${call.targetUserId}`).emit(event, eventPayload);
    }

    function removeCall(call) {
      clearTimeout(call.timeout);
      calls.delete(call.id);
      if (callsByUser.get(call.callerUserId) === call.id) {
        callsByUser.delete(call.callerUserId);
      }
      if (callsByUser.get(call.targetUserId) === call.id) {
        callsByUser.delete(call.targetUserId);
      }
    }

    function validCallId(value) {
      return typeof value === "string" && /^[a-zA-Z0-9-]{16,64}$/.test(value);
    }

    function getCall(callId) {
      const call = validCallId(callId) ? calls.get(callId) : undefined;
      return call?.type === "group" ? undefined : call;
    }

    function getGroupCall(callId) {
      const call = validCallId(callId) ? calls.get(callId) : undefined;
      return call?.type === "group" && !call.ended ? call : undefined;
    }

    async function groupMemberIds(conversationId) {
      const access = await apiGet(`/conversations/${conversationId}/socket-access`, socket.handshake.auth.token);
      const memberIds = Array.isArray(access.participant_ids)
        ? access.participant_ids.map(Number)
        : [];
      if (Number(access.conversation_id) !== conversationId ||
        access.peer_id !== null ||
        !memberIds.includes(userId) ||
        memberIds.some((memberId) => !Number.isSafeInteger(memberId) || memberId < 1)) {
        return null;
      }
      return new Set(memberIds);
    }

    function groupCallAuthorizationFailed(error, callId) {
      if (error.status === 401) {
        socket.emit("server:error", { message: "Your session has expired. Sign in again." });
        socket.disconnect(true);
        return;
      }
      if (error.status === 403 || error.status === 404) {
        socket.emit("group-call:error", { call_id: callId, message: "You do not have access to this group." });
        return;
      }
      console.error("Group call authorization failed:", error.message);
      socket.emit("group-call:error", { call_id: callId, message: "Could not authorize this call." });
    }

    userSockets.add(socket.id);
    connectedUsers.set(userId, userSockets);
    socket.join(userRoom);

    socket.emit("presence:sync", socket.data.friendIds.map((friendId) => ({
      user_id: friendId,
      is_online: (connectedUsers.get(friendId)?.size || 0) > 0
    })));

    if (becameOnline) {
      for (const friendId of socket.data.friendIds) {
        io.to(`user:${friendId}`).emit("presence:update", {
          user_id: userId,
          is_online: true
        });
      }
    }

    function stopTyping(conversationId) {
      const timeout = typingTimers.get(conversationId);
      if (timeout) {
        clearTimeout(timeout);
        typingTimers.delete(conversationId);
      }

      if (socket.rooms.has(`conversation:${conversationId}`)) {
        socket.to(`conversation:${conversationId}`).emit("conversation:stop-typing", {
          conversation_id: conversationId,
          user_id: userId
        });
      }
    }

    socket.on("client:ping", () => {
      socket.emit("server:pong", { timestamp: new Date().toISOString() });
    });

    socket.on("conversation:join", async (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
        socket.emit("server:error", { message: "Invalid conversation." });
        return;
      }

      try {
        const access = await apiGet(`/conversations/${conversationId}/socket-access`, socket.handshake.auth.token);

        if (Number(access.conversation_id) !== conversationId) {
          socket.emit("server:error", { message: "Conversation access denied." });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        socket.emit("conversation:joined", { conversation_id: conversationId });
      } catch (error) {
        if (error.status === 401) {
          socket.emit("server:error", { message: "Your session has expired. Sign in again." });
          socket.disconnect(true);
          return;
        }

        if (error.status === 404 || error.status === 403) {
          socket.emit("server:error", { message: "You do not have access to this conversation." });
          return;
        }

        console.error("Conversation authorization failed:", error.message);
        socket.emit("server:error", { message: "Could not authorize the conversation." });
      }
    });

    socket.on("conversation:leave", (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (Number.isSafeInteger(conversationId) && conversationId > 0) {
        stopTyping(conversationId);
        socket.leave(`conversation:${conversationId}`);
      }
    });

    // Every message notification needs the conversation's participants, and
    // asking Laravel each time adds a full API round trip to delivery. The
    // answer is cached briefly per sender; recipients still load the message
    // itself through the API, which authorizes them independently.
    async function messageParticipantIds(conversationId) {
      const cacheKey = `${userId}:${conversationId}`;
      const cached = messageAccessCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.participantIds;

      const access = await apiGet(`/conversations/${conversationId}/socket-access`, socket.handshake.auth.token);
      const participantIds = Array.isArray(access.participant_ids)
        ? access.participant_ids.map(Number)
        : [Number(access.peer_id), userId];
      if (Number(access.conversation_id) !== conversationId ||
        !participantIds.includes(userId) ||
        participantIds.some((participantId) => !Number.isSafeInteger(participantId) || participantId < 1)) {
        messageAccessCache.delete(cacheKey);
        return null;
      }

      const uniqueIds = [...new Set(participantIds)];
      if (messageAccessCache.size >= 10_000) messageAccessCache.clear();
      messageAccessCache.set(cacheKey, { participantIds: uniqueIds, expiresAt: Date.now() + messageAccessCacheMs });
      return uniqueIds;
    }

    socket.on("conversation:message", async (payload) => {
      const conversationId = Number(payload?.conversation_id);
      const messageId = Number(payload?.message_id);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1 ||
        !Number.isSafeInteger(messageId) || messageId < 1) return;

      try {
        const participantIds = await messageParticipantIds(conversationId);
        if (!participantIds) return;

        for (const participantId of participantIds) {
          io.to(`user:${participantId}`).emit("conversation:message", {
            conversation_id: conversationId,
            message_id: messageId
          });
        }
      } catch (error) {
        if (error.status === 401) {
          socket.emit("server:error", { message: "Your session has expired. Sign in again." });
          socket.disconnect(true);
          return;
        }
        if (error.status !== 404 && error.status !== 403) {
          console.error("Message notification authorization failed:", error.message);
        }
      }
    });

    // Someone read a conversation: tell its members so read ticks and "seen by"
    // avatars update immediately. Apps reload the details through the API.
    socket.on("conversation:read", async (payload) => {
      const conversationId = Number(payload?.conversation_id);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1) return;

      try {
        const participantIds = await messageParticipantIds(conversationId);
        if (!participantIds) return;
        for (const participantId of participantIds) {
          io.to(`user:${participantId}`).emit("conversation:read", {
            conversation_id: conversationId,
            user_id: userId
          });
        }
      } catch (error) {
        if (error.status === 401) {
          socket.emit("server:error", { message: "Your session has expired. Sign in again." });
          socket.disconnect(true);
          return;
        }
        if (error.status !== 404 && error.status !== 403) {
          console.error("Read notification authorization failed:", error.message);
        }
      }
    });

    socket.on("conversation:typing", (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (!Number.isSafeInteger(conversationId) || !socket.rooms.has(`conversation:${conversationId}`)) {
        return;
      }

      socket.to(`conversation:${conversationId}`).emit("conversation:typing", {
        conversation_id: conversationId,
        user_id: userId,
        name: socket.data.user.name
      });
      clearTimeout(typingTimers.get(conversationId));
      typingTimers.set(conversationId, setTimeout(() => stopTyping(conversationId), 4000));
    });

    socket.on("conversation:stop-typing", (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (!Number.isSafeInteger(conversationId) || !socket.rooms.has(`conversation:${conversationId}`)) {
        return;
      }

      stopTyping(conversationId);
    });

    socket.on("call:ready", (payload) => {
      socket.data.callingEnabled = payload?.enabled === true;
      socket.data.groupCallsEnabled = socket.data.callingEnabled && payload?.group_calls === true;
      if (socket.data.callingEnabled) {
        socket.emit("call:config", { ice_servers: iceServers });
      }
    });

    socket.on("call:invite", async (payload) => {
      const callId = payload?.call_id;
      const conversationId = Number(payload?.conversation_id);
      const targetUserId = Number(payload?.target_user_id);
      const mediaType = payload?.media_type;

      if (
        !validCallId(callId) ||
        calls.has(callId) ||
        !Number.isSafeInteger(conversationId) ||
        conversationId < 1 ||
        !Number.isSafeInteger(targetUserId) ||
        targetUserId < 1 ||
        targetUserId === userId ||
        !socket.data.friendIds.includes(targetUserId) ||
        !["audio", "video"].includes(mediaType) ||
        !socket.rooms.has(`conversation:${conversationId}`)
      ) {
        socket.emit("call:error", { call_id: callId, message: "This call could not be started." });
        return;
      }

      if (callsByUser.has(userId) || callsByUser.has(targetUserId)) {
        socket.emit("call:busy", { call_id: callId, user_id: targetUserId });
        return;
      }

      const call = {
        id: callId,
        conversationId,
        callerUserId: userId,
        callerSocketId: socket.id,
        targetUserId,
        mediaType,
        targetSocketIds: new Set(),
        acceptedSocketId: null,
        connectedAt: null,
        timeout: null
      };
      calls.set(callId, call);
      callsByUser.set(userId, callId);
      callsByUser.set(targetUserId, callId);

      try {
        const access = await apiGet(`/conversations/${conversationId}/socket-access`, socket.handshake.auth.token);
        if (Number(access.conversation_id) !== conversationId ||
          Number(access.peer_id) !== targetUserId) {
          removeCall(call);
          socket.emit("call:error", { call_id: callId, message: "Conversation access denied." });
          return;
        }
      } catch (error) {
        removeCall(call);
        if (error.status === 401) {
          socket.emit("server:error", { message: "Your session has expired. Sign in again." });
          socket.disconnect(true);
          return;
        }
        if (error.status === 403 || error.status === 404) {
          socket.emit("call:error", { call_id: callId, message: "You do not have access to this conversation." });
          return;
        }
        console.error("Call authorization failed:", error.message);
        socket.emit("call:error", { call_id: callId, message: "Could not authorize this call." });
        return;
      }

      if (calls.get(callId) !== call) return;
      let targetSockets;
      try {
        targetSockets = await io.in(`user:${targetUserId}`).fetchSockets();
      } catch (error) {
        removeCall(call);
        console.error("Call recipient lookup failed:", error.message);
        socket.emit("call:error", { call_id: callId, message: "Could not reach your friend for this call." });
        return;
      }
      if (calls.get(callId) !== call) return;
      const availableSockets = targetSockets.filter((targetSocket) => targetSocket.data.callingEnabled);
      if (availableSockets.length === 0) {
        finishCall(call, "call:unavailable", { user_id: targetUserId });
        return;
      }

      call.targetSocketIds = new Set(availableSockets.map((targetSocket) => targetSocket.id));
      call.timeout = setTimeout(() => {
        finishCall(call, "call:timeout");
      }, 30_000);

      for (const targetSocket of availableSockets) {
        targetSocket.emit("call:invite", {
          call_id: callId,
          conversation_id: conversationId,
          caller_id: userId,
          caller_name: socket.data.user.name,
          media_type: mediaType
        });
      }
    });

    socket.on("call:accept", (payload) => {
      const call = getCall(payload?.call_id);
      if (!call || call.targetUserId !== userId ||
        !call.targetSocketIds.has(socket.id) || call.acceptedSocketId) return;

      clearTimeout(call.timeout);
      call.timeout = null;
      call.acceptedSocketId = socket.id;
      io.to(call.callerSocketId).emit("call:accepted", { call_id: call.id });
      for (const targetSocketId of call.targetSocketIds) {
        if (targetSocketId !== socket.id) {
          io.to(targetSocketId).emit("call:answered-elsewhere", { call_id: call.id });
        }
      }
    });

    socket.on("call:connected", (payload) => {
      const call = getCall(payload?.call_id);
      if (!call || !call.acceptedSocketId ||
        (call.callerSocketId !== socket.id && call.acceptedSocketId !== socket.id)) return;
      call.connectedAt ||= Date.now();
    });

    socket.on("call:reject", (payload) => {
      const call = getCall(payload?.call_id);
      if (!call || call.targetUserId !== userId ||
        !call.targetSocketIds.has(socket.id) || call.acceptedSocketId) return;
      finishCall(call, "call:rejected");
    });

    socket.on("call:cancel", (payload) => {
      const call = getCall(payload?.call_id);
      if (!call || call.callerSocketId !== socket.id || call.acceptedSocketId) return;
      finishCall(call, "call:ended");
    });

    socket.on("call:end", (payload) => {
      const call = getCall(payload?.call_id);
      if (!call || (call.callerSocketId !== socket.id && call.acceptedSocketId !== socket.id)) return;
      finishCall(call, "call:ended");
    });

    socket.on("call:signal", (payload) => {
      const call = getCall(payload?.call_id);
      const signal = payload?.signal;
      const isCaller = call?.callerSocketId === socket.id;
      const isAcceptedTarget = call?.acceptedSocketId === socket.id;

      if (!call || !call.acceptedSocketId || (!isCaller && !isAcceptedTarget) ||
        !signal || typeof signal !== "object" || Array.isArray(signal)) return;

      let serialized;
      try {
        serialized = JSON.stringify(signal);
      } catch {
        return;
      }
      if (serialized.length > 64_000) return;

      const destination = isCaller ? call.acceptedSocketId : call.callerSocketId;
      io.to(destination).emit("call:signal", { call_id: call.id, signal });
    });

    socket.on("group-call:start", async (payload) => {
      const callId = payload?.call_id;
      const conversationId = Number(payload?.conversation_id);
      const mediaType = payload?.media_type;

      if (!validCallId(callId) || calls.has(callId) ||
        !Number.isSafeInteger(conversationId) || conversationId < 1 ||
        !["audio", "video"].includes(mediaType) || !socket.data.groupCallsEnabled) {
        socket.emit("group-call:error", { call_id: callId, message: "This call could not be started." });
        return;
      }

      let memberIds;
      try {
        memberIds = await groupMemberIds(conversationId);
      } catch (error) {
        groupCallAuthorizationFailed(error, callId);
        return;
      }
      if (!memberIds) {
        socket.emit("group-call:error", { call_id: callId, message: "Group calls are only available in group chats." });
        return;
      }
      if (!socket.connected) return;

      // Starting a call in a group that already has one joins the running call.
      const runningCall = getGroupCall(groupCallsByConversation.get(conversationId));
      if (runningCall) {
        joinGroupCall(runningCall, socket);
        return;
      }
      if (callsByUser.has(userId) || calls.has(callId)) {
        socket.emit("group-call:error", { call_id: callId, message: "Finish your current call before starting another." });
        return;
      }

      const call = {
        id: callId,
        type: "group",
        conversationId,
        callerUserId: userId,
        mediaType,
        memberIds,
        participants: new Map(),
        connectedAt: null,
        timeout: null,
        ended: false
      };
      calls.set(callId, call);
      groupCallsByConversation.set(conversationId, callId);
      joinGroupCall(call, socket);

      call.timeout = setTimeout(() => {
        if (call.ended) return;
        if (!call.connectedAt) {
          endGroupCall(call);
          return;
        }
        // The call is under way; stop ringing members who never answered.
        for (const memberId of call.memberIds) {
          if (!call.participants.has(memberId)) {
            io.to(`user:${memberId}`).emit("group-call:dismissed", { call_id: call.id });
          }
        }
      }, groupCallRingMs);

      const inviteeIds = [...memberIds].filter((memberId) => memberId !== userId && !callsByUser.has(memberId));
      let inviteeSockets;
      try {
        inviteeSockets = (await Promise.all(
          inviteeIds.map((memberId) => io.in(`user:${memberId}`).fetchSockets())
        )).flat();
      } catch (error) {
        console.error("Group call recipient lookup failed:", error.message);
        return;
      }
      if (call.ended) return;

      for (const inviteeSocket of inviteeSockets) {
        if (!inviteeSocket.data.groupCallsEnabled ||
          call.participants.has(inviteeSocket.data.user.id)) continue;
        inviteeSocket.emit("group-call:invite", {
          call_id: call.id,
          conversation_id: conversationId,
          caller_id: userId,
          caller_name: socket.data.user.name,
          media_type: mediaType
        });
      }
    });

    socket.on("group-call:join", async (payload) => {
      const call = getGroupCall(payload?.call_id);
      if (!call || !call.memberIds.has(userId) || !socket.data.groupCallsEnabled) {
        socket.emit("group-call:error", { call_id: payload?.call_id, message: "This call has already ended." });
        return;
      }

      let memberIds;
      try {
        memberIds = await groupMemberIds(call.conversationId);
      } catch (error) {
        groupCallAuthorizationFailed(error, call.id);
        return;
      }
      if (!memberIds) {
        socket.emit("group-call:error", { call_id: call.id, message: "You are no longer a member of this group." });
        return;
      }
      if (call.ended) {
        socket.emit("group-call:error", { call_id: call.id, message: "This call has already ended." });
        return;
      }
      if (!socket.connected) return;
      joinGroupCall(call, socket);
    });

    socket.on("group-call:decline", (payload) => {
      const call = getGroupCall(payload?.call_id);
      if (!call || !call.memberIds.has(userId) || call.participants.has(userId)) return;
      io.to(userRoom).emit("group-call:dismissed", { call_id: call.id });
    });

    socket.on("group-call:leave", (payload) => {
      const call = getGroupCall(payload?.call_id);
      if (!call || call.participants.get(userId)?.socketId !== socket.id) return;
      leaveGroupCall(call, userId);
    });

    socket.on("group-call:signal", (payload) => {
      const call = getGroupCall(payload?.call_id);
      const targetUserId = Number(payload?.to_user_id);
      const signal = payload?.signal;
      if (!call || call.participants.get(userId)?.socketId !== socket.id ||
        targetUserId === userId || !call.participants.has(targetUserId) ||
        !signal || typeof signal !== "object" || Array.isArray(signal)) return;

      let serialized;
      try {
        serialized = JSON.stringify(signal);
      } catch {
        return;
      }
      if (serialized.length > 64_000) return;

      io.to(call.participants.get(targetUserId).socketId).emit("group-call:signal", {
        call_id: call.id,
        from_user_id: userId,
        signal
      });
    });

    socket.on("disconnecting", () => {
      for (const conversationId of typingTimers.keys()) {
        stopTyping(conversationId);
      }
    });

    socket.on("disconnect", () => {
      for (const callId of new Set([callsByUser.get(userId)])) {
        const call = calls.get(callId);
        if (!call) continue;

        if (call.type === "group") {
          if (call.participants.get(userId)?.socketId === socket.id) leaveGroupCall(call, userId);
        } else if (call.acceptedSocketId &&
          (call.callerSocketId === socket.id || call.acceptedSocketId === socket.id)) {
          finishCall(call, "call:ended");
        } else if (call.callerSocketId === socket.id) {
          finishCall(call, "call:timeout");
        } else {
          call.targetSocketIds.delete(socket.id);
          if (call.targetSocketIds.size === 0 && !call.acceptedSocketId) {
            finishCall(call, "call:unavailable");
          }
        }
      }

      const sockets = connectedUsers.get(userId);

      if (!sockets) {
        return;
      }

      sockets.delete(socket.id);
      if (sockets.size === 0) {
        connectedUsers.delete(userId);
        for (const friendId of socket.data.friendIds) {
          io.to(`user:${friendId}`).emit("presence:update", {
            user_id: userId,
            is_online: false
          });
        }
      }
    });
  });

  return { httpServer, io, connectedUsers };
}

function parsePort(value = process.env.PORT || "3001") {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return port;
}

async function startServer() {
  const { httpServer, io } = createSocketServer();
  const port = parsePort();
  const host = process.env.HOST || "0.0.0.0";

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  console.info(`Socket server listening on ${host}:${address.port}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      io.close(() => process.exit(0));
    });
  }
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start socket server:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  createSocketServer,
  getApiBaseUrl,
  getIceServers,
  parseAllowedOrigins,
  parsePort,
  startServer
};
