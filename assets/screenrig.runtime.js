"use strict";
(() => {
  // src/protocol.ts
  var PROTOCOL = "1";
  var PARENT_HANDSHAKE_PROTOCOL = "screenrig.parent-handshake/1";
  var DEFAULT_PLAYER_ORIGIN = "https://play.screenrig.ai";
  var MAX_MESSAGE_BYTES = 65536;
  var MAX_LOG_MESSAGE_BYTES = 2048;
  var MAX_CLIENT_LOGS = 32;
  var MESSAGE_KINDS = [
    "context",
    "ready",
    "log",
    "event.emit",
    "page.advance",
    "viewport.changed",
    "kv.get",
    "kv.list",
    "kv.set",
    "kv.delete",
    "response.ack",
    "response.problem"
  ];
  var EMPTY_CAPABILITIES = {
    "page.advance": false,
    "kv.read": false,
    "kv.write": false
  };

  // src/validate.ts
  var SdkValidationError = class extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.name = "SdkValidationError";
      this.code = code;
    }
  };
  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function utf8Bytes(value) {
    return new TextEncoder().encode(value).length;
  }
  function serializedSize(value) {
    try {
      return utf8Bytes(JSON.stringify(value));
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  var ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
  var PRIMITIVE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
  var NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
  function isOpaqueOrigin(origin) {
    if (origin === "null") return true;
    try {
      return new URL(origin).origin === "null";
    } catch {
      return false;
    }
  }
  function isParentHandshakeCandidate(data) {
    return isRecord(data) && data.protocol === PARENT_HANDSHAKE_PROTOCOL && data.kind === "parent.handshake";
  }
  function parseParentHandshakeOffer(data) {
    if (!isRecord(data) || serializedSize(data) > MAX_MESSAGE_BYTES) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake must be a bounded object");
    }
    if (!hasExactKeys(data, ["protocol", "kind", "challenge"])) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake has an invalid shape");
    }
    if (data.protocol !== PARENT_HANDSHAKE_PROTOCOL || data.kind !== "parent.handshake" || typeof data.challenge !== "string" || !NONCE_RE.test(data.challenge)) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake is invalid");
    }
    return { protocol: PARENT_HANDSHAKE_PROTOCOL, kind: "parent.handshake", challenge: data.challenge };
  }
  function hasExactKeys(value, keys) {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }
  function isAllowedKind(kind) {
    return MESSAGE_KINDS.includes(kind);
  }
  function parseMessage(data) {
    if (typeof data === "string") {
      if (utf8Bytes(data) > MAX_MESSAGE_BYTES) {
        throw new SdkValidationError("message_too_large", "Message exceeds size limit");
      }
      try {
        data = JSON.parse(data);
      } catch {
        throw new SdkValidationError("invalid_json", "Message is not valid JSON");
      }
    }
    if (!isRecord(data)) {
      throw new SdkValidationError("invalid_shape", "Message must be an object");
    }
    if (Object.prototype.hasOwnProperty.call(data, "__proto__") || Object.prototype.hasOwnProperty.call(data, "constructor")) {
      throw new SdkValidationError("invalid_shape", "Message contains forbidden keys");
    }
    if (serializedSize(data) > MAX_MESSAGE_BYTES) {
      throw new SdkValidationError("message_too_large", "Message exceeds size limit");
    }
    const protocol = data.protocol;
    const message_id = data.message_id;
    const kind = data.kind;
    const primitive_id = data.primitive_id;
    const payload = data.payload;
    if (protocol !== PROTOCOL) {
      throw new SdkValidationError("protocol_mismatch", "Unsupported protocol");
    }
    if (typeof message_id !== "string" || !ID_RE.test(message_id)) {
      throw new SdkValidationError("invalid_message_id", "Invalid message_id");
    }
    if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) {
      throw new SdkValidationError("invalid_kind", "Invalid kind");
    }
    if (typeof primitive_id !== "string" || !PRIMITIVE_ID_RE.test(primitive_id)) {
      throw new SdkValidationError("invalid_primitive", "Invalid primitive_id");
    }
    if (!isRecord(payload)) {
      throw new SdkValidationError("invalid_payload", "payload must be an object");
    }
    const allowed = /* @__PURE__ */ new Set(["protocol", "message_id", "kind", "primitive_id", "payload"]);
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) {
        throw new SdkValidationError("invalid_shape", `Unexpected field ${key}`);
      }
    }
    return { protocol, message_id, kind, primitive_id, payload };
  }
  function parseSize(value, name) {
    if (!isRecord(value)) {
      throw new SdkValidationError("invalid_context", `${name} must be an object`);
    }
    const width = value.width;
    const height = value.height;
    if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new SdkValidationError("invalid_context", `${name} width/height must be finite numbers`);
    }
    if (width < 0 || height < 0 || width > 1e5 || height > 1e5) {
      throw new SdkValidationError("invalid_context", `${name} dimensions out of range`);
    }
    return { width, height };
  }
  function parseCapabilities(value) {
    if (!isRecord(value)) {
      throw new SdkValidationError("invalid_context", "capabilities must be an object");
    }
    return {
      "page.advance": value["page.advance"] === true,
      "kv.read": value["kv.read"] === true,
      "kv.write": value["kv.write"] === true
    };
  }
  function parseContextPayload(payload, expectedOrigin) {
    const application_id = payload.application_id;
    const release_id = payload.release_id;
    const primitive_id = payload.primitive_id;
    const generation = payload.generation;
    const nonce = payload.nonce;
    const player_origin = payload.player_origin;
    if (typeof application_id !== "string" || !ID_RE.test(application_id)) {
      throw new SdkValidationError("invalid_application", "Invalid application_id");
    }
    if (typeof release_id !== "string" || !ID_RE.test(release_id)) {
      throw new SdkValidationError("invalid_release", "Invalid release_id");
    }
    if (typeof primitive_id !== "string" || !PRIMITIVE_ID_RE.test(primitive_id)) {
      throw new SdkValidationError("invalid_primitive", "Invalid primitive_id");
    }
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
      throw new SdkValidationError("invalid_generation", "Invalid generation");
    }
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      throw new SdkValidationError("invalid_nonce", "Invalid nonce");
    }
    if (typeof player_origin !== "string" || player_origin !== expectedOrigin) {
      throw new SdkValidationError("invalid_player_origin", "player_origin does not match the trusted player origin");
    }
    if (player_origin === "*" || expectedOrigin === "*") {
      throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
    }
    return {
      application_id,
      release_id,
      primitive_id,
      generation,
      nonce,
      player_origin,
      capabilities: parseCapabilities(payload.capabilities),
      viewport: parseSize(payload.viewport, "viewport"),
      primitive: parseSize(payload.primitive, "primitive"),
      screen_id: typeof payload.screen_id === "string" && ID_RE.test(payload.screen_id) ? payload.screen_id : void 0
    };
  }
  function parseResponseAckPayload(payload) {
    const requestMessageId = payload.request_message_id;
    const generation = payload.generation;
    const nonce = payload.nonce;
    if (typeof requestMessageId !== "string" || !ID_RE.test(requestMessageId) || typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      throw new SdkValidationError("invalid_response", "Invalid response request_message_id");
    }
    return { request_message_id: requestMessageId, generation, nonce, result: payload.result };
  }
  function parseResponseProblemPayload(payload) {
    const requestMessageId = payload.request_message_id;
    const generation = payload.generation;
    const nonce = payload.nonce;
    const problem = payload.problem;
    if (typeof requestMessageId !== "string" || !ID_RE.test(requestMessageId) || typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce) || !isRecord(problem)) {
      throw new SdkValidationError("invalid_response", "Invalid problem response envelope");
    }
    if (typeof problem.code !== "string" || typeof problem.status !== "number" || !Number.isInteger(problem.status) || typeof problem.detail !== "string" || typeof problem.request_id !== "string") {
      throw new SdkValidationError("invalid_response", "Invalid problem response payload");
    }
    const currentRevision = problem.current_revision;
    if (currentRevision !== void 0 && (typeof currentRevision !== "number" || !Number.isInteger(currentRevision))) {
      throw new SdkValidationError("invalid_response", "Invalid problem current_revision");
    }
    return {
      request_message_id: requestMessageId,
      generation,
      nonce,
      problem: {
        code: problem.code,
        status: problem.status,
        detail: problem.detail,
        request_id: problem.request_id,
        ...currentRevision === void 0 ? {} : { current_revision: currentRevision }
      }
    };
  }
  function assertTrustedOrigin(origin, trusted) {
    if (!origin || origin === "*" || trusted.length === 0 || trusted.some((value) => !value || value === "*")) {
      throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
    }
    if (!trusted.includes(origin)) {
      throw new SdkValidationError("untrusted_origin", "Message origin is not the trusted player");
    }
  }
  function negotiateCapabilities(offered) {
    return {
      "page.advance": offered["page.advance"] === true,
      "kv.read": offered["kv.read"] === true,
      "kv.write": offered["kv.write"] === true
    };
  }

  // src/screenrig.ts
  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  function randomIdempotencyKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  function base64(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index] ?? 0;
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const word = first << 16 | (second ?? 0) << 8 | (third ?? 0);
      output += alphabet[word >>> 18 & 63] ?? "";
      output += alphabet[word >>> 12 & 63] ?? "";
      output += second === void 0 ? "=" : alphabet[word >>> 6 & 63] ?? "";
      output += third === void 0 ? "=" : alphabet[word & 63] ?? "";
    }
    return output;
  }
  var ScreenRigClient = class {
    constructor(options, allowOpaqueNativeParent = false, nativeParentOrigin) {
      this.nativeParentOrigin = nativeParentOrigin;
      this.host = options.host;
      this.trustedPlayerOrigins = options.trustedPlayerOrigins ?? [options.trustedPlayerOrigin ?? DEFAULT_PLAYER_ORIGIN];
      if (this.trustedPlayerOrigins.length === 0 || this.trustedPlayerOrigins.some((origin) => !origin || origin === "*")) {
        throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
      }
      this.idFactory = options.idFactory ?? randomId;
      this.ackTimeoutMs = options.ackTimeoutMs ?? 1e4;
      this.allowOpaqueNativeParent = allowOpaqueNativeParent;
      this.unsubscribe = this.host.addMessageListener((event) => this.onMessage(event));
    }
    readyState = "inert";
    context = null;
    capabilities = { ...EMPTY_CAPABILITIES };
    host;
    trustedPlayerOrigins;
    idFactory;
    ackTimeoutMs;
    allowOpaqueNativeParent;
    destroyed = false;
    activeWaiters = /* @__PURE__ */ new Set();
    pending = /* @__PURE__ */ new Map();
    resizeHandlers = /* @__PURE__ */ new Set();
    capabilityHandlers = /* @__PURE__ */ new Set();
    unsubscribe;
    advanced = false;
    reports = 0;
    parentOrigin = null;
    targetOrigin = null;
    handshakeChallenge = null;
    opaqueSourceBound = false;
    kv = {
      get: (key) => this.kvGet(key),
      list: () => this.kvList(),
      set: (key, value, options) => this.kvSet(key, value, options),
      delete: (key, expectedRevision, options) => this.kvDelete(key, expectedRevision, options)
    };
    destroy() {
      this.destroyed = true;
      this.unsubscribe();
      for (const waiter of this.activeWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new SdkValidationError("destroyed", "SDK was destroyed before activation"));
      }
      this.activeWaiters.clear();
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new SdkValidationError("destroyed", "SDK was destroyed before the parent acknowledged the request"));
      }
      this.pending.clear();
      this.readyState = "inert";
      this.context = null;
      this.parentOrigin = null;
      this.targetOrigin = null;
      this.handshakeChallenge = null;
      this.opaqueSourceBound = false;
    }
    onMessage(event) {
      try {
        if (event.source !== this.host.parent) {
          this.report("debug", "ignored_source", "Ignored message from non-parent source");
          return;
        }
        if (isParentHandshakeCandidate(event.data)) {
          this.acceptParentHandshake(event);
          return;
        }
        if (this.parentOrigin === null || event.origin !== this.parentOrigin) {
          this.report("debug", "unbound_parent", "Ignored message before a valid parent handshake");
          return;
        }
        const message = parseMessage(event.data);
        if (!isAllowedKind(message.kind)) {
          this.report("debug", "ignored_kind", "Ignored unknown message kind");
          return;
        }
        if (message.kind === "context") {
          this.acceptContext(message);
          return;
        }
        if (this.readyState !== "active" || !this.context) {
          this.report("debug", "inert", "Ignored message while SDK is inert");
          return;
        }
        if (message.primitive_id !== this.context.primitive_id) {
          this.report("debug", "stale_primitive", "Ignored message for another primitive");
          return;
        }
        if (message.kind === "response.ack" || message.kind === "response.problem") {
          if (message.kind === "response.problem") {
            const response = parseResponseProblemPayload(message.payload);
            if (!this.matchesRuntime(response.generation, response.nonce)) return;
            const waiter = this.pending.get(response.request_message_id);
            if (!waiter) return;
            this.pending.delete(response.request_message_id);
            clearTimeout(waiter.timer);
            const problem = response.problem;
            waiter.reject(new SdkValidationError(problem.code, `${problem.detail} (request_id: ${problem.request_id})`));
          } else {
            const response = parseResponseAckPayload(message.payload);
            if (!this.matchesRuntime(response.generation, response.nonce)) return;
            const waiter = this.pending.get(response.request_message_id);
            if (!waiter) return;
            this.pending.delete(response.request_message_id);
            clearTimeout(waiter.timer);
            waiter.resolve(response.result);
          }
          return;
        }
        if (message.kind === "viewport.changed") {
          if (!this.matchesRuntime(message.payload.generation, message.payload.nonce)) return;
          const viewport = message.payload.viewport;
          const primitive = message.payload.primitive;
          if (!viewport || !primitive) {
            return;
          }
          this.context = { ...this.context, viewport, primitive };
          for (const handler of this.resizeHandlers) {
            handler({ viewport, primitive });
          }
          return;
        }
      } catch (err) {
        if (err instanceof SdkValidationError && err.code === "wildcard_origin") {
          this.readyState = "failed";
        }
        this.report("debug", "ignored_invalid", "Ignored invalid parent message");
      }
    }
    acceptParentHandshake(event) {
      const offer = parseParentHandshakeOffer(event.data);
      if (this.handshakeChallenge !== null) {
        return;
      }
      const opaque = isOpaqueOrigin(event.origin);
      if (event.origin === this.nativeParentOrigin) {
      } else if (opaque) {
        if (!this.allowOpaqueNativeParent) {
          throw new SdkValidationError("untrusted_origin", "Opaque parent is not allowed for this application origin");
        }
      } else {
        assertTrustedOrigin(event.origin, this.trustedPlayerOrigins);
      }
      this.parentOrigin = event.origin;
      this.targetOrigin = opaque ? "*" : event.origin;
      this.handshakeChallenge = offer.challenge;
      this.opaqueSourceBound = opaque;
      this.host.postToParent(
        {
          protocol: PARENT_HANDSHAKE_PROTOCOL,
          kind: "child.handshake",
          challenge: offer.challenge,
          parent_origin: event.origin
        },
        this.targetOrigin,
        this.opaqueSourceBound
      );
    }
    acceptContext(message) {
      if (this.parentOrigin === null || this.handshakeChallenge === null) {
        throw new SdkValidationError("invalid_handshake", "Context arrived before the parent handshake");
      }
      const context = parseContextPayload(message.payload, this.parentOrigin);
      if (context.nonce !== this.handshakeChallenge) {
        throw new SdkValidationError("invalid_nonce", "Context nonce does not match the parent challenge");
      }
      if (message.primitive_id !== context.primitive_id) {
        throw new SdkValidationError("invalid_primitive", "Envelope primitive_id does not match payload");
      }
      this.context = context;
      this.capabilities = negotiateCapabilities(context.capabilities);
      this.readyState = "active";
      for (const waiter of this.activeWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.activeWaiters.clear();
      this.advanced = false;
      for (const handler of this.capabilityHandlers) {
        handler(this.capabilities);
      }
    }
    post(message, wait) {
      if (this.targetOrigin === null || this.handshakeChallenge === null) {
        throw new SdkValidationError("inert", "SDK has not bound a parent handshake");
      }
      if (!wait) {
        this.host.postToParent(message, this.targetOrigin, this.opaqueSourceBound);
        return Promise.resolve(void 0);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(message.message_id);
          reject(new SdkValidationError("ack_timeout", `Parent did not acknowledge ${message.kind}`));
        }, this.ackTimeoutMs);
        this.pending.set(message.message_id, { resolve, reject, timer });
        try {
          this.host.postToParent(message, this.targetOrigin, this.opaqueSourceBound);
        } catch (err) {
          clearTimeout(timer);
          this.pending.delete(message.message_id);
          reject(err);
        }
      });
    }
    matchesRuntime(generation, nonce) {
      return this.context !== null && generation === this.context.generation && nonce === this.context.nonce;
    }
    report(level, code, message) {
      this.reports += 1;
      if (this.reports > MAX_CLIENT_LOGS || this.readyState === "inert") {
        return;
      }
      try {
        this.log({ level, code, message });
      } catch {
      }
    }
    requireActive() {
      if (this.readyState !== "active" || !this.context) {
        throw new SdkValidationError("inert", "SDK is inert until it validates the parent challenge and matching context");
      }
      return this.context;
    }
    /** Wait for the authenticated parent context, without declaring the app rendered. */
    waitUntilActive(timeoutMs = 1e4) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3e5) {
        return Promise.reject(new SdkValidationError("invalid_timeout", "Activation timeout must be between 1 and 300000 milliseconds"));
      }
      if (this.destroyed) return Promise.reject(new SdkValidationError("destroyed", "SDK was destroyed"));
      if (this.readyState === "active") return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: setTimeout(() => {
          this.activeWaiters.delete(waiter);
          reject(new SdkValidationError("activation_timeout", "Parent context did not become active"));
        }, timeoutMs) };
        this.activeWaiters.add(waiter);
      });
    }
    async ready() {
      const context = this.requireActive();
      await this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "ready",
          primitive_id: context.primitive_id,
          payload: { generation: context.generation, nonce: context.nonce }
        },
        true
      );
    }
    log(entry) {
      const context = this.requireActive();
      const level = entry.level;
      if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
        throw new SdkValidationError("invalid_log", "Invalid log level");
      }
      const code = entry.code.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
      const message = entry.message.slice(0, MAX_LOG_MESSAGE_BYTES);
      void this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "log",
          primitive_id: context.primitive_id,
          payload: { level, code, message, generation: context.generation, nonce: context.nonce }
        },
        false
      );
    }
    emit(code) {
      void this.emitEvent(code, false);
    }
    /** Resolves only when the parent confirms backend acceptance, not merely local send. */
    async emitConfirmed(code) {
      await this.emitEvent(code, true);
    }
    emitEvent(code, confirmed) {
      const context = this.requireActive();
      const sanitized = code.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
      if (!sanitized) {
        throw new SdkValidationError("invalid_event", "Invalid event code");
      }
      return this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "event.emit",
          primitive_id: context.primitive_id,
          payload: { code: sanitized, generation: context.generation, nonce: context.nonce }
        },
        confirmed
      );
    }
    async nextPage() {
      const context = this.requireActive();
      if (!this.capabilities["page.advance"]) {
        throw new SdkValidationError("capability_denied", "This primitive cannot advance the page");
      }
      if (this.advanced) {
        this.report("debug", "advance_one_shot", "nextPage already used for this activation");
        return;
      }
      this.advanced = true;
      await this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "page.advance",
          primitive_id: context.primitive_id,
          payload: { generation: context.generation, nonce: context.nonce }
        },
        true
      );
    }
    requireKey(key) {
      const bytes = new TextEncoder().encode(key);
      if (bytes.length < 1 || bytes.length > 256 || key.startsWith("_screenrig/")) {
        throw new SdkValidationError("invalid_key", "K/V key must be 1-256 UTF-8 bytes and not use _screenrig/");
      }
      return key;
    }
    requireCapability(capability) {
      const context = this.requireActive();
      if (!this.capabilities[capability]) {
        throw new SdkValidationError("capability_denied", `This primitive does not have ${capability}`);
      }
      return context;
    }
    async kvGet(key) {
      const context = this.requireCapability("kv.read");
      const payload = { key: this.requireKey(key), generation: context.generation, nonce: context.nonce };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.get", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    async kvList() {
      const context = this.requireCapability("kv.read");
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.list", primitive_id: context.primitive_id, payload: { generation: context.generation, nonce: context.nonce } }, true);
    }
    async kvSet(key, value, options = {}) {
      const context = this.requireCapability("kv.write");
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const payload = {
        key: this.requireKey(key),
        value_base64: base64(bytes),
        content_type: options.contentType ?? (typeof value === "string" ? "text/plain" : "application/octet-stream"),
        idempotency_key: options.idempotencyKey ?? randomIdempotencyKey(),
        generation: context.generation,
        nonce: context.nonce,
        ...options.expectedRevision === void 0 ? {} : { expected_revision: options.expectedRevision }
      };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.set", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    async kvDelete(key, expectedRevision, options = {}) {
      const context = this.requireCapability("kv.write");
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new SdkValidationError("invalid_revision", "expectedRevision must be a non-negative integer");
      }
      const payload = {
        key: this.requireKey(key),
        expected_revision: expectedRevision,
        idempotency_key: options.idempotencyKey ?? randomIdempotencyKey(),
        generation: context.generation,
        nonce: context.nonce
      };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.delete", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    onResize(handler) {
      this.resizeHandlers.add(handler);
      return () => this.resizeHandlers.delete(handler);
    }
    onCapabilities(handler) {
      this.capabilityHandlers.add(handler);
      return () => this.capabilityHandlers.delete(handler);
    }
  };
  function createAttachedScreenRig(options, allowOpaqueNativeParent, nativeParentOrigin) {
    return new ScreenRigClient(options, allowOpaqueNativeParent, nativeParentOrigin);
  }

  // src/host.ts
  var BrowserHost = class {
    constructor(windowLike) {
      this.windowLike = windowLike;
      this.parent = windowLike.parent;
    }
    parent;
    addMessageListener(listener) {
      const wrapped = (event) => listener(event);
      this.windowLike.addEventListener("message", wrapped);
      return () => this.windowLike.removeEventListener("message", wrapped);
    }
    postToParent(data, targetOrigin, opaqueSourceBound = false) {
      if (!targetOrigin || targetOrigin === "*" && !opaqueSourceBound) {
        throw new Error("BrowserHost refused wildcard targetOrigin");
      }
      this.windowLike.parent.postMessage(data, targetOrigin);
    }
  };

  // src/trusted-origin.ts
  var LOCAL_PLAYER_ORIGIN = "http://play.screenrig.localhost:8088";
  var LOCAL_RELEASE_HOSTNAME = /^r-[a-f0-9]{40}\.apps\.screenrig\.localhost$/;
  var NATIVE_PACKAGE_HOSTNAME = /^p-[a-f0-9]{32}\.[a-f0-9]{32}\.offline\.screenrig\.invalid$/;
  function isLocalReleaseDocument(location) {
    return location.protocol === "http:" && location.port === "8088" && LOCAL_RELEASE_HOSTNAME.test(location.hostname) && location.origin === `http://${location.hostname}:8088`;
  }
  function isNativePackageDocument(location) {
    return location.protocol === "https:" && location.port === "" && NATIVE_PACKAGE_HOSTNAME.test(location.hostname) && location.origin === `https://${location.hostname}`;
  }
  function resolveTrustedPlayerOrigins(location) {
    if (location === void 0) {
      return [DEFAULT_PLAYER_ORIGIN];
    }
    if (isLocalReleaseDocument(location)) {
      return [LOCAL_PLAYER_ORIGIN];
    }
    if (isNativePackageDocument(location)) {
      return [DEFAULT_PLAYER_ORIGIN, LOCAL_PLAYER_ORIGIN];
    }
    return [DEFAULT_PLAYER_ORIGIN];
  }
  function resolveTrustedParentPolicy(location) {
    const namedQtPackage = location?.protocol === "screenrig-app:" && /^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(location.hostname) && location.port === "" && location.origin === `screenrig-app://${location.hostname}`;
    return {
      origins: resolveTrustedPlayerOrigins(location),
      allowOpaqueNativeParent: location?.protocol === "screenrig-app:" && location.origin === "null",
      ...namedQtPackage ? { nativeParentOrigin: "qrc:" } : {}
    };
  }

  // src/index.ts
  function attachScreenRig(windowLike) {
    if (windowLike.screenrig) {
      return windowLike.screenrig;
    }
    const policy = resolveTrustedParentPolicy(windowLike.location);
    const client = createAttachedScreenRig({
      host: new BrowserHost(windowLike),
      trustedPlayerOrigins: policy.origins
    }, policy.allowOpaqueNativeParent, policy.nativeParentOrigin);
    Object.defineProperty(windowLike, "screenrig", { value: client, enumerable: true, configurable: false, writable: false });
    return client;
  }

  // src/browser.ts
  var candidate = globalThis.window;
  if (candidate?.parent && typeof candidate.addEventListener === "function") {
    attachScreenRig(candidate);
  }
})();
