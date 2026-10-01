import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createRedisClient } from "@/api/lib/redis-client";

import { withActionAdmission } from "./action-admission";
import { resolveActionPeriodBudget } from "./action-period-budget";

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const policy = {
  organizationConcurrency: 20,
  userConcurrency: 20,
  leaseMs: 120_000,
};
const periodPolicy = { periodMs: 86_400_000, limit: 3 };
const userId = toSafeId<"user">("period_user");

const withStore = async (
  run: (store: {
    client: ReturnType<typeof createRedisClient>;
    organizationId: ReturnType<typeof newOrganizationId>;
  }) => Promise<void>,
) => {
  const client = createRedisClient();
  const organizationId = newOrganizationId();
  await client.connect();
  try {
    await run({ client, organizationId });
  } finally {
    client.close();
  }
};
const newOrganizationId = () =>
  toSafeId<"organization">(`period_${Bun.randomUUIDv7()}`);

if (!runValkeyTests || !process.env["REDIS_URL"]) {
  describe.skip("periodic action admission (valkey)", () => {
    test("requires Valkey", () => {});
  });
} else {
  describe("periodic action admission (valkey)", () => {
    test("atomically caps concurrent distinct phases and lets replays count once", async () => {
      await withStore(async ({ client, organizationId }) => {
        let ran = 0;
        const admit = async (logicalPhaseId: string) =>
          await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            policy,
            periodPolicy,
            periodIdentity: {
              actionKind: "chat.improve-prompt",
              logicalPhaseId,
            },
            redis: client,
            run: async () => {
              ran += 1;
            },
          });
        const attempts = await Promise.all(
          Array.from(
            { length: 8 },
            async (_, index) => await admit(`phase-${index}`),
          ),
        );
        expect(attempts.filter(Result.isOk)).toHaveLength(periodPolicy.limit);
        expect(ran).toBe(periodPolicy.limit);
        const accepted = attempts.findIndex(Result.isOk);
        expect(Result.isOk(await admit(`phase-${accepted}`))).toBe(true);
        const resolved = resolveActionPeriodBudget({
          organizationId,
          identity: {
            actionKind: "chat.improve-prompt",
            logicalPhaseId: `phase-${accepted}`,
          },
          policy: periodPolicy,
          nowMs: Date.now(),
        });
        if (Result.isError(resolved) || resolved.value === null) {
          throw new Error("Missing budget");
        }
        expect(await client.send("HGET", [resolved.value.key, "count"])).toBe(
          String(periodPolicy.limit),
        );
        expect(await client.send("HLEN", [resolved.value.key])).toBe(
          periodPolicy.limit + 1,
        );
        const ttl = await client.send("PTTL", [resolved.value.key]);
        expect(typeof ttl).toBe("number");
        if (typeof ttl === "number") {
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(
            resolved.value.endMs - Date.now() + 1000,
          );
        }
        // A separate canonical kind has its own count, independent of provider selection.
        expect(
          Result.isOk(
            await withActionAdmission({
              organizationId,
              userId,
              enabled: true,
              policy,
              periodPolicy,
              periodIdentity: {
                actionKind: "chat.suggest-thread-title",
                logicalPhaseId: "run",
              },
              redis: client,
              run: async () => "ok",
            }),
          ),
        ).toBe(true);
      });
    });

    test("acquisition delayed across the UTC boundary retries into the store's current period", async () => {
      await withStore(async ({ client, organizationId }) => {
        const acquisitions: string[][] = [];
        let acceptedCount: unknown;
        let acceptedFields: unknown;
        const result = await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          periodPolicy: { periodMs: 86_400_000, limit: 1 },
          periodIdentity: {
            actionKind: "chat.improve-prompt",
            logicalPhaseId: "delayed-phase",
          },
          redis: {
            send: async (command, args) => {
              if (!args.at(0)?.includes("ZREMRANGEBYSCORE")) {
                return await client.send(command, args);
              }
              if (acquisitions.length === 0) {
                const clock = await client.send("TIME", []);
                if (!Array.isArray(clock)) {
                  throw new TypeError("Missing store clock");
                }
                // Deliver yesterday's planned window to the real atomic script;
                // no wall-clock sleep or sub-second expiry race is needed.
                const stale = resolveActionPeriodBudget({
                  organizationId,
                  identity: {
                    actionKind: "chat.improve-prompt",
                    logicalPhaseId: "delayed-phase",
                  },
                  policy: { periodMs: 86_400_000, limit: 1 },
                  nowMs: Number(clock.at(0)) * 1000 - 86_400_000,
                });
                if (Result.isError(stale) || stale.value === null) {
                  throw new Error("Missing stale budget");
                }
                args[4] = stale.value.key;
                args[9] = String(stale.value.startMs);
                args[10] = String(stale.value.endMs);
              }
              acquisitions.push([...args]);
              const reply = await client.send(command, args);
              if (acquisitions.length === 2) {
                const key = args.at(4);
                if (!key) {
                  throw new Error("Missing retry period key");
                }
                acceptedCount = await client.send("HGET", [key, "count"]);
                acceptedFields = await client.send("HLEN", [key]);
              }
              return reply;
            },
          },
          run: async () => "accepted in current period",
        });
        expect(result).toEqual(Result.ok("accepted in current period"));
        expect(acquisitions).toHaveLength(2);
        expect(acceptedCount).toBe("1");
        // One phase member, plus the count field.
        expect(acceptedFields).toBe(2);
        const first = acquisitions.at(0);
        const second = acquisitions.at(1);
        expect(Number(second?.at(9))).toBeGreaterThanOrEqual(
          Number(first?.at(10)),
        );
        expect(second?.at(8)).toBe(first?.at(8));
        expect(second?.at(12)).toBe(first?.at(12));
        const oldKey = first?.at(4);
        if (!oldKey) {
          throw new Error("Missing old period key");
        }
        expect(await client.send("EXISTS", [oldKey])).toBe(0);
      });
    });

    test("renewal reads the same reservation and never increments its count", async () => {
      await withStore(async ({ client, organizationId }) => {
        const { promise: renewed, resolve: finishRenewal } =
          Promise.withResolvers<undefined>();
        let trigger: (() => void) | undefined;
        let renewals = 0;
        let budgetKey: string | undefined;
        const result = await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          periodPolicy,
          periodIdentity: {
            actionKind: "chat.improve-prompt",
            logicalPhaseId: "renewed-phase",
          },
          timing: {
            now: () => performance.now(),
            schedule: (callback) => {
              trigger = callback;
              return () => {
                trigger = undefined;
              };
            },
          },
          redis: {
            send: async (command, args) => {
              if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
                budgetKey = args.at(4);
              }
              const response = await client.send(command, args);
              if (args.at(0)?.includes("ZSCORE")) {
                renewals += 1;
                finishRenewal(undefined);
              }
              return response;
            },
          },
          run: async (signal) => {
            if (!trigger) {
              throw new Error("Renewal not scheduled");
            }
            trigger();
            await renewed;
            signal.throwIfAborted();
          },
        });
        expect(Result.isOk(result)).toBe(true);
        expect(renewals).toBe(1);
        if (!budgetKey) {
          throw new Error("Missing period key");
        }
        expect(await client.send("HGET", [budgetKey, "count"])).toBe("1");
      });
    });

    test("an admitted action continues across its period boundary without recounting", async () => {
      await withStore(async ({ client, organizationId }) => {
        const { promise: renewed, resolve: finishRenewal } =
          Promise.withResolvers<undefined>();
        let trigger: (() => void) | undefined;
        let endMs = 0;
        let budgetKey: string | undefined;
        const result = await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          periodPolicy: { periodMs: 2000, limit: 1 },
          periodIdentity: {
            actionKind: "chat.improve-prompt",
            logicalPhaseId: "cross-boundary-phase",
          },
          timing: {
            now: () => performance.now(),
            schedule: (callback) => {
              trigger = callback;
              return () => {
                trigger = undefined;
              };
            },
          },
          redis: {
            send: async (command, args) => {
              if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
                endMs = Number(args.at(10));
                budgetKey = args.at(4);
              }
              const response = await client.send(command, args);
              if (args.at(0)?.includes("ZSCORE")) {
                finishRenewal(undefined);
              }
              return response;
            },
          },
          run: async (signal) => {
            await Bun.sleep(Math.max(0, endMs - Date.now()) + 20);
            if (!trigger) {
              throw new Error("Renewal not scheduled");
            }
            trigger();
            await renewed;
            signal.throwIfAborted();
            return "completed across rollover";
          },
        });
        expect(result).toEqual(Result.ok("completed across rollover"));
        if (!budgetKey) {
          throw new Error("Missing period key");
        }
        // Expiry is final: renewal must neither extend the TTL nor recreate the hash.
        expect(await client.send("EXISTS", [budgetKey])).toBe(0);
        const nextPeriod = resolveActionPeriodBudget({
          organizationId,
          identity: {
            actionKind: "chat.improve-prompt",
            logicalPhaseId: "cross-boundary-phase",
          },
          policy: { periodMs: 2000, limit: 1 },
          nowMs: Date.now(),
        });
        if (Result.isError(nextPeriod) || nextPeriod.value === null) {
          throw new Error("Missing next period");
        }
        expect(await client.send("EXISTS", [nextPeriod.value.key])).toBe(0);
      });
    });

    test("concurrency rejection does not consume a period action", async () => {
      await withStore(async ({ client, organizationId }) => {
        const { promise: entered, resolve: enter } =
          Promise.withResolvers<undefined>();
        const { promise: finish, resolve: complete } =
          Promise.withResolvers<undefined>();
        const singlePolicy = {
          organizationConcurrency: 1,
          userConcurrency: 1,
          leaseMs: 120_000,
        };
        const first = withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy: singlePolicy,
          periodPolicy,
          periodIdentity: {
            actionKind: "chat.improve-prompt",
            logicalPhaseId: "first",
          },
          redis: client,
          run: async () => {
            enter(undefined);
            await finish;
          },
        });
        await entered;
        try {
          const refused = await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            policy: singlePolicy,
            periodPolicy,
            periodIdentity: {
              actionKind: "chat.improve-prompt",
              logicalPhaseId: "refused",
            },
            redis: client,
            run: async () => {
              throw new Error("Must not execute");
            },
          });
          expect(Result.isError(refused)).toBe(true);
          const resolved = resolveActionPeriodBudget({
            organizationId,
            identity: {
              actionKind: "chat.improve-prompt",
              logicalPhaseId: "refused",
            },
            policy: periodPolicy,
            nowMs: Date.now(),
          });
          if (Result.isError(resolved) || resolved.value === null) {
            throw new Error("Missing budget");
          }
          expect(await client.send("HGET", [resolved.value.key, "count"])).toBe(
            "1",
          );
          expect(
            await client.send("HEXISTS", [
              resolved.value.key,
              resolved.value.phaseField,
            ]),
          ).toBe(0);
        } finally {
          complete(undefined);
          await first;
        }
      });
    });
  });
}
