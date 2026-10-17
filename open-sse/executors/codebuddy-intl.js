import { createHash, randomBytes } from "node:crypto";
import { DefaultExecutor } from "./default.js";

/**
 * RFC 9562 UUIDv7 shape: 48-bit timestamp, version nibble 7, RFC variant.
 * The official 5.8.4 desktop client's `X-Conversation-ID` is a dashed UUID of
 * this shape (capture-verified); dropping the dashes yields the 32-hex form it
 * uses for the request/message ids.
 */
function uuid7() {
  const buf = randomBytes(16);
  const ms = Date.now();
  buf[0] = (ms / 2 ** 40) & 0xff;
  buf[1] = (ms / 2 ** 32) & 0xff;
  buf[2] = (ms / 2 ** 24) & 0xff;
  buf[3] = (ms / 2 ** 16) & 0xff;
  buf[4] = (ms / 2 ** 8) & 0xff;
  buf[5] = ms & 0xff;
  buf[6] = (buf[6] & 0x0f) | 0x70; // version 7
  buf[8] = (buf[8] & 0x3f) | 0x80; // RFC variant
  return dashed(buf);
}

/**
 * Same uuid7 shape, but derived from a session key so retries of a turn and the
 * later turns of one conversation keep their `X-Conversation-ID`. The timestamp
 * field is drawn from the digest too — upstream does not read it, and the id
 * has to be deterministic for the id to stay stable.
 */
function stableUuid7(key) {
  const buf = Buffer.from(createHash("sha256").update(key).digest().subarray(0, 16));
  buf[6] = (buf[6] & 0x0f) | 0x70;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  return dashed(buf);
}

function dashed(buf) {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function hex32() {
  return uuid7().replace(/-/g, "");
}

// Read a header case-insensitively. HTTP header names are case-insensitive, so a
// caller that already sent `x-conversation-id` must be found — testing the exact
// key would miss it, add a second `X-Conversation-ID`, and undici would then join
// both into one comma-separated value ("caller, ours"), corrupting the id we are
// supposed to keep stable. Accepts a plain object (the executor path) or a fetch
// `Headers` instance (whose get/set are already case-insensitive). A non-object
// input means "no headers", not an error.
function readHeader(headers, name) {
  if (typeof headers?.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value.trim() : "";
  }
  if (!headers || typeof headers !== "object") return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

// Write a header, updating the caller's existing key when only the case differs
// rather than adding a duplicate.
function writeHeader(headers, name, value) {
  if (typeof headers?.set === "function") {
    headers.set(name, value);
    return;
  }
  if (!headers || typeof headers !== "object") return;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  headers[key || name] = value;
}

// Session key for the conversation id: an explicit session wins, then the
// opening user message (typed blocks joined).
function sessionKey(body) {
  const explicit =
    (typeof body?.session_id === "string" && body.session_id) ||
    (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key) ||
    (typeof body?.conversation_id === "string" && body.conversation_id) ||
    null;
  if (explicit) return explicit;
  const firstUser = Array.isArray(body?.messages)
    ? body.messages.find((m) => m?.role === "user")
    : null;
  const text = typeof firstUser?.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser?.content)
      ? firstUser.content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
      : "";
  return text ? `cbai:${text}` : null;
}

/**
 * Attach the header family the gateway's channel verification demands (HTTP 400
 * code 11128 "conversation id missing" without it), mirroring what the official
 * WorkBuddy AI 5.8.4 client sends on POST /v2/chat/completions:
 *
 *   X-Conversation-ID          dashed UUID (uuid7 shape)
 *   X-Conversation-Request-ID  32 hex  (same value as X-Root-Request-ID)
 *   X-Root-Request-ID          32 hex
 *   X-Conversation-Message-ID  32 hex  (same value as X-Request-ID)
 *   X-Request-ID               32 hex
 *   X-Trace-ID / traceparent / b3 / X-B3-* — one trace id per request
 *
 * All three of `X-Conversation-ID`, `X-Conversation-Request-ID` and
 * `X-Conversation-Message-ID` are required; A/B against the live gateway shows
 * any two of them are still answered 11128 (PR #4944). `X-Request-ID` is not
 * part of the requirement — it mirrors the message id because the client sends
 * it that way.
 *
 * Values that already exist and are non-empty are preserved, so a caller
 * tracking its own conversation keeps it; blank values count as absent. The
 * function is idempotent: a second pass over an already-filled bag rotates
 * nothing.
 */
export function withConversationHeaders(headers, body = null) {
  if (!readHeader(headers, "X-Conversation-ID")) {
    const key = sessionKey(body);
    writeHeader(headers, "X-Conversation-ID", key ? stableUuid7(key) : uuid7());
  }
  if (!readHeader(headers, "X-Conversation-Request-ID")) {
    writeHeader(headers, "X-Conversation-Request-ID", hex32());
  }
  // The client's root request id mirrors the conversation request id.
  if (!readHeader(headers, "X-Root-Request-ID")) {
    writeHeader(headers, "X-Root-Request-ID", readHeader(headers, "X-Conversation-Request-ID"));
  }
  // The request id mirrors the message id: reuse whichever side already exists.
  const messageId =
    readHeader(headers, "X-Conversation-Message-ID") ||
    readHeader(headers, "X-Request-ID") ||
    hex32();
  if (!readHeader(headers, "X-Conversation-Message-ID")) {
    writeHeader(headers, "X-Conversation-Message-ID", messageId);
  }
  if (!readHeader(headers, "X-Request-ID")) {
    writeHeader(headers, "X-Request-ID", messageId);
  }

  // Trace family — W3C traceparent + B3, all derived from one trace id and span.
  const trace =
    readHeader(headers, "X-Trace-ID") || readHeader(headers, "X-B3-TraceId") || hex32();
  const span = readHeader(headers, "X-B3-SpanId") || randomBytes(8).toString("hex");
  if (!readHeader(headers, "X-Trace-ID")) writeHeader(headers, "X-Trace-ID", trace);
  if (!readHeader(headers, "X-B3-TraceId")) writeHeader(headers, "X-B3-TraceId", trace);
  if (!readHeader(headers, "X-B3-SpanId")) writeHeader(headers, "X-B3-SpanId", span);
  if (!readHeader(headers, "traceparent")) {
    writeHeader(headers, "traceparent", `00-${trace}-${span}-01`);
  }
  if (!readHeader(headers, "b3")) writeHeader(headers, "b3", `${trace}-${span}-1`);
  if (!readHeader(headers, "X-B3-Sampled")) writeHeader(headers, "X-B3-Sampled", "1");

  return headers;
}

/**
 * CodeBuddyIntlExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // The intl gateway's channel verification rejects any request that does not
  // carry the X-Conversation-* header family the official client sends on every
  // turn. The derivation rules live in withConversationHeaders above.
  //
  // **Fail closed.** buildHeaders runs outside the fetch try/catch in base.js,
  // so an unexpected error here would surface as a generic 502 with no cause —
  // and a silent fall-through to "send without the family" is worse, because the
  // gateway refuses such a request every time. Name the gate instead.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    try {
      return withConversationHeaders(headers, body);
    } catch (error) {
      throw new Error(
        `CodeBuddy channel verification: could not attach the X-Conversation-* family `
        + `(${error?.message || error}). The intl gateway rejects any request without it `
        + `(HTTP 400 code 11128 "conversation id missing"), so this request cannot succeed.`,
      );
    }
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }

        // Code 11128 is overloaded: it also carries "first message is not system
        // prompt" (a body-shape problem fixed in transformRequest). Only the
        // conversation-id variant is channel verification, so branch on the
        // message, never on the code alone — otherwise the failure reads as a
        // generic 400 and the cause has to be rediscovered from scratch.
        if (data?.code === 11128 && /conversation id missing/i.test(msg)) {
          const tip = data?.displayTips?.en || data?.displayMsg?.en || "";
          return {
            status: 400,
            message:
              "CodeBuddy channel verification failed (11128 \"conversation id missing\"): "
              + "the upstream gateway requires the X-Conversation-* header family the official "
              + "IDE sends, supplied by CodeBuddyIntlExecutor.buildHeaders(). If this appears, "
              + "the gate likely changed (e.g. a new required header)."
              + (tip ? ` Upstream said: ${tip}` : ""),
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
