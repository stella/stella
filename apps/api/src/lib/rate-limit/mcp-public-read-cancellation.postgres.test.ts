import { panic, Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { rootDb } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { publicReadTimeoutError } from "@/api/lib/legal-search/public-read-timeout";
import { runWithPublicReadScope } from "@/api/lib/legal-search/public-read-timeout-context";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import { createRedisClient } from "@/api/lib/redis-client";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { RELEASE_SCRIPT, RENEW_SCRIPT } from "./concurrency-lease";
import { withMcpPublicReadAdmission } from "./mcp-public-read-admission";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "public-read cancellation with PostgreSQL and Valkey",
  () => {
    afterAll(async () => {
      await rootDb.$client.close();
    });

    test("lease loss cancels the running backend before releasing the caller slot", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required");
      if (!process.env["REDIS_URL"]) {
        panic("Public-read cancellation requires Valkey");
      }
      const redis = createRedisClient({ storeClass: "cache" });
      await redis.connect();
      const admissionRedis = {
        send: async (command: string, args: string[]) =>
          await redis.send(command, args),
      };
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient().sql;
          const caller = {
            organizationId: toSafeId<"organization">(
              `cancel_${Bun.randomUUIDv7()}`,
            ),
            userId: toSafeId<"user">("cancel_user"),
            clientId: "cancel_client",
          };
          const entered = Promise.withResolvers<readonly number[]>();
          const renewReady = Promise.withResolvers<() => void>();
          let releaseStarted = false;
          const finishRelease = Promise.withResolvers<undefined>();
          let expectedReason: unknown;
          let sleepSettled = 0;
          let cancellationCode: unknown;
          const activePids: number[] = [];
          const admitted = withMcpPublicReadAdmission({
            caller,
            limit: 1,
            redis: {
              send: async (command, args) => {
                if (args.at(0) === RENEW_SCRIPT) {
                  // A refused renewal aborts work while its current lease still owns the slot.
                  return 0;
                }
                if (args.at(0) === RELEASE_SCRIPT) {
                  expect(sleepSettled).toBe(2);
                  releaseStarted = true;
                  await finishRelease.promise;
                }
                return await redis.send(command, args);
              },
            },
            timing: {
              now: () => performance.now(),
              schedule: (callback) => {
                renewReady.resolve(callback);
                return () => undefined;
              },
            },
            run: async (signal) =>
              await runWithPublicReadScope(
                { budgetMs: 30_000, signal },
                async () => {
                  const result = await Result.tryPromise({
                    try: async () =>
                      await Promise.all(
                        Array.from(
                          { length: 2 },
                          async () =>
                            await publicLawReadDb(async (tx) => {
                              const [row] = await tx.execute<{ pid: number }>(
                                sql`SELECT pg_backend_pid() AS pid`,
                              );
                              if (row === undefined) {
                                panic("Expected backend PID");
                              }
                              activePids.push(row.pid);
                              if (activePids.length === 2) {
                                entered.resolve(activePids);
                              }
                              try {
                                await tx.execute(sql`SELECT pg_sleep(60)`);
                              } finally {
                                sleepSettled += 1;
                              }
                            }),
                        ),
                      ),
                    catch: (error: unknown) => error,
                  });
                  expectedReason = signal.reason;
                  if (Result.isError(result)) {
                    cancellationCode = publicReadTimeoutError(result.error);
                    return abortTransaction(result.error);
                  }
                  return result.value;
                },
              ),
          });
          try {
            const pids = await entered.promise;
            const pidArray = `{${pids.join(",")}}`;
            await waitForExternalState({
              description: "public-read backend is running pg_sleep",
              timeoutMs: 3000,
              read: async () => {
                const [row] =
                  await observer`SELECT count(*)::int AS running FROM pg_stat_activity WHERE pid = ANY(${pidArray}::int[]) AND state = 'active' AND wait_event = 'PgSleep'`;
                return row?.["running"] === 2;
              },
            });
            const renew = await renewReady.promise;
            renew();
            await waitForExternalState({
              description: "cancelled public read reaches settlement",
              timeoutMs: 3000,
              read: async () => releaseStarted,
            });
            await waitForExternalState({
              description: "cancelled public-read backend is closed",
              timeoutMs: 3000,
              read: async () => {
                const [row] =
                  await observer`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ANY(${pidArray}::int[])) AS closed`;
                return row?.["closed"] === true;
              },
            });
            expect(sleepSettled).toBe(2);
            const contender = await withMcpPublicReadAdmission({
              caller,
              limit: 1,
              redis: admissionRedis,
              run: async () => "unexpected",
            });
            if (
              Result.isOk(contender) ||
              !ActionAdmissionError.is(contender.error)
            ) {
              panic("Caller slot released before cancellation settled");
            }
            expect(contender.error.code).toBe("action_concurrency_busy");
            finishRelease.resolve(undefined);
            const outcome = await admitted;
            if (
              Result.isOk(outcome) ||
              !ActionAdmissionError.is(outcome.error)
            ) {
              panic("Expected typed lease-loss outcome");
            }
            if (!ActionAdmissionError.is(expectedReason)) {
              panic("Expected the original lease-loss reason");
            }
            expect(outcome.error).toBe(expectedReason);
            expect(outcome.error.code).toBe("action_admission_unavailable");
            expect(cancellationCode).toBeNull();
            expect(
              await withMcpPublicReadAdmission({
                caller,
                limit: 1,
                redis: admissionRedis,
                run: async () => "next",
              }),
            ).toEqual(Result.ok({ status: "leased", value: "next" }));
          } finally {
            finishRelease.resolve(undefined);
            await observer`SELECT pg_cancel_backend(pid) FROM unnest(${`{${activePids.join(",")}}`}::int[]) AS pid`;
            await admitted;
          }
        });
      } finally {
        redis.close();
      }
    });

    test("renewal outage lets the active PostgreSQL query finish degraded", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required");
      if (!process.env["REDIS_URL"]) {
        panic("Public-read cancellation requires Valkey");
      }
      const redis = createRedisClient({ storeClass: "cache" });
      await redis.connect();
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient().sql;
          const caller = {
            organizationId: toSafeId<"organization">(
              `renew_${Bun.randomUUIDv7()}`,
            ),
            userId: toSafeId<"user">("renew_user"),
            clientId: "renew_client",
          };
          const entered = Promise.withResolvers<number>();
          const renewReady = Promise.withResolvers<() => void>();
          const renewalFailed = Promise.withResolvers<undefined>();
          let signalAborted: boolean | undefined;
          const admitted = withMcpPublicReadAdmission({
            caller,
            limit: 1,
            redis: {
              send: async (command, args) => {
                if (args.at(0) === RENEW_SCRIPT) {
                  renewalFailed.resolve(undefined);
                  throw new Error("renewal transport unavailable");
                }
                return await redis.send(command, args);
              },
            },
            timing: {
              now: () => performance.now(),
              schedule: (callback) => {
                renewReady.resolve(callback);
                return () => undefined;
              },
            },
            run: async (signal) =>
              await runWithPublicReadScope(
                { budgetMs: 30_000, signal },
                async () =>
                  await publicLawReadDb(async (tx) => {
                    const [row] = await tx.execute<{ pid: number }>(
                      sql`SELECT pg_backend_pid() AS pid`,
                    );
                    if (row === undefined) {
                      panic("Expected backend PID");
                    }
                    entered.resolve(row.pid);
                    await tx.execute(sql`SELECT pg_sleep(0.5)`);
                    signalAborted = signal.aborted;
                    return "query-complete";
                  }),
              ),
          });

          const pid = await entered.promise;
          const renew = await renewReady.promise;
          await waitForExternalState({
            description:
              "public-read backend is running pg_sleep before renewal",
            timeoutMs: 3000,
            read: async () => {
              const [row] =
                await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND state = 'active' AND wait_event = 'PgSleep') AS running`;
              return row?.["running"] === true;
            },
          });
          renew();
          await renewalFailed.promise;
          const outcome = await admitted;
          expect(outcome).toMatchObject(
            Result.ok({ status: "degraded", value: "query-complete" }),
          );
          expect(signalAborted).toBe(false);
        });
      } finally {
        redis.close();
      }
    });
  },
);
