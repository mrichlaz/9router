/**
 * Per-account traffic shaping for upstreams that score request density as a
 * risk-control signal.
 *
 * WorkBuddy's gateway bans accounts for "unusual activity". Two independent
 * gateways that survive it both throttle a credential before it gets there:
 *   - qiyworkapi: `max_in_flight` per account (3, lower for the global realm)
 *     and a 100 ms `minPickGap` so parallel requests cannot stack on one
 *     account; saturated accounts are skipped rather than queued upstream.
 *   - magpie: rotation backoff with jitter so retries do not arrive in phase.
 *
 * 9router previously had neither: a client firing parallel tool calls put all
 * of them on the same credential in the same instant. The limiter below caps
 * in-flight requests per connection and spaces request starts. It is
 * provider-scoped so every other provider keeps the old behaviour, and it
 * fails open after MAX_WAIT_MS — protection must never deadlock user traffic.
 */

const LIMITS = {
  // Global realm: qiyworkapi runs fewer in flight than the CN realm's 3.
  "codebuddy-intl": { maxInFlight: 2, minGapMs: 300 },
};

const MAX_WAIT_MS = 15_000;
const POLL_MS = 25;

/** connectionId -> { inFlight, lastStart } */
const states = new Map();

function stateFor(connectionId) {
  let state = states.get(connectionId);
  if (!state) {
    state = { inFlight: 0, lastStart: 0 };
    states.set(connectionId, state);
  }
  return state;
}

function takeSlot(connectionId, state) {
  state.inFlight += 1;
  state.lastStart = Date.now();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      state.inFlight = Math.max(0, state.inFlight - 1);
    },
  };
}

/**
 * Reserve one in-flight slot for a connection, waiting for the pacing gap and
 * for capacity. Resolves to a lease (always release it), or null when the
 * provider is not shaped.
 *
 * The wait is deliberately local: a slot frees when this process finishes a
 * response, so the only long wait is another stream in this process.
 */
export function acquireAccountLease(provider, connectionId, options = {}) {
  const limit = options.limits || LIMITS[provider];
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  if (!limit || !connectionId) return Promise.resolve(null);
  const state = stateFor(connectionId);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const attempt = () => {
      const gapWait = Math.max(0, state.lastStart + limit.minGapMs - Date.now());
      if (state.inFlight < limit.maxInFlight && gapWait === 0) {
        resolve(takeSlot(connectionId, state));
        return;
      }
      if (Date.now() - startedAt >= maxWaitMs) {
        // Fail open: a leaked lease or a very long stream must not turn the
        // safety cap into an outage.
        resolve(takeSlot(connectionId, state));
        return;
      }
      setTimeout(attempt, Math.max(POLL_MS, gapWait));
    };
    attempt();
  });
}

/**
 * Release the lease when the response body ends, errors, or the caller
 * cancels — a streaming response occupies its slot for its whole lifetime.
 * Returns the original response when there is no body to track.
 */
export function leaseBoundResponse(response, lease) {
  if (!lease) return response;
  if (!response?.body) {
    lease.release();
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        lease.release();
      },
      cancel() {
        lease.release();
      },
    })
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Test seam: drop all state. */
export function resetAccountTraffic() {
  states.clear();
}
