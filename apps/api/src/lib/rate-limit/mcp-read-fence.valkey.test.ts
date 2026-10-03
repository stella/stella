import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { Temporal } from "@stll/time";

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

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
if (!runValkeyTests || !process.env["REDIS_URL"]) {
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
    const client = createRedisClient({ storeClass: "cache" });
    const organizationId = organization();
    const userId = user();
    await client.connect();
    try {
      await run({
        client,
        organizationId,
        userId,
        charge: async (options = {}) =>
          await chargeMcpReadBytes({
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

  type DelayedChargeOptions = {
    client: ReturnType<typeof createRedisClient>;
    organizationId: ReturnType<typeof organization>;
    userId: ReturnType<typeof user>;
    beforeCancel?: (args: string[]) => Promise<void>;
  };
  const delayedCharge = async ({
    client,
    organizationId,
    userId,
    beforeCancel,
  }: DelayedChargeOptions) => {
    const pending = Promise.withResolvers<unknown>();
    const sent = Promise.withResolvers<string[]>();
    let first = true;
    const outcome = await chargeMcpReadBytes({
      organizationId,
      userId,
      bytes: 17,
      readClass: "both",
      policy,
      enabled: true,
      redis: {
        send: async (command, args) => {
          if (first) {
            first = false;
            sent.resolve(args);
            return await pending.promise;
          }
          const charge = await sent.promise;
          await beforeCancel?.(charge);
          const reply: unknown = await client.send(command, args);
          return reply;
        },
      },
    });
    pending.resolve(-1);
    expect(Result.isError(outcome)).toBe(true);
    if (Result.isError(outcome)) {
      expect(outcome.error.reason).toBe("unavailable");
    }
    const charge = await sent.promise;
    const count = Number(charge.at(1));
    return {
      charge,
      counters: charge.slice(2, count + 1),
      tombstone: charge.at(count + 1) ?? panic("Missing cancellation key"),
      deadlineIndex: count + 6,
    };
  };

  const expectEmptyCounters = async (
    client: ReturnType<typeof createRedisClient>,
    counters: string[],
  ) => {
    for (const counter of counters) {
      expect(await client.send("ZCARD", [counter])).toBe(0);
    }
  };

  describe("shared read windows (Valkey)", () => {
    test("late execution after the deadline leaves every window unchanged", async () =>
      fixture(async ({ client, organizationId, userId }) => {
        const delayed = await delayedCharge({ client, organizationId, userId });
        await client.send("DEL", [delayed.tombstone]);
        expect(await client.send("EVAL", delayed.charge)).toBe(-1);
        await expectEmptyCounters(client, delayed.counters);
      }));

    test("cancellation before a delayed charge prevents it even before the deadline", async () =>
      fixture(async ({ client, organizationId, userId }) => {
        const delayed = await delayedCharge({ client, organizationId, userId });
        delayed.charge[delayed.deadlineIndex] = String(
          Temporal.Now.instant().epochMilliseconds + 200,
        );
        expect(await client.send("EXISTS", [delayed.tombstone])).toBe(1);
        expect(await client.send("EVAL", delayed.charge)).toBe(-1);
        await expectEmptyCounters(client, delayed.counters);
      }));

    test("cancellation after an acknowledged late charge removes all four entries", async () =>
      fixture(async ({ client, organizationId, userId }) => {
        const delayed = await delayedCharge({
          client,
          organizationId,
          userId,
          beforeCancel: async (args) => {
            const count = Number(args.at(1));
            args[count + 6] = String(
              Temporal.Now.instant().epochMilliseconds + 200,
            );
            expect(await client.send("EVAL", args)).toBe(1);
            for (const counter of args.slice(2, count + 1)) {
              expect(await client.send("ZCARD", [counter])).toBe(1);
            }
          },
        });
        await expectEmptyCounters(client, delayed.counters);
      }));

    test("cancellation tombstones have a bounded expiry and do not recreate charges", async () =>
      fixture(async ({ client, organizationId, userId }) => {
        const delayed = await delayedCharge({ client, organizationId, userId });
        const ttl: unknown = await client.send("PTTL", [delayed.tombstone]);
        if (typeof ttl !== "number") {
          panic("Unexpected tombstone TTL");
        }
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(500);
        await Bun.sleep(ttl + 20);
        expect(await client.send("EXISTS", [delayed.tombstone])).toBe(0);
        expect(await client.send("EVAL", delayed.charge)).toBe(-1);
        await expectEmptyCounters(client, delayed.counters);
      }));
    test("concurrent extraction never emits more than either byte bound", async () =>
      fixture(async ({ charge }) => {
        const outcomes = await Promise.all(
          Array.from({ length: 19 }, async () => await charge()),
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
          keys.map(async (counter) => {
            const reply: unknown = await client.send("ZRANGE", [
              counter,
              "0",
              "-1",
              "WITHSCORES",
            ]);
            return reply;
          }),
        );
        expect(
          Result.isError(await charge({ bytes: 1, readClass: "both" })),
        ).toBe(true);
        const after = await Promise.all(
          keys.map(async (counter) => {
            const reply: unknown = await client.send("ZRANGE", [
              counter,
              "0",
              "-1",
              "WITHSCORES",
            ]);
            return reply;
          }),
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
            Array.from({ length: 17 }, async () => await charge({ bytes })),
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
