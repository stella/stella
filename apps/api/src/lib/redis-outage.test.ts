/**
 * Valkey outage degradation.
 *
 * Valkey holds only ephemeral coordination, so losing it must degrade the API
 * and never corrupt it (see `/conventions-scale`). Each consumer's degraded
 * path is written down somewhere; this suite pins that the paths actually run,
 * against the real Bun client aimed at a port nothing listens on. Substituting
 * a fake client here would test the fake, not the failure: it is the real
 * connect/timeout behavior that decides whether a request stalls, throws, or
 * quietly falls back.
 *
 * Not covered here: BullMQ enqueue failure, whose contract differs per caller
 * and per durable outbox, and which BullMQ's own retry loop makes slow and
 * timing-dependent to exercise.
 */

import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";

// Port 1 is privileged and unbound in every environment this runs in, so a
// connect attempt fails immediately rather than hanging on a routing black
// hole. Every consumer below caps its own commands anyway; a bounded failure
// is exactly what is under test.
const UNREACHABLE_REDIS_URL = "redis://127.0.0.1:1";

process.env["REDIS_URL"] = UNREACHABLE_REDIS_URL;

// Imported directly, not only through the facades. The batching runner pairs
// test files by the modules they name, so naming the connection module here is
// what keeps this suite out of any process where another file has mocked
// `createRedisClient` and replaced the very failure under test.
const { createRedisClient } = await import("@/api/lib/redis-client");
const { RedisRateLimitContext } =
  await import("@/api/lib/rate-limit/redis-context");
const { createAuthRateLimitStorage } =
  await import("@/api/lib/rate-limit/auth-storage");
const { createMcpGatewayRateLimiter } =
  await import("@/api/mcp/gateway/rate-limit");
const { createFeedbackIntakeGuards } =
  await import("@/api/handlers/feedback/intake-guards");
const { createSecurityCanaryAlertDeduplicator } =
  await import("@/api/lib/security-canary");
const { publishWorkspaceEvent, SSEBroadcastError } =
  await import("@/api/lib/sse-broadcast");
const { broadcast } = await import("@/api/lib/sse");
const { resourceUpdatedRealtimeEvent } = await import("@stll/api-contract");
const { getRootWorkflowRunStateStore } =
  await import("@/api/lib/workflow/root-run-state-store");
const { brandPersistedWorkspaceId, brandPersistedEntityId } =
  await import("@/api/lib/safe-id-boundaries");

// Long enough for a refused connection plus each consumer's own command
// timeout (500ms in the limiters), short enough that a hang fails the test
// rather than the suite.
const SETTLE_BUDGET_MS = 5000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
// Time for a connect rejected by `kill()` to reach its handler.
const CONNECT_SETTLE_MS = 100;
const RATE_LIMIT_OPTIONS = {
  duration: RATE_LIMIT_WINDOW_MS,
  generator: () => "outage-client",
  max: RATE_LIMIT_MAX,
  skip: () => false,
} as const satisfies Omit<RateLimitOptions, "context">;

const WORKSPACE_ID = brandPersistedWorkspaceId(
  "01930000-0000-7000-8000-000000000001",
);
const EVENT = resourceUpdatedRealtimeEvent(
  resourceRef({
    type: RESOURCE_TYPE.ENTITY,
    id: brandPersistedEntityId("01930000-0000-7000-8000-000000000002"),
  }),
);

/** Resolve to the settled outcome, or reject if the promise hangs. */
const settle = async <T>(
  promise: Promise<T>,
): Promise<
  { status: "ok"; value: T } | { status: "error"; error: unknown }
> => {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Valkey consumer did not settle within its budget"));
    }, SETTLE_BUDGET_MS);
    timer.unref();
  });
  return await Promise.race([
    promise.then(
      (value): { status: "ok"; value: T } => ({ status: "ok", value }),
      (error: unknown): { status: "error"; error: unknown } => ({
        status: "error",
        error,
      }),
    ),
    timeout,
  ]);
};

describe("the outage under test", () => {
  // Without this the suite would be vacuous wherever a local Valkey happens to
  // be running, or wherever the client has been mocked: every consumer below
  // would succeed for the ordinary reason.
  test("a real client cannot reach Valkey", async () => {
    const { envDocumentProcessingWorker } =
      await import("@/api/env-document-processing-worker");
    expect(envDocumentProcessingWorker.REDIS_URL).toBe(UNREACHABLE_REDIS_URL);

    const client = createRedisClient({
      connectionTimeout: 500,
      enableOfflineQueue: false,
    });
    const result = await settle(client.send("PING", []));
    expect(result.status).toBe("error");
    expect(() => {
      client.close();
    }).not.toThrow();
  });
});

describe("rate limiting during a Valkey outage", () => {
  test("the fail-open policy admits the request from a local counter", async () => {
    const context = new RedisRateLimitContext({
      failurePolicy: "fail_open_local",
      onRedisError: () => undefined,
    });
    context.init(RATE_LIMIT_OPTIONS);

    const first = await settle(
      context.increment("outage-open", RATE_LIMIT_WINDOW_MS),
    );
    expect(first.status).toBe("ok");
    // The local fallback counts this request, so the caller sees an admitted
    // request rather than an error or an exhausted window.
    expect(first.status === "ok" ? first.value.count : null).toBe(1);

    const second = await settle(
      context.increment("outage-open", RATE_LIMIT_WINDOW_MS),
    );
    expect(second.status === "ok" ? second.value.count : null).toBe(2);

    // A refund against an unreachable Valkey must also settle, not throw into
    // the request that is already failing.
    expect((await settle(context.decrement("outage-open"))).status).toBe("ok");
    context.kill();
  });

  test("the fail-closed policy exhausts the window instead of erroring", async () => {
    const context = new RedisRateLimitContext({
      failurePolicy: "fail_closed",
      onRedisError: () => undefined,
    });
    context.init(RATE_LIMIT_OPTIONS);

    const result = await settle(
      context.increment("outage-closed", RATE_LIMIT_WINDOW_MS),
    );
    expect(result.status).toBe("ok");
    // Same shape as the fail-open path: a counter, never a rejection. The
    // policy shows up in the count, which is already past any configured max.
    expect(result.status === "ok" ? result.value.count : 0).toBeGreaterThan(
      RATE_LIMIT_MAX,
    );
    context.kill();
  });

  test("the eager connect neither throws at construction nor leaks past kill", async () => {
    const operations: string[] = [];
    const context = new RedisRateLimitContext({
      failurePolicy: "fail_open_local",
      onRedisError: (_error, operation) => {
        operations.push(operation);
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    // Requests issued while the client is still trying to connect take the
    // same fail-open path as any other outage.
    const first = await settle(
      context.increment("outage-cold", RATE_LIMIT_WINDOW_MS),
    );
    expect(first.status === "ok" ? first.value.count : null).toBe(1);
    expect(operations).toContain("increment");

    // Closing the context rejects the pending connect. That rejection belongs
    // to a client the context no longer owns: it must neither be reported as
    // a connect failure nor escape as an unhandled rejection, which would fail
    // this file.
    context.kill();
    await Bun.sleep(CONNECT_SETTLE_MS);
    expect(operations).not.toContain("connect");
  });

  test("auth rate limiting keeps limiting from its per-process fallback", async () => {
    const storage = createAuthRateLimitStorage();
    const key = "ip:203.0.113.1";
    const rule = { max: 2, window: 60 };

    expect((await settle(storage.consume(key, rule))).status).toBe("ok");
    expect((await settle(storage.consume(key, rule))).status).toBe("ok");

    const denied = await settle(storage.consume(key, rule));
    expect(denied.status).toBe("ok");
    // Sign-in stays bounded: the local atomic counter survives the outage, so
    // tipping Valkey over cannot reset the brute-force budget on this replica.
    expect(denied.status === "ok" ? denied.value.allowed : null).toBe(false);
  });

  test("the MCP gateway limiter admits and keeps counting locally", async () => {
    const limiter = createMcpGatewayRateLimiter({
      onRedisError: () => undefined,
    });
    const consume = async () =>
      await settle(
        limiter.consume({ connectorSlug: "slug", userId: "user-1" }),
      );

    const first = await consume();
    expect(first.status === "ok" ? first.value : null).toBe(true);
    // Still admitted, and still bounded: the fallback keeps counting rather
    // than being bypassed, so the configured maximum stays enforceable.
    const second = await consume();
    expect(second.status === "ok" ? second.value : null).toBe(true);
  });

  test("the public feedback intake stays guarded by its local counters", async () => {
    const guards = createFeedbackIntakeGuards({
      onRedisError: () => undefined,
    });

    const admitted = await settle(
      guards.consumeCounter({
        bucket: "ip",
        key: "203.0.113.2",
        max: 1,
        windowMs: 60_000,
      }),
    );
    expect(admitted.status === "ok" ? admitted.value : null).toBe(true);

    const exhausted = await settle(
      guards.consumeCounter({
        bucket: "ip",
        key: "203.0.113.2",
        max: 1,
        windowMs: 60_000,
      }),
    );
    // An unauthenticated write endpoint must not become unbounded because
    // Valkey is down.
    expect(exhausted.status === "ok" ? exhausted.value : null).toBe(false);

    const claim = await settle(
      guards.claimDedup({ key: "digest-1", ttlMs: 60_000 }),
    );
    expect(claim.status === "ok" ? claim.value : null).toBe(true);
  });
});

describe("workflow run state during a Valkey outage", () => {
  test("a run-state command fails on its own bound rather than being held", async () => {
    const result = await settle(
      getRootWorkflowRunStateStore().clear(WORKSPACE_ID),
    );

    // The store's client keeps reconnecting and queues what it is given while
    // it does, so the bound is the only thing between a workflow step and the
    // length of the outage. Failing lets the step's own retry decide.
    expect(result.status).toBe("error");
  });
});

describe("security alerting during a Valkey outage", () => {
  test("a canary hit is emitted rather than suppressed", async () => {
    const claimAlert = createSecurityCanaryAlertDeduplicator();
    const decision = await settle(claimAlert());

    expect(decision.status).toBe("ok");
    if (decision.status !== "ok") {
      return;
    }
    // Deduplication is an optimization; losing it must not lose the alert.
    expect(decision.value.status).toBe("emit");
    if (decision.value.status !== "emit") {
      return;
    }
    expect(decision.value.reason).toBe("deduplication_unavailable");
  });
});

describe("SSE fan-out during a Valkey outage", () => {
  test("the request-path broadcast returns without throwing", () => {
    // `broadcast` is the shape every handler call site uses: synchronous and
    // void, so an outage cannot reach the HTTP response. Local clients are
    // still served inline while no subscriber is attached.
    expect(() => {
      broadcast(WORKSPACE_ID, EVENT);
    }).not.toThrow();
  });

  test("a direct publish fails fast as a tagged error", async () => {
    const result = await settle(publishWorkspaceEvent(WORKSPACE_ID, EVENT));

    // The publish must not hang. The desktop-edit-session expiry task awaits
    // its publishes and only stamps the notification column after one
    // succeeds, so it needs a bounded failure to retry and reschedule
    // against; a buffered command that never settles would hold its lease.
    expect(result.status).toBe("error");
    expect(
      result.status === "error" ? SSEBroadcastError.is(result.error) : false,
    ).toBe(true);
  });
});
