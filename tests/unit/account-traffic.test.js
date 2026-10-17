// Density control for providers whose upstream bans accounts for anomalous
// request patterns. Evidence: qiyworkapi (max_in_flight per account, global
// realm lower, 100 ms min pick gap) and magpie (jittered rotation backoff).
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  acquireAccountLease,
  leaseBoundResponse,
  resetAccountTraffic,
} from "../../src/sse/services/accountTraffic.js";

const PROVIDER = "codebuddy-intl";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("per-account in-flight cap", () => {
  beforeEach(() => resetAccountTraffic());

  it("admits up to the cap, then queues", async () => {
    const limits = { maxInFlight: 2, minGapMs: 0 };
    const a = await acquireAccountLease(PROVIDER, "conn", { limits });
    const b = await acquireAccountLease(PROVIDER, "conn", { limits });
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    let third = null;
    const pending = acquireAccountLease(PROVIDER, "conn", { limits, maxWaitMs: 2000 })
      .then((lease) => { third = lease; });
    await sleep(60);
    expect(third).toBeNull();

    a.release();
    await pending;
    expect(third).toBeTruthy();

    b.release();
    third.release();
  });

  it("does not shape other providers", async () => {
    expect(await acquireAccountLease("codebuddy-cn", "conn")).toBeNull();
    expect(await acquireAccountLease(PROVIDER, null)).toBeNull();
  });
});

describe("request start pacing", () => {
  beforeEach(() => resetAccountTraffic());

  it("spaces a second request on the same account", async () => {
    const limits = { maxInFlight: 2, minGapMs: 40 };
    const first = await acquireAccountLease(PROVIDER, "conn", { limits });
    first.release();

    const startedAt = Date.now();
    const second = await acquireAccountLease(PROVIDER, "conn", { limits });
    expect(second).toBeTruthy();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    second.release();
  });

  it("fails open instead of deadlocking on leaked slots", async () => {
    const limits = { maxInFlight: 1, minGapMs: 0 };
    // A lease that will never be released consumes the cap.
    await acquireAccountLease(PROVIDER, "conn", { limits });

    const startedAt = Date.now();
    const lease = await acquireAccountLease(PROVIDER, "conn", { limits, maxWaitMs: 50 });
    // The safety cap must never become an outage.
    expect(lease).toBeTruthy();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    lease.release();
  });

  it("release is idempotent", async () => {
    const limits = { maxInFlight: 1, minGapMs: 0 };
    const lease = await acquireAccountLease(PROVIDER, "conn", { limits });
    lease.release();
    lease.release();
    const next = await acquireAccountLease(PROVIDER, "conn", { limits });
    expect(next).toBeTruthy();
    next.release();
  });
});

describe("lease bound to the response lifetime", () => {
  beforeEach(() => resetAccountTraffic());

  const leaseFor = () => {
    const release = vi.fn();
    return { release };
  };

  it("releases when the stream finishes", async () => {
    const lease = leaseFor();
    const response = leaseBoundResponse(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: x\n\n"));
          controller.close();
        },
      })),
      lease,
    );
    const text = await response.text();
    expect(text).toBe("data: x\n\n");
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("releases when the client cancels the stream", async () => {
    const lease = leaseFor();
    const response = leaseBoundResponse(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      })),
      lease,
    );
    await response.body.cancel();
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("releases immediately when there is no body", () => {
    const lease = leaseFor();
    const original = new Response(null, { status: 204 });
    expect(leaseBoundResponse(original, lease)).toBe(original);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });
});
