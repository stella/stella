import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
} from "@/api/lib/errors/action-admission-error";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createRedisClient } from "@/api/lib/redis-client";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

import {
  ACQUIRE_SCRIPT,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
} from "./concurrency-lease";
import { withMcpPublicReadAdmission } from "./mcp-public-read-admission";

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const caller = () => ({
  organizationId: toSafeId<"organization">(`public_read_${Bun.randomUUIDv7()}`),
  userId: toSafeId<"user">("public_read_user"),
  clientId: "public_read_client",
});
const leased = <T>(value: T) => Result.ok({ status: "leased" as const, value });

const withStore = async (
  run: (
    client: Pick<ReturnType<typeof createRedisClient>, "send">,
  ) => Promise<void>,
) => {
  const client = createRedisClient({ storeClass: "cache" });
  await client.connect();
  try {
    await run({
      send: async (command, args) => await client.send(command, args),
    });
  } finally {
    client.close();
  }
};

const expectBusy = (
  outcome: Awaited<ReturnType<typeof withMcpPublicReadAdmission>>,
) => {
  if (Result.isOk(outcome) || !ActionAdmissionError.is(outcome.error)) {
    panic("Expected a typed concurrency refusal");
  }
  expect(outcome.error.code).toBe("action_concurrency_busy");
  expect(outcome.error.retryAfterMs).toBeGreaterThan(0);
  expect(outcome.error.retryAfterMs).toBeLessThanOrEqual(30_000);
  expect(actionAdmissionRefusal(outcome.error)).toMatchObject({
    code: "action_concurrency_busy",
    retryable: true,
    retryAfterMs: outcome.error.retryAfterMs,
  });
};

if (!runValkeyTests || !process.env["REDIS_URL"]) {
  describe.skip("MCP public-read admission (valkey)", () => {
    test("requires Valkey", () => {});
  });
} else {
  describe("MCP public-read admission (valkey)", () => {
    test("a timed-out acquire releases its landed lease without delaying the read", async () => {
      await withStore(async (client) => {
        const identity = caller();
        const analytics = installRecordingAnalytics();
        const logs = installRecordingLogger();
        const acquireLanded = Promise.withResolvers<{
          key: string;
          leaseId: string;
        }>();
        const acquireReply = Promise.withResolvers<unknown>();
        const cleanupStarted = Promise.withResolvers<string>();
        const allowCleanup = Promise.withResolvers<undefined>();
        const cleanupLanded = Promise.withResolvers<unknown>();
        let cleanupAttempts = 0;
        let cleanupFinished = false;
        const read = withMcpPublicReadAdmission({
          caller: identity,
          limit: 1,
          redis: {
            send: async (command, args) => {
              const script = args.at(0);
              if (script === ACQUIRE_SCRIPT) {
                const key = args.at(2);
                const leaseId = args.at(7);
                if (key === undefined || leaseId === undefined) {
                  panic("Expected the acquired lease identity");
                }
                expect(await client.send(command, args)).toBe(1);
                acquireLanded.resolve({ key, leaseId });
                // The store accepted the command, but its reply never reaches the caller.
                return await acquireReply.promise;
              }
              if (script !== RELEASE_SCRIPT) {
                panic("Expected acquisition cleanup without renewal");
              }
              const leaseId = args.at(4);
              if (leaseId === undefined) {
                panic("Expected the cleanup lease identity");
              }
              cleanupAttempts += 1;
              cleanupStarted.resolve(leaseId);
              await allowCleanup.promise;
              const result = await client.send(command, args);
              cleanupFinished = true;
              cleanupLanded.resolve(result);
              return result;
            },
          },
          run: async () => "read",
        });
        try {
          const { key, leaseId } = await acquireLanded.promise;
          expect(await client.send("ZCARD", [key])).toBe(1);
          expect(await read).toEqual(
            Result.ok({
              status: "degraded",
              degradation: { phase: "acquire", reason: "unavailable" },
              value: "read",
            }),
          );
          expect(cleanupAttempts).toBe(1);
          expect(await cleanupStarted.promise).toBe(leaseId);
          expect(cleanupFinished).toBe(false);
          expect(await client.send("ZCARD", [key])).toBe(1);
          // Awaiting cleanup would exhaust its own command budget before the read returns.
          expect(
            logs.records.filter(
              ({ message }) =>
                message === "mcp.public_read.acquire_cleanup_failed",
            ),
          ).toEqual([]);
          allowCleanup.resolve(undefined);
          expect(await cleanupLanded.promise).toBe(1);
          expect(await client.send("ZCARD", [key])).toBe(0);
          expect(
            await withMcpPublicReadAdmission({
              caller: identity,
              redis: client,
              limit: 1,
              run: async () => "next",
            }),
          ).toEqual(leased("next"));
          expect(cleanupAttempts).toBe(1);
        } finally {
          allowCleanup.resolve(undefined);
          acquireReply.resolve(undefined);
          await read;
          analytics.restore();
          logs.restore();
        }
      });
    });

    test("concurrent reads beyond the caller cap return a retryable refusal", async () => {
      await withStore(async (redis) => {
        const identity = caller();
        const entered = Promise.withResolvers<undefined>();
        const finish = Promise.withResolvers<undefined>();
        let active = 0;
        let refusedRan = false;
        const owners = Array.from(
          { length: 4 },
          async () =>
            await withMcpPublicReadAdmission({
              caller: identity,
              redis,
              limit: 4,
              run: async () => {
                active += 1;
                if (active === 4) {
                  entered.resolve(undefined);
                }
                await finish.promise;
                return "complete";
              },
            }),
        );
        try {
          await entered.promise;
          expectBusy(
            await withMcpPublicReadAdmission({
              caller: identity,
              redis,
              limit: 4,
              run: async () => {
                refusedRan = true;
              },
            }),
          );
          expect(active).toBe(4);
          expect(refusedRan).toBe(false);
        } finally {
          finish.resolve(undefined);
          expect(await Promise.all(owners)).toEqual(
            Array.from({ length: 4 }, () => leased("complete")),
          );
        }
        expect(
          await withMcpPublicReadAdmission({
            caller: identity,
            redis,
            limit: 4,
            run: async () => "next",
          }),
        ).toEqual(leased("next"));
      });
    });

    test("organization, user and OAuth client each isolate a caller pool", async () => {
      await withStore(async (redis) => {
        const identity = caller();
        const entered = Promise.withResolvers<undefined>();
        const finish = Promise.withResolvers<undefined>();
        const owner = withMcpPublicReadAdmission({
          caller: identity,
          redis,
          limit: 1,
          run: async () => {
            entered.resolve(undefined);
            await finish.promise;
          },
        });
        try {
          await entered.promise;
          expectBusy(
            await withMcpPublicReadAdmission({
              caller: identity,
              redis,
              limit: 1,
              run: async () => undefined,
            }),
          );
          const identities = [
            { ...identity, organizationId: caller().organizationId },
            {
              ...identity,
              userId: toSafeId<"user">("another_public_read_user"),
            },
            { ...identity, clientId: "another_public_read_client" },
            { ...identity, clientId: null },
          ];
          const outcomes = await Promise.all(
            identities.map(
              async (distinct) =>
                await withMcpPublicReadAdmission({
                  caller: distinct,
                  redis,
                  limit: 1,
                  run: async () => "independent",
                }),
            ),
          );
          expect(outcomes).toEqual(identities.map(() => leased("independent")));
        } finally {
          finish.resolve(undefined);
          expect(Result.isOk(await owner)).toBe(true);
        }
      });
    });

    for (const outcome of [
      "success",
      "failure",
      "timeout",
      "cancellation",
    ] as const) {
      test(`${outcome} releases the caller slot only after work settles`, async () => {
        await withStore(async (redis) => {
          const identity = caller();
          const entered = Promise.withResolvers<undefined>();
          const finish = Promise.withResolvers<undefined>();
          const controller = new AbortController();
          const failure = new HandlerError({
            status: 503,
            code:
              outcome === "timeout"
                ? "PUBLIC_READ_TIMEOUT"
                : "service_unavailable",
            message:
              outcome === "timeout"
                ? "Public read timed out"
                : "Public read stopped",
          });
          const owner = withMcpPublicReadAdmission({
            caller: identity,
            redis,
            limit: 1,
            signal: controller.signal,
            run: async (signal) => {
              entered.resolve(undefined);
              await finish.promise;
              signal.throwIfAborted();
              if (outcome !== "success") {
                return await Promise.reject(failure);
              }
              return "complete";
            },
          });
          try {
            await entered.promise;
            if (outcome === "cancellation") {
              controller.abort(failure);
            }
            expectBusy(
              await withMcpPublicReadAdmission({
                caller: identity,
                redis,
                limit: 1,
                run: async () => "contender",
              }),
            );
          } finally {
            finish.resolve(undefined);
            expect(await owner).toEqual(
              outcome === "success" ? leased("complete") : Result.err(failure),
            );
          }
          expect(
            await withMcpPublicReadAdmission({
              caller: identity,
              redis,
              limit: 1,
              run: async () => "next",
            }),
          ).toEqual(leased("next"));
        });
      });
    }

    test("renewal retains an active caller slot and stops after settlement", async () => {
      await withStore(async (client) => {
        const identity = caller();
        const entered = Promise.withResolvers<undefined>();
        const finish = Promise.withResolvers<undefined>();
        const rescheduled = Promise.withResolvers<undefined>();
        let scheduled: (() => void) | undefined;
        let schedules = 0;
        let renewals = 0;
        let cancellations = 0;
        let now = 0;
        const clock = await client.send("TIME", []);
        if (!Array.isArray(clock)) {
          panic("Expected the Valkey clock");
        }
        const storeStart =
          Number(clock.at(0)) * 1000 + Math.floor(Number(clock.at(1)) / 1000);
        let leaseKey: string | undefined;
        let leaseId: string | undefined;
        const redis = {
          send: async (command: string, args: string[]) => {
            const script = args.at(0);
            if (script === undefined) {
              panic("Expected an admission script");
            }
            if (script.includes("ZREMRANGEBYSCORE")) {
              leaseKey = args.at(2);
              leaseId = args.at(7);
            }
            const storeNow = storeStart + now;
            const fixedClock = `{${Math.floor(storeNow / 1000)}, ${(storeNow % 1000) * 1000}}`;
            const result = await client.send(command, [
              script.replace('redis.call("TIME")', () => fixedClock),
              ...args.slice(1),
            ]);
            if (script === RENEW_SCRIPT) {
              renewals += 1;
            }
            return result;
          },
        };
        const owner = withMcpPublicReadAdmission({
          caller: identity,
          limit: 1,
          redis,
          timing: {
            now: () => now,
            schedule: (callback, delayMs) => {
              expect(delayMs).toBe(15_000);
              schedules += 1;
              scheduled = callback;
              if (schedules === 2) {
                rescheduled.resolve(undefined);
              }
              return () => {
                cancellations += 1;
              };
            },
          },
          run: async () => {
            entered.resolve(undefined);
            await finish.promise;
            return "complete";
          },
        });
        try {
          await entered.promise;
          now = 15_000;
          if (scheduled === undefined) {
            panic("Expected a scheduled renewal");
          }
          scheduled();
          await rescheduled.promise;
          expect(renewals).toBe(1);
          if (leaseKey === undefined || leaseId === undefined) {
            panic("Expected the acquired lease");
          }
          expect(Number(await client.send("ZSCORE", [leaseKey, leaseId]))).toBe(
            storeStart + 45_000,
          );
          expectBusy(
            await withMcpPublicReadAdmission({
              caller: identity,
              redis,
              limit: 1,
              run: async () => undefined,
            }),
          );
        } finally {
          finish.resolve(undefined);
          expect(await owner).toEqual(leased("complete"));
        }
        expect(cancellations).toBe(1);
        expect(schedules).toBe(2);
        expect(
          await withMcpPublicReadAdmission({
            caller: identity,
            redis,
            limit: 1,
            run: async () => "next",
          }),
        ).toEqual(leased("next"));
      });
    });

    test("a lost lease aborts active work and leaves the caller available", async () => {
      await withStore(async (client) => {
        const identity = caller();
        const entered = Promise.withResolvers<undefined>();
        let renew: (() => void) | undefined;
        const owner = withMcpPublicReadAdmission({
          caller: identity,
          limit: 1,
          redis: {
            send: async (command, args) => {
              if (args.at(0) === RENEW_SCRIPT) {
                const key = args.at(2);
                if (key === undefined) {
                  panic("Expected the lease key");
                }
                await client.send("DEL", [key]);
              }
              return await client.send(command, args);
            },
          },
          timing: {
            now: () => 0,
            schedule: (callback) => {
              renew = callback;
              return () => undefined;
            },
          },
          run: async (signal) => {
            const aborted = Promise.withResolvers<undefined>();
            signal.addEventListener("abort", () => aborted.resolve(undefined), {
              once: true,
            });
            entered.resolve(undefined);
            await aborted.promise;
            signal.throwIfAborted();
          },
        });
        await entered.promise;
        if (renew === undefined) {
          panic("Expected a scheduled renewal");
        }
        renew();
        const lost = await owner;
        if (Result.isOk(lost)) {
          panic("Expected lease-loss refusal");
        }
        expect(lost.error).toMatchObject({
          reason: "unavailable",
          code: "action_admission_unavailable",
        });
        expect(
          await withMcpPublicReadAdmission({
            caller: identity,
            redis: client,
            limit: 1,
            run: async () => "next",
          }),
        ).toEqual(leased("next"));
      });
    });

    test("a stale unreleased lease is reaped while completed work keeps its result", async () => {
      await withStore(async (client) => {
        const identity = caller();
        let leaseKey: string | undefined;
        let leaseId: string | undefined;
        const offline = new HandlerError({
          status: 503,
          code: "service_unavailable",
          message: "Coordination unavailable",
        });
        const completed = await withMcpPublicReadAdmission({
          caller: identity,
          limit: 1,
          leaseMs: 500,
          redis: {
            send: async (command, args) => {
              if (args.at(0) === ACQUIRE_SCRIPT) {
                leaseKey = args.at(2);
                leaseId = args.at(7);
              }
              return args.at(0) === RELEASE_SCRIPT
                ? await Promise.reject(offline)
                : await client.send(command, args);
            },
          },
          run: async () => "complete",
        });
        expect(completed).toMatchObject(
          Result.ok({ status: "degraded", value: "complete" }),
        );
        expectBusy(
          await withMcpPublicReadAdmission({
            caller: identity,
            redis: client,
            limit: 1,
            run: async () => undefined,
          }),
        );
        if (leaseKey === undefined || leaseId === undefined) {
          panic("Expected the unreleased lease identity");
        }
        await client.send("ZADD", [leaseKey, "0", leaseId]);
        expect(
          await withMcpPublicReadAdmission({
            caller: identity,
            redis: client,
            limit: 1,
            run: async () => "next",
          }),
        ).toEqual(leased("next"));
      });
    });
  });
}
