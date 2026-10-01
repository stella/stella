import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  chargeMcpReadBytes,
  type McpReadFencePolicy,
} from "@/api/lib/rate-limit/mcp-read-fence";
import { createRedisClient } from "@/api/lib/redis-client";
import { coordinationKey } from "@/api/lib/redis-keys";
import type { McpReadClass } from "@/api/mcp/tool-types";

const policy = {
  windowMs: 93_017,
  maxEntries: 13,
  tenant: { organizationBytes: 79, userBytes: 53 },
  public: { organizationBytes: 157, userBytes: 113 },
} satisfies McpReadFencePolicy;

if (
  process.env["STELLA_RUN_VALKEY_TESTS"] !== "true" ||
  !process.env["REDIS_URL"]
) {
  describe.skip("shared read windows (Valkey)", () => {
    test("requires Valkey", () => {});
  });
} else {
  const fixture = async (
    run: (state: {
      client: ReturnType<typeof createRedisClient>;
      organizationId: ReturnType<typeof organization>;
      userId: ReturnType<typeof user>;
      charge: (options?: {
        bytes?: number;
        readClass?: McpReadClass;
        organizationId?: ReturnType<typeof organization>;
        userId?: ReturnType<typeof user>;
        policy?: McpReadFencePolicy;
      }) => ReturnType<typeof chargeMcpReadBytes>;
    }) => Promise<void>,
  ) => {
    const client = createRedisClient();
    const organizationId = organization();
    const userId = user();
    await client.connect();
    try {
      await run({
        client,
        organizationId,
        userId,
        charge: (options = {}) =>
          chargeMcpReadBytes({
            organizationId,
            userId,
            bytes: 17,
            readClass: "tenant",
            policy,
            enabled: true,
            redis: client,
            ...options,
          }),
      });
    } finally {
      client.close();
    }
  };
  const organization = () =>
    toSafeId<"organization">(`read_org_${Bun.randomUUIDv7()}`);
  const user = () => toSafeId<"user">(`read_user_${Bun.randomUUIDv7()}`);
  const key = (
    organizationId: ReturnType<typeof organization>,
    suffix: string,
  ) =>
    coordinationKey({ scope: "mcp-read-fence", slot: organizationId, suffix });

  describe("shared read windows (Valkey)", () => {
    test("concurrent extraction never emits more than either byte bound", async () =>
      fixture(async ({ charge }) => {
        const outcomes = await Promise.all(
          Array.from({ length: 19 }, () => charge()),
        );
        expect(outcomes.filter(Result.isOk)).toHaveLength(3);
        expect(outcomes.filter(Result.isError)).toHaveLength(16);
        for (const outcome of outcomes) {
          if (Result.isError(outcome)) {
            expect(outcome.error.reason).toBe("period_exhausted");
          }
        }
      }));

    test("organization aggregates users while each user has a separate window", async () =>
      fixture(async ({ charge }) => {
        expect(Result.isOk(await charge({ bytes: 53 }))).toBe(true);
        expect(Result.isError(await charge({ bytes: 1 }))).toBe(true);
        expect(Result.isOk(await charge({ bytes: 26, userId: user() }))).toBe(
          true,
        );
        expect(Result.isError(await charge({ bytes: 1, userId: user() }))).toBe(
          true,
        );
        expect(
          Result.isOk(
            await charge({ bytes: 53, organizationId: organization() }),
          ),
        ).toBe(true);
      }));

    test("public and tenant counters are independent and mixed refusal writes none", async () =>
      fixture(async ({ charge, client, organizationId, userId }) => {
        expect(Result.isOk(await charge({ bytes: 53 }))).toBe(true);
        expect(
          Result.isOk(await charge({ bytes: 31, readClass: "public" })),
        ).toBe(true);
        const keys = [
          "tenant:organization",
          `tenant:user:${userId}`,
          "public:organization",
          `public:user:${userId}`,
        ].map((suffix) => key(organizationId, suffix));
        const before = await Promise.all(
          keys.map((counter) =>
            client.send("ZRANGE", [counter, "0", "-1", "WITHSCORES"]),
          ),
        );
        expect(
          Result.isError(await charge({ bytes: 1, readClass: "both" })),
        ).toBe(true);
        const after = await Promise.all(
          keys.map((counter) =>
            client.send("ZRANGE", [counter, "0", "-1", "WITHSCORES"]),
          ),
        );
        expect(after).toEqual(before);
        expect(
          Result.isOk(await charge({ bytes: 82, readClass: "public" })),
        ).toBe(true);
      }));

    test("mixed success charges full bytes to every class and identity", async () =>
      fixture(async ({ charge }) => {
        expect(
          Result.isOk(await charge({ bytes: 41, readClass: "both" })),
        ).toBe(true);
        expect(Result.isOk(await charge({ bytes: 12 }))).toBe(true);
        expect(Result.isError(await charge({ bytes: 1 }))).toBe(true);
        expect(
          Result.isOk(await charge({ bytes: 72, readClass: "public" })),
        ).toBe(true);
        expect(
          Result.isError(await charge({ bytes: 1, readClass: "public" })),
        ).toBe(true);
      }));

    test("entry cap refuses tiny outputs and expired entries regain headroom", async () =>
      fixture(async ({ charge, client, organizationId, userId }) => {
        const capped = { ...policy, maxEntries: 2 };
        expect(Result.isOk(await charge({ bytes: 1, policy: capped }))).toBe(
          true,
        );
        expect(Result.isOk(await charge({ bytes: 1, policy: capped }))).toBe(
          true,
        );
        expect(Result.isError(await charge({ bytes: 1, policy: capped }))).toBe(
          true,
        );
        const keys = [
          key(organizationId, "tenant:organization"),
          key(organizationId, `tenant:user:${userId}`),
        ];
        for (const counter of keys) {
          const entries = await client.send("ZRANGE", [counter, "0", "-1"]);
          if (
            !Array.isArray(entries) ||
            entries.some((entry) => typeof entry !== "string")
          ) {
            panic("Unexpected log entries");
          }
          for (const entry of entries) {
            if (typeof entry !== "string") {
              panic("Unexpected log entry");
            }
            await client.send("ZADD", [counter, "0", entry]);
          }
        }
        expect(Result.isOk(await charge({ bytes: 53, policy: capped }))).toBe(
          true,
        );
        for (const counter of keys) {
          expect(await client.send("ZCARD", [counter])).toBe(1);
          const ttl = await client.send("PTTL", [counter]);
          expect(typeof ttl).toBe("number");
          expect(Number(ttl)).toBeGreaterThan(0);
          expect(Number(ttl)).toBeLessThanOrEqual(policy.windowMs);
        }
      }));

    test("public exhaustion refuses mixed output without charging tenant counters", async () =>
      fixture(async ({ charge, client, organizationId }) => {
        expect(
          Result.isOk(await charge({ bytes: 113, readClass: "public" })),
        ).toBe(true);
        expect(
          Result.isError(await charge({ bytes: 1, readClass: "both" })),
        ).toBe(true);
        expect(
          await client.send("ZCARD", [
            key(organizationId, "tenant:organization"),
          ]),
        ).toBe(0);
        expect(Result.isOk(await charge({ bytes: 53 }))).toBe(true);
      }));

    test("accepted output obeys byte and entry bounds over varied output sizes", async () => {
      for (const bytes of [1, 3, 11, 17, 53, 54]) {
        await fixture(async ({ charge }) => {
          const outcomes = await Promise.all(
            Array.from({ length: 17 }, () => charge({ bytes })),
          );
          const accepted = outcomes.filter(Result.isOk).length;
          expect(accepted).toBe(
            Math.min(
              policy.maxEntries,
              Math.floor(policy.tenant.userBytes / bytes),
              Math.floor(policy.tenant.organizationBytes / bytes),
            ),
          );
          expect(accepted * bytes).toBeLessThanOrEqual(policy.tenant.userBytes);
          expect(accepted * bytes).toBeLessThanOrEqual(
            policy.tenant.organizationBytes,
          );
        });
      }
    });

    test("invalid store type fails closed without charging another counter", async () =>
      fixture(async ({ charge, client, organizationId, userId }) => {
        const counter = key(organizationId, `tenant:user:${userId}`);
        await client.send("SET", [
          counter,
          "invalid",
          "PX",
          String(policy.windowMs),
        ]);
        const outcome = await charge();
        if (!Result.isError(outcome)) {
          panic("Expected store refusal");
        }
        expect(outcome.error.reason).toBe("unavailable");
        expect(
          await client.send("ZCARD", [
            key(organizationId, "tenant:organization"),
          ]),
        ).toBe(0);
      }));
  });
}
