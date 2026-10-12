import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";

import { ORGANIZATION_ACCESS_STATE } from "@/api/db/schema";
import {
  createAdmissionRedis,
  type AdmissionRedisClient,
} from "@/api/lib/admission-redis";
import { toSafeId } from "@/api/lib/branded-types";
import type { AdmittedActionIdentity } from "@/api/lib/rate-limit/action-kinds";
import { startExecutionAdmission } from "@/api/lib/rate-limit/execution-admission";
import { createRedisClient } from "@/api/lib/redis-client";
import { FREE_TIER_OFF } from "@/api/lib/usage/organization-access";
import type { OrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";
import {
  FREE_TIER_PERIOD_SCOPE,
  ORGANIZATION_MODEL_CREDENTIALS,
  type OrganizationActionState,
} from "@/api/lib/usage/organization-action-budget";
import { testOrganizationStateDb } from "@/api/tests/helpers/model-dispatch-admission";

import { withActionAdmission } from "./action-admission";
import {
  ACTION_SERVICE_DEADLINE_EXPIRED,
  PER_KIND_PERIOD_SCOPE,
  resolveActionPeriodBudget,
  staleActionPeriodTime,
} from "./action-period-budget";

const actionState = (
  snapshot: OrganizationAccessSnapshot | undefined,
): OrganizationActionState => ({
  snapshot,
  freeTier: FREE_TIER_OFF,
  modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
});

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
    admissionClient: AdmissionRedisClient;
    organizationId: ReturnType<typeof newOrganizationId>;
  }) => Promise<void>,
) => {
  const client = createRedisClient({ storeClass: "cache" });
  const organizationId = newOrganizationId();
  await client.connect();
  const admission = createAdmissionRedis({
    ready: async () => client,
    close: () => client.close(),
  });
  try {
    const admissionClient = (await admission.ready()).unwrap();
    await run({ client, admissionClient, organizationId });
  } finally {
    admission.close();
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
    for (const timing of ["active", "delayed", "stale-retry"] as const) {
      test(`deferred evaluation reservation ${timing} admits provider work only before expiry`, async () => {
        await withStore(async ({ client, organizationId }) => {
          const clock = await client.send("TIME", []);
          if (!Array.isArray(clock)) {
            throw new TypeError("Missing store clock");
          }
          const storeNow = Number(clock.at(0)) * 1000;
          const staleRetry = timing === "stale-retry";
          const expired = timing !== "active";
          const deadline = {
            active: storeNow + 60_000,
            delayed: storeNow - 1,
            "stale-retry": storeNow + 1,
          }[timing];
          const reservations: string[][] = [];
          const replies: unknown[] = [];
          let concurrencyAcquisitions = 0;
          let stateReads = 0;
          let providerCalls = 0;
          const result = await withActionAdmission({
            mode: "concurrency-only",
            organizationId,
            userId,
            enabled: true,
            policy,
            costRecorder: null,
            serviceBudgetsEnabled: true,
            serviceBudgetConfig: {
              periodMs: 86_400_000,
              evaluationActions: 3,
              selfManagedActions: 5,
            },
            budgetNow: () =>
              staleRetry
                ? storeNow - 86_400_000
                : Math.min(storeNow, deadline - 1),
            readOrganizationState: async () => {
              stateReads += 1;
              return actionState({
                state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
                evaluationEndsAt: new Date(deadline),
              });
            },
            redis: {
              send: async (command, args) => {
                if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
                  concurrencyAcquisitions += 1;
                }
                if (args.at(1) !== "3") {
                  return await client.send(command, args);
                }
                const script = args.at(0);
                if (script === undefined) {
                  throw new TypeError("Missing reservation script");
                }
                expect(script).toContain(
                  'redis.call("ZSCORE", KEYS[1], ARGV[4])',
                );
                // Execute the production Lua in Valkey. Only the stale case's
                // clock is fixed to cross expiry exactly between two attempts.
                const now = reservations.length === 0 ? storeNow : deadline;
                const clockLiteral = `{${Math.floor(now / 1000)}, ${(now % 1000) * 1000}}`;
                const clockedScript = staleRetry
                  ? script.replace('redis.call("TIME")', () => clockLiteral)
                  : script;
                reservations.push([...args]);
                const reply = await client.send(command, [
                  clockedScript,
                  ...args.slice(1),
                ]);
                replies.push(reply);
                return reply;
              },
            },
            run: async (_signal, control) => {
              expect(stateReads).toBe(0);
              const reserved = await control.reservePeriod({
                actionKind: "chat.send",
                logicalPhaseId: JSON.stringify(["owned-turn", "phase-run"]),
              });
              if (Result.isOk(reserved)) {
                providerCalls += 1;
              }
              return reserved;
            },
          });
          expect(Result.isOk(result)).toBe(true);
          if (Result.isError(result)) {
            throw result.error;
          }
          expect(Result.isError(result.value)).toBe(expired);
          if (Result.isError(result.value)) {
            expect(result.value.error.code).toBe(
              ACTION_ADMISSION_CODES.notEnabled,
            );
          }
          expect(providerCalls).toBe(expired ? 0 : 1);
          expect(stateReads).toBe(1);
          expect(concurrencyAcquisitions).toBe(1);
          expect(reservations).toHaveLength(staleRetry ? 2 : 1);
          for (const reservation of reservations) {
            expect(reservation.at(13)).toBe(String(deadline));
            expect(await client.send("EXISTS", reservation.slice(4, 5))).toBe(
              expired ? 0 : 1,
            );
          }
          expect(replies.at(-1)).toBe(
            expired ? ACTION_SERVICE_DEADLINE_EXPIRED : 1,
          );
          if (staleRetry) {
            expect(staleActionPeriodTime(replies.at(0))).toBe(storeNow);
            expect(reservations.at(1)?.at(9)).not.toBe(
              reservations.at(0)?.at(9),
            );
          }
        });
      });
    }

    test("atomic Lua fences delayed evaluation expiry and stale retries before mutation", async () => {
      for (const staleRetry of [false, true]) {
        await withStore(async ({ client, organizationId }) => {
          const clock = await client.send("TIME", []);
          if (!Array.isArray(clock)) {
            throw new TypeError("Missing store clock");
          }
          const storeNow = Number(clock.at(0)) * 1000;
          const deadline = staleRetry ? storeNow + 1 : storeNow - 1;
          const acquisitions: string[][] = [];
          let runs = 0;
          const result = await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            policy,
            serviceBudgetsEnabled: true,
            serviceBudgetConfig: {
              periodMs: 86_400_000,
              evaluationActions: 3,
              selfManagedActions: 5,
            },
            budgetNow: () =>
              staleRetry ? storeNow - 86_400_000 : deadline - 1,
            readOrganizationState: async () =>
              actionState({
                state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
                evaluationEndsAt: new Date(deadline),
              }),
            periodIdentity: {
              actionKind: "chat.improve-prompt",
              logicalPhaseId: "expired-phase",
            },
            redis: {
              send: async (command, args) => {
                const script = args.at(0);
                if (script === undefined) {
                  throw new Error("Missing acquisition script");
                }
                // The same-period case uses real Redis time. The stale case
                // fixes only the production script's clock to cross exact expiry
                // deterministically between attempts, without wall-clock sleeps.
                const now = acquisitions.length === 0 ? storeNow : deadline;
                const clockLiteral = `{${Math.floor(now / 1000)}, ${(now % 1000) * 1000}}`;
                expect(script).toContain('redis.call("TIME")');
                const clockedScript = staleRetry
                  ? script.replace('redis.call("TIME")', () => clockLiteral)
                  : script;
                acquisitions.push([...args]);
                return await client.send(command, [
                  clockedScript,
                  ...args.slice(1),
                ]);
              },
            },
            run: async () => {
              runs += 1;
            },
          });
          expect(Result.isError(result)).toBe(true);
          if (Result.isError(result)) {
            expect(result.error).toMatchObject({
              code: ACTION_ADMISSION_CODES.notEnabled,
            });
          }
          expect(runs).toBe(0);
          expect(acquisitions).toHaveLength(staleRetry ? 2 : 1);
          for (const acquire of acquisitions) {
            expect(acquire.at(13)).toBe(String(deadline));
            expect(await client.send("EXISTS", acquire.slice(2, 5))).toBe(0);
          }
          if (staleRetry) {
            expect(acquisitions.at(1)?.at(9)).not.toBe(
              acquisitions.at(0)?.at(9),
            );
          }
        });
      }
    });

    test("same-run replays reserve once while a fresh turn using an old run id counts anew", async () => {
      await withStore(async ({ client, organizationId }) => {
        let budgetKey: string | undefined;
        let acquisitions = 0;
        const admit: typeof withActionAdmission = async (options) =>
          await withActionAdmission({
            ...options,
            policy,
            periodPolicy: { periodMs: 86_400_000, limit: 2 },
            redis: {
              send: async (command, args) => {
                if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
                  acquisitions += 1;
                }
                if (args.at(1) === "3") {
                  budgetKey = args.at(4);
                }
                return await client.send(command, args);
              },
            },
          });
        for (const [index, turn] of [
          "original-turn",
          "original-turn",
          "new-turn",
          "refused-turn",
        ].entries()) {
          const phase = await startExecutionAdmission({
            organizationStateDb: testOrganizationStateDb,
            mode: "concurrency-only",
            actionKind: "chat.send",
            enabled: true,
            organizationId,
            userId,
            admit,
          });
          if (Result.isError(phase)) {
            panic("Expected chat phase admission");
          }
          try {
            const reserved = await phase.value.reservePeriod({
              actionKind: "chat.send",
              logicalPhaseId: JSON.stringify([turn, "old-run"]),
            });
            expect(Result.isOk(reserved)).toBe(index < 3);
            if (Result.isError(reserved)) {
              expect(reserved.error).toMatchObject({
                status: 403,
                code: ACTION_ADMISSION_CODES.periodExhausted,
                retryable: false,
              });
            }
            if (!budgetKey) {
              panic("Missing period key");
            }
            expect(await client.send("HGET", [budgetKey, "count"])).toBe(
              index < 2 ? "1" : "2",
            );
            expect(acquisitions).toBe(index + 1);
          } finally {
            await phase.value.release();
          }
        }
      });
    });

    test("a first-message phase and its detached title consume one period action", async () => {
      await withStore(async ({ client, organizationId }) => {
        const firstMessageIdentity = {
          actionKind: "chat.send",
          logicalPhaseId: "first-message-phase",
        } as const satisfies AdmittedActionIdentity;
        const singleActionPeriod = { periodMs: 86_400_000, limit: 1 };
        let budgetKey: string | undefined;
        let acquisitions = 0;
        const admit: typeof withActionAdmission = async (options) =>
          await withActionAdmission({
            ...options,
            policy,
            periodPolicy: singleActionPeriod,
            redis: {
              send: async (command, args) => {
                if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
                  acquisitions += 1;
                }
                if (args.at(1) === "3") {
                  budgetKey ??= args.at(4);
                }
                return await client.send(command, args);
              },
            },
          });
        const phase = await startExecutionAdmission({
          organizationStateDb: testOrganizationStateDb,
          organizationId,
          userId,
          enabled: true,
          mode: "concurrency-only",
          actionKind: "chat.send",
          admit,
        });
        if (Result.isError(phase)) {
          panic("Expected chat phase admission");
        }
        try {
          expect(
            Result.isOk(await phase.value.reservePeriod(firstMessageIdentity)),
          ).toBe(true);
          expect(
            Result.isOk(await phase.value.reservePeriod(firstMessageIdentity)),
          ).toBe(true);
          const title = await startExecutionAdmission({
            organizationStateDb: testOrganizationStateDb,
            organizationId,
            userId,
            enabled: true,
            mode: "concurrency-only",
            actionKind: "chat.generate-thread-title",
            admit,
          });
          if (Result.isError(title)) {
            panic("Expected detached title admission");
          }
          try {
            expect(acquisitions).toBe(2);
            expect(phase.value.signal.aborted).toBe(false);
            expect(title.value.signal.aborted).toBe(false);
            if (!budgetKey) {
              panic("Missing period key");
            }
            expect(await client.send("HGET", [budgetKey, "count"])).toBe("1");
            expect(await client.send("HLEN", [budgetKey])).toBe(2);
          } finally {
            await title.value.release();
          }
        } finally {
          await phase.value.release();
        }
      });
    });

    test("the free floor caps every kind together in one period count", async () => {
      await withStore(async ({ client, admissionClient, organizationId }) => {
        const freeActions = 3;
        const kinds = [
          "chat.send",
          "chat.improve-prompt",
          "workflow.start",
        ] as const;
        let ran = 0;
        const admit = async (
          actionKind: (typeof kinds)[number],
          logicalPhaseId: string,
        ) =>
          await withActionAdmission({
            organizationId,
            userId,
            enabled: true,
            policy,
            costRecorder: null,
            serviceBudgetsEnabled: true,
            serviceBudgetConfig: {
              periodMs: 86_400_000,
              evaluationActions: 7,
              selfManagedActions: 7,
            },
            periodIdentity: { actionKind, logicalPhaseId },
            readOrganizationState: async () => ({
              snapshot: {
                state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
                evaluationEndsAt: new Date(Date.now() - 1),
              },
              freeTier: {
                status: "on",
                policy: { serviceActionsPerPeriod: freeActions },
              },
              modelCredentials: ORGANIZATION_MODEL_CREDENTIALS.managed,
            }),
            redis: admissionClient,
            run: async () => {
              ran += 1;
            },
          });
        // One phase id under each kind: distinct actions, one shared count.
        for (const kind of kinds) {
          expect(Result.isOk(await admit(kind, "shared-phase"))).toBe(true);
        }
        expect(Result.isOk(await admit("chat.send", "shared-phase"))).toBe(
          true,
        );
        const refused = await admit("chat.improve-prompt", "next-phase");
        expect(Result.isError(refused)).toBe(true);
        if (Result.isError(refused)) {
          expect(refused.error).toMatchObject({
            code: ACTION_ADMISSION_CODES.periodExhausted,
          });
        }
        expect(ran).toBe(freeActions + 1);
        const pooled = resolveActionPeriodBudget({
          organizationId,
          identity: { actionKind: "chat.send", logicalPhaseId: "shared-phase" },
          policy: { periodMs: 86_400_000, limit: freeActions },
          scope: FREE_TIER_PERIOD_SCOPE,
          nowMs: Date.now(),
        });
        if (Result.isError(pooled) || pooled.value === null) {
          throw new Error("Missing pooled budget");
        }
        expect(await client.send("HGET", [pooled.value.key, "count"])).toBe(
          String(freeActions),
        );
      });
    });

    test("atomically caps concurrent distinct phases and lets replays count once", async () => {
      await withStore(async ({ client, admissionClient, organizationId }) => {
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
            redis: admissionClient,
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
          scope: PER_KIND_PERIOD_SCOPE,
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
              redis: admissionClient,
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
                  scope: PER_KIND_PERIOD_SCOPE,
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

    test("an admitted chat phase continues across its period boundary without recounting", async () => {
      await withStore(async ({ client, organizationId }) => {
        const { promise: renewed, resolve: finishRenewal } =
          Promise.withResolvers<undefined>();
        let trigger: (() => void) | undefined;
        let endMs = 0;
        let budgetKey: string | undefined;
        const result = await startExecutionAdmission({
          organizationStateDb: testOrganizationStateDb,
          organizationId,
          userId,
          enabled: true,
          mode: "concurrency-only",
          actionKind: "chat.send",
          admit: async (options) =>
            await withActionAdmission({
              ...options,
              policy,
              periodPolicy: { periodMs: 2000, limit: 1 },
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
                  if (args.at(1) === "3") {
                    endMs = Number(args.at(10));
                    budgetKey = args.at(4);
                  }
                  const response = await client.send(command, args);
                  if (
                    args.at(0)?.includes("ZSCORE") &&
                    !args.at(0)?.includes("HEXISTS")
                  ) {
                    finishRenewal(undefined);
                  }
                  return response;
                },
              },
            }),
        });
        if (Result.isError(result)) {
          panic("Expected chat phase admission");
        }
        try {
          expect(
            Result.isOk(
              await result.value.reservePeriod({
                actionKind: "chat.send",
                logicalPhaseId: "cross-boundary-phase",
              }),
            ),
          ).toBe(true);
          await Bun.sleep(Math.max(0, endMs - Date.now()) + 20);
          if (!trigger) {
            panic("Renewal not scheduled");
          }
          trigger();
          await renewed;
          expect(result.value.signal.aborted).toBe(false);
        } finally {
          await result.value.release();
        }
        if (!budgetKey) {
          panic("Missing period key");
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
          scope: PER_KIND_PERIOD_SCOPE,
          nowMs: Date.now(),
        });
        if (Result.isError(nextPeriod) || nextPeriod.value === null) {
          throw new Error("Missing next period");
        }
        expect(await client.send("EXISTS", [nextPeriod.value.key])).toBe(0);
      });
    });

    test("concurrency rejection does not consume a period action", async () => {
      await withStore(async ({ client, admissionClient, organizationId }) => {
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
          redis: admissionClient,
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
            redis: admissionClient,
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
            scope: PER_KIND_PERIOD_SCOPE,
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

    test("organization and user lease caps independently reject contenders in the store", async () => {
      for (const limiting of ["organization", "user"] as const) {
        await withStore(async ({ admissionClient, organizationId }) => {
          const { promise: entered, resolve: enter } =
            Promise.withResolvers<undefined>();
          const { promise: finish, resolve: complete } =
            Promise.withResolvers<undefined>();
          const contenderUser =
            limiting === "organization"
              ? toSafeId<"user">("independent_user")
              : userId;
          const asymmetricPolicy = {
            organizationConcurrency: limiting === "organization" ? 1 : 2,
            userConcurrency: limiting === "user" ? 1 : 2,
            leaseMs: 120_000,
          };
          const common = {
            organizationId,
            enabled: true,
            policy: asymmetricPolicy,
            periodPolicy: { periodMs: 86_400_000, limit: 10 },
            serviceBudgetsEnabled: false,
            redis: admissionClient,
          };
          const owner = withActionAdmission({
            ...common,
            userId,
            periodIdentity: {
              actionKind: "chat.improve-prompt",
              logicalPhaseId: "owner",
            },
            run: async () => {
              enter(undefined);
              await finish;
              return "owner-completed";
            },
          });
          await entered;
          let ran = false;
          try {
            const contender = await withActionAdmission({
              ...common,
              userId: contenderUser,
              periodIdentity: {
                actionKind: "chat.improve-prompt",
                logicalPhaseId: "contender",
              },
              run: async () => {
                ran = true;
              },
            });
            expect(Result.isError(contender)).toBe(true);
            if (Result.isError(contender)) {
              expect(contender.error).toMatchObject({
                reason: "busy",
                code: ACTION_ADMISSION_CODES.concurrencyBusy,
              });
            }
            expect(ran).toBe(false);
          } finally {
            complete(undefined);
            expect(await owner).toEqual(Result.ok("owner-completed"));
          }

          const afterRelease = await withActionAdmission({
            ...common,
            userId: contenderUser,
            periodIdentity: {
              actionKind: "chat.improve-prompt",
              logicalPhaseId: "after-release",
            },
            run: async () => "admitted",
          });
          expect(afterRelease).toEqual(Result.ok("admitted"));
        });
      }
    });
  });
}
