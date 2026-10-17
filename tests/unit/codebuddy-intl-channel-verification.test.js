// Integration of upstream PRs #4949 + #4944: the intl gateway (WorkBuddy AI)
// refuses any chat request that does not carry the X-Conversation-* header
// family the official 5.8.4 desktop client sends — HTTP 400 code 11128
// "conversation id missing" (#4892/#4946) — and the outbound identity (domain,
// UA, IDE headers) has to match that client too.
//
// Header values/shapes are the capture-verified ones: `X-Conversation-ID` is a
// dashed UUIDv7, the request/message/root ids are 32 hex, and `X-Request-ID` /
// `X-Root-Request-ID` mirror the message / conversation request id.
import { describe, expect, it } from "vitest";

import registry from "../../open-sse/providers/registry/codebuddy-intl.js";
import { CodeBuddyIntlExecutor, withConversationHeaders } from "../../open-sse/executors/codebuddy-intl.js";

const CAPTURED_UA = "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
const URL_ = "https://www.workbuddy.ai/v2/chat/completions";
const CREDS = { accessToken: "test-token" };

const CONVERSATION_HEADERS = [
  "X-Conversation-ID",
  "X-Conversation-Request-ID",
  "X-Root-Request-ID",
  "X-Conversation-Message-ID",
];
const HEX32_HEADERS = [
  "X-Request-ID",
  "X-Conversation-Request-ID",
  "X-Root-Request-ID",
  "X-Conversation-Message-ID",
];
const TRACE_HEADERS = [
  "X-Trace-ID",
  "traceparent",
  "b3",
  "X-B3-TraceId",
  "X-B3-SpanId",
  "X-B3-Sampled",
];
const DASHED_UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const buildHeaders = (body = null) =>
  new CodeBuddyIntlExecutor().buildHeaders(CREDS, true, URL_, "glm-5.2", body);

describe("codebuddy-intl outbound identity (#4949)", () => {
  it("talks to the workbuddy.ai chat gateway", () => {
    expect(registry.transport.baseUrl).toBe("https://www.workbuddy.ai/v2/chat/completions");
  });

  it("sends the captured desktop User-Agent", () => {
    expect(registry.transport.headers["User-Agent"]).toBe(CAPTURED_UA);
  });

  it("identifies as WorkBuddy, not IDE", () => {
    expect(registry.transport.headers["X-IDE-Type"]).toBe("WorkBuddy");
    expect(registry.transport.headers["X-IDE-Name"]).toBe("WorkBuddy");
    expect(registry.transport.headers["X-IDE-Version"]).toBe("5.8.4");
  });

  it("carries the captured product and agent headers", () => {
    const headers = registry.transport.headers;
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-Private-Data"]).toBe("true");
    expect(headers["X-Agent-Intent"]).toBe("craft");
    expect(headers["X-Agent-Purpose"]).toBe("conversation");
    expect(headers["X-Agent-Type"]).toBe("main");
    expect(headers["X-Domain"]).toBe("www.workbuddy.ai");
  });

  it("reads usage from the workbuddy.ai billing endpoint", () => {
    expect(registry.transport.usage.url).toBe(
      "https://www.workbuddy.ai/v2/billing/meter/get-user-resource"
    );
  });

  it("leaves no old IDE identity in the outbound values", () => {
    const values = Object.values(registry.transport.headers);
    expect(values).not.toContain("IDE/2.108.1 CodeBuddy/2.108.1");
    expect(values).not.toContain("IDE");
    expect(registry.transport.baseUrl).not.toContain("codebuddy.ai");
    expect(registry.transport.usage.url).not.toContain("codebuddy.ai");
  });
});

describe("the X-Conversation-* family always goes out", () => {
  const exec = new CodeBuddyIntlExecutor();
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("sets every conversation header", () => {
    const headers = exec.buildHeaders(CREDS, true, URL_, "glm-5.2", body);
    for (const name of CONVERSATION_HEADERS) expect(headers[name], name).toBeTruthy();
  });

  it("keeps the captured id relationships", () => {
    const headers = exec.buildHeaders(CREDS, true, URL_, "glm-5.2", body);
    expect(headers["X-Conversation-Message-ID"]).toBe(headers["X-Request-ID"]);
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
  });

  it("uses the captured id shapes", () => {
    const headers = exec.buildHeaders(CREDS, true, URL_, "glm-5.2", body);
    expect(headers["X-Conversation-ID"]).toMatch(DASHED_UUID7);
    for (const name of HEX32_HEADERS) expect(headers[name], name).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends the W3C / B3 trace family", () => {
    const headers = exec.buildHeaders(CREDS, true, URL_, "glm-5.2", body);
    for (const name of TRACE_HEADERS) expect(headers[name], name).toBeTruthy();
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers["X-B3-TraceId"]).toBe(headers["X-Trace-ID"]);
    expect(headers.b3.startsWith(`${headers["X-Trace-ID"]}-${headers["X-B3-SpanId"]}-`)).toBe(true);
  });

  it("still sends the family when there is no body at all", () => {
    for (const empty of [null, undefined]) {
      const headers = exec.buildHeaders(CREDS, true, URL_, "glm-5.2", empty);
      for (const name of CONVERSATION_HEADERS) expect(headers[name], name).toBeTruthy();
    }
  });
});

// The 5.8.4 capture sends a new X-Conversation-ID on every call and the gateway
// keeps no history under it (PR #4949). A session-derived id was inert at best
// and collided across unrelated sessions that open with the same message.
describe("every id is fresh per request", () => {
  const exec = new CodeBuddyIntlExecutor();

  it("gives two builds of the same body different conversation ids", () => {
    const body = { messages: [{ role: "user", content: "same opening message" }] };
    const a = exec.buildHeaders(CREDS, true, URL_, "m", body);
    const b = exec.buildHeaders(CREDS, true, URL_, "m", body);
    expect(a["X-Conversation-ID"]).toMatch(DASHED_UUID7);
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
    expect(a["X-Conversation-Request-ID"]).not.toBe(b["X-Conversation-Request-ID"]);
    expect(a["X-Conversation-Message-ID"]).not.toBe(b["X-Conversation-Message-ID"]);
  });

  it("does not derive the id from an explicit session id", () => {
    const a = exec.buildHeaders(CREDS, true, URL_, "m", { session_id: "sess-123" });
    const b = exec.buildHeaders(CREDS, true, URL_, "m", { session_id: "sess-123" });
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
  });

  it("still emits a valid id when there is no body", () => {
    const a = exec.buildHeaders(CREDS, true, URL_, "m", null);
    expect(a["X-Conversation-ID"]).toMatch(DASHED_UUID7);
  });
});

describe("caller-supplied ids are preserved", () => {
  const exec = new CodeBuddyIntlExecutor();
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("keeps non-empty values and only fills the gaps", () => {
    const headers = withConversationHeaders({
      "X-Conversation-ID": "11111111-1111-1111-1111-111111111111",
      "X-Conversation-Message-ID": "fixed-message-id",
    });
    expect(headers["X-Conversation-ID"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(headers["X-Conversation-Message-ID"]).toBe("fixed-message-id");
    expect(headers["X-Request-ID"]).toBe("fixed-message-id");
    expect(headers["X-Conversation-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("treats blank values as absent", () => {
    const headers = withConversationHeaders({ "X-Conversation-ID": "   " });
    expect(headers["X-Conversation-ID"]).toMatch(DASHED_UUID7);
  });

  it("rotates nothing on a second pass over the same bag", () => {
    const first = exec.buildHeaders(CREDS, true, URL_, "m", body);
    const second = withConversationHeaders({ ...first });
    for (const name of [...CONVERSATION_HEADERS, ...TRACE_HEADERS]) {
      expect(second[name], name).toBe(first[name]);
    }
  });
});

// HTTP header names are case-insensitive: a caller's lowercase key must be
// found, or a second key is added and undici joins both into one comma-separated
// value, corrupting the id the caller supplied.
describe("header lookup and writes are case-insensitive", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  it("does not duplicate a caller's lowercase conversation id", () => {
    const headers = withConversationHeaders({ "x-conversation-id": "caller-lower" });
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === "x-conversation-id")).toHaveLength(1);
    expect(headers["x-conversation-id"]).toBe("caller-lower");
  });

  it("does not duplicate a caller's mixed-case message id", () => {
    const headers = withConversationHeaders({ "X-Conversation-Message-Id": "caller-mixed" });
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === "x-conversation-message-id")).toHaveLength(1);
    expect(headers["X-Request-ID"]).toBe("caller-mixed");
  });

  it("recognises a lowercase X-Request-ID when mirroring", () => {
    const headers = withConversationHeaders({ "x-request-id": "caller-trace" });
    expect(headers["x-request-id"]).toBe("caller-trace");
    expect(headers["X-Conversation-Message-ID"]).toBe("caller-trace");
  });

  it("fills a fetch Headers instance instead of adding plain properties", () => {
    const headers = withConversationHeaders(new Headers({ "x-conversation-id": "caller-lower" }));
    expect(headers.get("X-Conversation-ID")).toBe("caller-lower");
    expect(headers.get("X-Conversation-Request-ID")).toBeTruthy();
    expect(headers.get("X-Conversation-Message-ID")).toBeTruthy();
    expect(headers["X-Conversation-ID"]).toBeUndefined();
  });
});

// buildHeaders fails CLOSED: a request without the family is refused by the
// gateway every time, so a silent fall-through would be a 100% failure with no
// cause. The throw has to name the gate.
describe("buildHeaders fails closed when the family cannot be attached", () => {
  it("throws a message that names the gate, not a bare TypeError", () => {
    const realKeys = Object.keys;
    try {
      Object.keys = () => { throw new Error("simulated hostile headers"); };
      const exec = new CodeBuddyIntlExecutor();
      let caught = null;
      try {
        exec.buildHeaders(CREDS, true, URL_, "m", { messages: [] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught.message).toMatch(/channel verification/i);
      expect(caught.message).toMatch(/X-Conversation/);
      expect(caught.message).toMatch(/11128/);
    } finally {
      Object.keys = realKeys;
    }
  });
});

describe("parseError classifies the 11128 variants", () => {
  const exec = new CodeBuddyIntlExecutor();

  it("names channel verification for the conversation-id variant", () => {
    const body = JSON.stringify({
      code: 11128,
      msg: "conversation id missing",
      displayTips: { en: "This call failed channel verification" },
    });
    const out = exec.parseError({ status: 400 }, body);
    expect(out.status).toBe(400);
    expect(out.message).toMatch(/channel verification/i);
    expect(out.message).toMatch(/X-Conversation/);
  });

  it("does NOT claim channel verification for the system-prompt variant", () => {
    const body = JSON.stringify({ code: 11128, msg: "first message is not system prompt" });
    const out = exec.parseError({ status: 400 }, body);
    expect(out.message).not.toMatch(/channel verification/i);
  });

  it("names the upstream risk-control block for 11140", () => {
    const body = JSON.stringify({
      code: 11140,
      msg: "request illegal",
      requestId: "01a14a5d3926755fbbb57391a5ccfad9",
      displayMsg: { en: "Your account has been restricted due to unusual activity" },
    });
    const out = exec.parseError({ status: 403 }, body);
    expect(out.status).toBe(403);
    expect(out.message).toMatch(/account restricted/i);
    expect(out.message).toMatch(/Your account has been restricted/);
    expect(out.message).toMatch(/requestId=01a14a5d3926755fbbb57391a5ccfad9/);
    // The raw JSON must not be the message: it reads like a gateway bug.
    expect(out.message).not.toMatch(/^\{"code"/);
  });

  it("keeps the upstream msg when 11140 carries no displayMsg", () => {
    const out = exec.parseError({ status: 403 }, JSON.stringify({ code: 11140, msg: "request illegal" }));
    expect(out.status).toBe(403);
    expect(out.message).toMatch(/11140/);
    expect(out.message).toMatch(/request illegal/);
  });

  it("still maps the frequency-limit code to 429", () => {
    const body = JSON.stringify({ code: 6004, msg: "超出频率限制 2026-10-16 10:00:00 UTC+8" });
    const out = exec.parseError({ status: 429 }, body);
    expect(out.status).toBe(429);
    expect(out.resetsAtMs).toBeGreaterThan(0);
  });
});
