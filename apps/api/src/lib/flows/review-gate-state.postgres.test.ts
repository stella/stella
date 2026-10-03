import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { databaseRelations } from "@/api/db/database-relations";
import type { SafeDb } from "@/api/db/safe-db";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ACTIONS = ["approved", "rejected", "cancel"] as const;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("review gate state (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review gate state (postgres)", () => {
    for (const intermediate of [false, true]) {
      for (const winner of ACTIONS) {
        for (const loser of ACTIONS) {
          test(`${intermediate ? "intermediate" : "final"} gate: ${winner} commits before ${loser}`, async () => {
            await withGatedTestClients(databaseUrl, async ({ openClient }) => {
              const { db } = openClient();
              const { sql: otherClient } = openClient();
              const f = await flowReviewGateFixture(db, {
                intermediate,
                governed: true,
              });
              const firstDb = createSafeDb(
                markRlsDatabase(db),
                [f.workspaceId],
                f.organizationId,
                f.userId,
              );
              const written = Promise.withResolvers<undefined>();
              const release = Promise.withResolvers<undefined>();
              const otherDb = drizzle({
                client: otherClient,
                relations: databaseRelations,
                logger: {
                  logQuery: (query) => {
                    // Release at the decisive lock request. Without locking,
                    // release at UPDATE instead, after all stale reads have
                    // finished; a nonlocking mutation must fail this matrix.
                    if (
                      query.includes("for update") ||
                      /^update "flow_(runs|run_steps)"/u.test(query)
                    ) {
                      release.resolve(undefined);
                    }
                  },
                },
              });
              const secondDb = createSafeDb(
                markRlsDatabase(otherDb),
                [f.workspaceId],
                f.organizationId,
                f.userId,
              );
              const gatedFirst: SafeDb = async (work, retry) =>
                await firstDb(async (tx) => {
                  const value = await work(tx);
                  if (
                    typeof value === "object" &&
                    value !== null &&
                    ("payload" in value || "steps" in value)
                  ) {
                    written.resolve(undefined);
                    await release.promise;
                  }
                  return value;
                }, retry);
              try {
                const winning = f.act(gatedFirst, winner);
                await Promise.race([
                  written.promise,
                  winning.then((result) => {
                    if (result.isErr()) {
                      throw result.error;
                    }
                    throw new Error(
                      "The winning action finished without reaching its commit barrier",
                    );
                  }),
                ]);
                const losing = f.act(secondDb, loser);
                const [won, lost] = await Promise.all([winning, losing]);
                expect(won.isOk()).toBe(true);
                expect(lost.isErr()).toBe(true);
                if (lost.isErr()) {
                  expect(HandlerError.is(lost.error)).toBe(true);
                  expect(lost.error).toMatchObject({
                    status: 409,
                    message:
                      loser === "cancel"
                        ? "This run changed before it could be cancelled."
                        : "This run is not awaiting review.",
                  });
                }
                const state = await f.read();
                const gate = state.steps.at(0);
                const approvedStatus = intermediate ? "running" : "completed";
                expect(state.run?.status).toBe(
                  winner === "approved" ? approvedStatus : "cancelled",
                );
                expect(state.task?.status).toBe(
                  winner === "cancel" ? "cancelled" : "done",
                );
                expect(state.obligation?.status).toBe(
                  winner === "cancel" ? "cancelled" : "completed",
                );
                expect(gate?.status).toBe(
                  winner === "cancel" ? "skipped" : "completed",
                );
                expect(gate?.output).toEqual(
                  winner === "cancel"
                    ? null
                    : {
                        kind: "review-gate",
                        decision: winner,
                        userId: f.userId,
                        note: `${winner}:0`,
                      },
                );
                expect(f.enqueued).toEqual(
                  winner === "approved" && intermediate ? [1] : [],
                );
                if (intermediate) {
                  expect(state.steps.at(1)?.status).toBe(
                    winner === "approved" ? "pending" : "skipped",
                  );
                }
                for (const action of ACTIONS.filter(
                  (candidate) => candidate !== "cancel",
                )) {
                  expect((await f.act(secondDb, action)).isErr()).toBe(true);
                  expect(await f.read()).toEqual(state);
                }
              } finally {
                release.resolve(undefined);
                await f.cleanup();
              }
            });
          });
        }
      }
    }
    test("review gate first committed terminal action is immutable", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await assertProperty(
          "review gate first committed terminal action is immutable",
          fc.asyncProperty(
            fc.array(fc.constantFrom(...ACTIONS), {
              minLength: 1,
              maxLength: 12,
            }),
            async (actions) => {
              const f = await flowReviewGateFixture(db, {
                intermediate: false,
                governed: true,
              });
              const safeDb = createSafeDb(
                markRlsDatabase(db),
                [f.workspaceId],
                f.organizationId,
                f.userId,
              );
              try {
                const first = actions.at(0);
                if (!first) {
                  throw new Error("Expected a first action");
                }
                expect((await f.act(safeDb, first)).isOk()).toBe(true);
                const state = await f.read();
                expect(state.run?.status).toBe(
                  first === "approved" ? "completed" : "cancelled",
                );
                expect(state.steps.at(0)?.output).toEqual(
                  first === "cancel"
                    ? null
                    : {
                        kind: "review-gate",
                        decision: first,
                        userId: f.userId,
                        note: `${first}:0`,
                      },
                );
                for (const action of actions.slice(1)) {
                  expect((await f.act(safeDb, action)).isErr()).toBe(true);
                  expect(await f.read()).toEqual(state);
                }
                expect(f.enqueued).toEqual([]);
              } finally {
                await f.cleanup();
              }
            },
          ),
          { numRuns: 20 },
        );
      });
    });
  });
}
