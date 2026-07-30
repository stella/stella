import { describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

import {
  MACHINE_API_KEY_LENGTH,
  MACHINE_API_KEY_PREFIX,
} from "@/api/lib/machine-api-key-config";
import {
  createSecurityCanaryAlertDeduplicator,
  createSecurityCanaryInterceptor,
  SECURITY_CANARY_WARNING,
  SECURITY_CANARY_WARNING_HEADER,
} from "@/api/lib/security-canary";

const CANARY_CREDENTIAL = `${MACHINE_API_KEY_PREFIX}${"a".repeat(
  MACHINE_API_KEY_LENGTH,
)}`;
const CANARY_DIGEST = new Bun.CryptoHasher("sha256")
  .update(CANARY_CREDENTIAL)
  .digest("hex");

const buildApp = ({
  claimAlert = async () => ({ status: "emit", reason: "claimed" }) as const,
  configuredDigest,
}: {
  claimAlert?: () => Promise<
    | { status: "emit"; reason: "claimed" }
    | { status: "emit"; reason: "deduplication_unavailable"; error: unknown }
    | { status: "suppress" }
  >;
  configuredDigest: string | undefined;
}) => {
  const state = { handlerCalls: 0 };
  const onTriggered = mock();
  const interceptor = createSecurityCanaryInterceptor({
    getConfiguredDigest: () => configuredDigest,
    getCorrelationId: () => "req_test",
    claimAlert,
    onTriggered: (trigger) => {
      onTriggered(trigger);
    },
  });
  const app = new Elysia().onRequest(interceptor).get("/ordinary", () => {
    state.handlerCalls += 1;
    return { ok: true };
  });

  return { app, onTriggered, state };
};

const requestWithCredential = (credential: string): Request =>
  new Request("http://localhost/ordinary", {
    headers: { authorization: `Bearer ${credential}` },
  });

const requestWithAuthorization = (authorization: string): Request =>
  new Request("http://localhost/ordinary", {
    headers: { authorization },
  });

describe("security canary interceptor", () => {
  test("does nothing when the deployment has no canary configured", async () => {
    const { app, onTriggered, state } = buildApp({
      configuredDigest: undefined,
    });

    const response = await app.handle(requestWithCredential(CANARY_CREDENTIAL));

    expect(response.status).toBe(200);
    expect(state.handlerCalls).toBe(1);
    expect(onTriggered).not.toHaveBeenCalled();
  });

  test("does not alter requests carrying an unrelated machine credential", async () => {
    const { app, onTriggered, state } = buildApp({
      configuredDigest: CANARY_DIGEST,
    });
    const unrelatedCredential = `${MACHINE_API_KEY_PREFIX}${"b".repeat(
      MACHINE_API_KEY_LENGTH,
    )}`;

    const response = await app.handle(
      requestWithCredential(unrelatedCredential),
    );

    expect(response.status).toBe(200);
    expect(state.handlerCalls).toBe(1);
    expect(onTriggered).not.toHaveBeenCalled();
  });

  test("stops a canary request before routing and emits one correlation-only event", async () => {
    const { app, onTriggered, state } = buildApp({
      configuredDigest: CANARY_DIGEST,
    });

    const response = await app.handle(requestWithCredential(CANARY_CREDENTIAL));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(SECURITY_CANARY_WARNING_HEADER)).toBe(
      SECURITY_CANARY_WARNING,
    );
    expect(await response.json()).toEqual({
      message: SECURITY_CANARY_WARNING,
    });
    expect(state.handlerCalls).toBe(0);
    expect(onTriggered).toHaveBeenCalledTimes(1);
    expect(onTriggered).toHaveBeenCalledWith({
      status: "claimed",
      requestId: "req_test",
    });
    expect(JSON.stringify(onTriggered.mock.calls)).not.toContain(
      CANARY_CREDENTIAL,
    );
  });

  test.each([
    `bearer ${CANARY_CREDENTIAL}`,
    `Bearer  ${CANARY_CREDENTIAL}`,
    `Bearer ${CANARY_CREDENTIAL} `,
  ])(
    "normalizes a valid bearer authorization header",
    async (authorization) => {
      const { app, onTriggered, state } = buildApp({
        configuredDigest: CANARY_DIGEST,
      });

      const response = await app.handle(
        requestWithAuthorization(authorization),
      );

      expect(response.status).toBe(403);
      expect(state.handlerCalls).toBe(0);
      expect(onTriggered).toHaveBeenCalledTimes(1);
    },
  );

  test("stops duplicate canary requests without emitting duplicate events", async () => {
    const { app, onTriggered, state } = buildApp({
      claimAlert: async () => ({ status: "suppress" }),
      configuredDigest: CANARY_DIGEST,
    });

    const response = await app.handle(requestWithCredential(CANARY_CREDENTIAL));

    expect(response.status).toBe(403);
    expect(state.handlerCalls).toBe(0);
    expect(onTriggered).not.toHaveBeenCalled();
  });

  test("emits when shared deduplication is unavailable", async () => {
    const redisError = new Error("Redis unavailable");
    const { app, onTriggered, state } = buildApp({
      claimAlert: async () => ({
        status: "emit",
        reason: "deduplication_unavailable",
        error: redisError,
      }),
      configuredDigest: CANARY_DIGEST,
    });

    const response = await app.handle(requestWithCredential(CANARY_CREDENTIAL));

    expect(response.status).toBe(403);
    expect(state.handlerCalls).toBe(0);
    expect(onTriggered).toHaveBeenCalledWith({
      status: "deduplication_unavailable",
      requestId: "req_test",
      error: redisError,
    });
  });

  test("ignores a malformed configured digest defensively", async () => {
    const { app, onTriggered, state } = buildApp({
      configuredDigest: "not-a-sha256-digest",
    });

    const response = await app.handle(requestWithCredential(CANARY_CREDENTIAL));

    expect(response.status).toBe(200);
    expect(state.handlerCalls).toBe(1);
    expect(onTriggered).not.toHaveBeenCalled();
  });
});

describe("security canary alert deduplicator", () => {
  test("claims once across interceptor instances sharing Redis state", async () => {
    let claimed = false;
    const send = mock(async () => {
      if (claimed) {
        return [0, 299_000];
      }
      claimed = true;
      return [1, 300_000];
    });
    const connect = mock(async () => undefined);
    const createRedis = () => ({ connect, send });
    const claimFromReplicaA = createSecurityCanaryAlertDeduplicator({
      createRedis,
    });
    const claimFromReplicaB = createSecurityCanaryAlertDeduplicator({
      createRedis,
    });

    expect(await claimFromReplicaA()).toEqual({
      status: "emit",
      reason: "claimed",
    });
    expect(await claimFromReplicaA()).toEqual({ status: "suppress" });
    expect(await claimFromReplicaB()).toEqual({ status: "suppress" });
    expect(await claimFromReplicaB()).toEqual({ status: "suppress" });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith("EVAL", [
      expect.stringContaining('redis.call("PTTL", KEYS[1])'),
      "1",
      "security:canary:alert:machine-api-key",
      "300000",
    ]);
  });

  test("aligns local duplicate suppression with the shared claim TTL", async () => {
    let now = 1000;
    const send = mock(async () =>
      send.mock.calls.length === 1 ? [0, 1000] : [1, 300_000],
    );
    const claimAlert = createSecurityCanaryAlertDeduplicator({
      createRedis: () => ({ connect: async () => undefined, send }),
      now: () => now,
    });

    expect(await claimAlert()).toEqual({ status: "suppress" });
    now += 999;
    expect(await claimAlert()).toEqual({ status: "suppress" });
    expect(send).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await claimAlert()).toEqual({
      status: "emit",
      reason: "claimed",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("suppresses concurrent replays while the shared claim is pending", async () => {
    let resolveSend: (value: unknown) => void = () => undefined;
    const send = mock(
      async () =>
        await new Promise<unknown>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const claimAlert = createSecurityCanaryAlertDeduplicator({
      createRedis: () => ({ connect: async () => undefined, send }),
    });

    const firstClaim = claimAlert();
    expect(await claimAlert()).toEqual({ status: "suppress" });
    expect(send).toHaveBeenCalledTimes(1);

    resolveSend([1, 300_000]);
    expect(await firstClaim).toEqual({
      status: "emit",
      reason: "claimed",
    });
  });

  test("fails toward alert visibility when Redis rejects the claim", async () => {
    const redisError = new Error("Redis unavailable");
    const claimAlert = createSecurityCanaryAlertDeduplicator({
      createRedis: () => ({
        connect: async () => undefined,
        send: async () => {
          throw redisError;
        },
      }),
    });

    expect(await claimAlert()).toEqual({
      status: "emit",
      reason: "deduplication_unavailable",
      error: redisError,
    });
  });

  test("bounds retries and events locally during a shared Redis outage", async () => {
    const redisError = new Error("Redis unavailable");
    let now = 1000;
    const send = mock(async () => {
      throw redisError;
    });
    const claimAlert = createSecurityCanaryAlertDeduplicator({
      createRedis: () => ({ connect: async () => undefined, send }),
      now: () => now,
    });

    expect(await claimAlert()).toEqual({
      status: "emit",
      reason: "deduplication_unavailable",
      error: redisError,
    });
    expect(await claimAlert()).toEqual({ status: "suppress" });
    expect(send).toHaveBeenCalledTimes(1);

    now += 300_000;
    expect(await claimAlert()).toEqual({
      status: "emit",
      reason: "deduplication_unavailable",
      error: redisError,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("fails toward alert visibility when Redis cannot initialize", async () => {
    const redisError = new Error("Redis configuration unavailable");
    const claimAlert = createSecurityCanaryAlertDeduplicator({
      createRedis: () => {
        throw redisError;
      },
    });

    expect(await claimAlert()).toEqual({
      status: "emit",
      reason: "deduplication_unavailable",
      error: redisError,
    });
  });

  test("fails toward alert visibility when Redis cannot connect", async () => {
    const redisError = new Error("Redis connection unavailable");
    const send = mock(async () => [1, 300_000]);
    const claimAlert = createSecurityCanaryAlertDeduplicator({
      createRedis: () => ({
        connect: async () => {
          throw redisError;
        },
        send,
      }),
    });

    expect(await claimAlert()).toEqual({
      status: "emit",
      reason: "deduplication_unavailable",
      error: redisError,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
