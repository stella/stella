import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { customType, integer, pgTable, text } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { FLOW_RUN_STATUSES, FLOW_RUN_STEP_STATUSES } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";

import { jsonb, timestamptz } from "@/api/db/columns";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionTriggerSql } from "@/api/lib/db/transition-sql";
import {
  defineTransitions,
  permitsTransition,
  transition,
} from "@/api/lib/db/transitions";
import { isPgConstraintError } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const encodedId = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => `stored:${value}`,
  fromDriver: (value) => value.slice("stored:".length),
});
const updatedAt = new Date("2026-01-02T00:00:00Z");
const fencedJobs = pgTable("transition_fenced_jobs", {
  id: encodedId().primaryKey(),
  status: text({ enum: ["queued", "running", "done"] }).notNull(),
  attempt: integer().notNull(),
  leaseToken: text("lease_token"),
  claimedAt: timestamptz("claimed_at"),
  description: text(),
  payload: jsonb(),
  updatedAt: timestamptz("updated_at").$onUpdate(() => updatedAt),
});
const jobEdges = { queued: ["running"], running: ["done"], done: [] } as const;

if (!databaseUrl || !enabled) {
  describe.skip("status transitions (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("status transitions (postgres)", () => {
    test("competing transitions commit exactly one result and return stale for the loser", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: competitor } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        try {
          const start = Promise.withResolvers<undefined>();
          const ready = Promise.withResolvers<undefined>();
          let arrivals = 0;
          const move = async (client: typeof db) =>
            await client.transaction(async (tx) => {
              arrivals += 1;
              if (arrivals === 2) {
                ready.resolve(undefined);
              }
              await start.promise;
              return await transition(tx, TRANSITIONS.flowRuns, fixture.runId, {
                from: ["pending"],
                to: "running",
              });
            });
          const results = [move(db), move(competitor)];
          await ready.promise;
          start.resolve(undefined);
          const outcomes = await Promise.all(results);
          expect(outcomes.map(({ type }) => type).toSorted()).toEqual([
            "stale",
            "transitioned",
          ]);
          expect(
            (
              await db.query.flowRuns.findFirst({
                where: { id: { eq: fixture.runId } },
              })
            )?.status,
          ).toBe("running");
        } finally {
          await fixture.cleanup();
        }
      });
    });

    test("inserts allow every initial domain state but terminal runs cannot reopen", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        try {
          for (const status of FLOW_RUN_STATUSES) {
            const id = createSafeId<"flowRun">();
            await db.insert(flowRuns).values({
              id,
              workspaceId: fixture.workspaceId,
              status,
              definitionSnapshot: { name: "Initial status", steps: [] },
              triggerSource: { type: "manual", userId: fixture.userId },
            });
            expect(
              (await db.query.flowRuns.findFirst({ where: { id: { eq: id } } }))
                ?.status,
            ).toBe(status);
            if (
              TRANSITIONS.flowRuns.terminal.some(
                (terminal) => terminal === status,
              )
            ) {
              const reopened = await Result.tryPromise(() =>
                db
                  .update(flowRuns)
                  .set({ status: "running" })
                  .where(eq(flowRuns.id, id)),
              );
              expect(reopened.isErr()).toBe(true);
              if (reopened.isErr()) {
                expect(
                  isPgConstraintError(
                    reopened.error,
                    "23514",
                    "flow_runs_status_transition",
                  ),
                ).toBe(true);
              }
            }
          }
          const invalid = await Result.tryPromise(() =>
            db.execute(
              sql`INSERT INTO ${flowRuns} (id, workspace_id, status, definition_snapshot, trigger_source)
                  SELECT ${createSafeId<"flowRun">()}, workspace_id, 'unknown', definition_snapshot, trigger_source
                  FROM ${flowRuns} WHERE id = ${fixture.runId}`,
            ),
          );
          expect(invalid.isErr()).toBe(true);
          if (invalid.isErr()) {
            expect(
              isPgConstraintError(
                invalid.error,
                "23514",
                "flow_runs_status_domain",
              ),
            ).toBe(true);
          }
        } finally {
          await fixture.cleanup();
        }
      });
    });

    test("installed step trigger agrees with the step graph for every pair", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        try {
          let index = 1;
          for (const from of FLOW_RUN_STEP_STATUSES) {
            for (const to of FLOW_RUN_STEP_STATUSES) {
              const id = createSafeId<"flowRunStep">();
              await db.insert(flowRunSteps).values({
                id,
                runId: fixture.runId,
                workspaceId: fixture.workspaceId,
                index: index++,
                kind: "review-gate",
                status: from,
              });
              const outcome = await Result.tryPromise(() =>
                db
                  .update(flowRunSteps)
                  .set({ status: to })
                  .where(eq(flowRunSteps.id, id)),
              );
              expect(outcome.isOk()).toBe(
                permitsTransition(TRANSITIONS.flowRunSteps, from, to),
              );
              if (outcome.isErr()) {
                expect(
                  isPgConstraintError(
                    outcome.error,
                    "23514",
                    "flow_run_steps_status_transition",
                  ),
                ).toBe(true);
              }
            }
          }
        } finally {
          await fixture.cleanup();
        }
      });
    });

    test("status owner and installed flow trigger agree on generated pairs", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        try {
          const checkPair = async (
            from: (typeof FLOW_RUN_STATUSES)[number],
            to: (typeof FLOW_RUN_STATUSES)[number],
          ) => {
            const id = createSafeId<"flowRun">();
            await db.insert(flowRuns).values({
              id,
              workspaceId: fixture.workspaceId,
              status: from,
              definitionSnapshot: { name: "Transition", steps: [] },
              triggerSource: { type: "manual", userId: fixture.userId },
            });
            const expected = permitsTransition(TRANSITIONS.flowRuns, from, to);
            const raw = await Result.tryPromise(() =>
              db
                .update(flowRuns)
                .set({ status: to })
                .where(eq(flowRuns.id, id)),
            );
            expect(raw.isOk()).toBe(expected);
            if (raw.isErr()) {
              expect(
                isPgConstraintError(
                  raw.error,
                  "23514",
                  "flow_runs_status_transition",
                ),
              ).toBe(true);
            }
            expect(
              (await db.query.flowRuns.findFirst({ where: { id: { eq: id } } }))
                ?.status,
            ).toBe(expected ? to : from);

            // A second row gives the owner the same source as the trigger.
            const ownerId = createSafeId<"flowRun">();
            await db.insert(flowRuns).values({
              id: ownerId,
              workspaceId: fixture.workspaceId,
              status: from,
              definitionSnapshot: { name: "Owner transition", steps: [] },
              triggerSource: { type: "manual", userId: fixture.userId },
            });
            const move = { from: [from], to } as const;
            const owned = await Result.tryPromise(
              async () =>
                // @ts-expect-error arbitrary external pairs exercise runtime validation too
                await transition(db, TRANSITIONS.flowRuns, ownerId, move),
            );
            expect(owned.isOk()).toBe(expected);
            if (owned.isOk()) {
              expect(owned.value).toEqual({
                type: "transitioned",
                row: { id: ownerId, status: to },
              });
            } else {
              expect(owned.error.message).toContain(
                "Illegal status transition",
              );
            }
            expect(
              (
                await db.query.flowRuns.findFirst({
                  where: { id: { eq: ownerId } },
                })
              )?.status,
            ).toBe(expected ? to : from);
          };
          // Exhaustive pairs ensure every terminal escape and every legal edge is exercised.
          for (const from of FLOW_RUN_STATUSES) {
            for (const to of FLOW_RUN_STATUSES) {
              await checkPair(from, to);
            }
          }
          await assertProperty(
            "status owner and installed flow trigger agree on generated pairs",
            fc.asyncProperty(
              fc.constantFrom(...FLOW_RUN_STATUSES),
              fc.constantFrom(...FLOW_RUN_STATUSES),
              checkPair,
            ),
            { numRuns: 24 },
          );
        } finally {
          await fixture.cleanup();
        }
      });
    }, 30_000);

    test("missing rows, wrong sources, and mismatched fences are stale without changing metadata", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_fenced_jobs (id text PRIMARY KEY, status text NOT NULL, attempt integer NOT NULL, lease_token text, claimed_at timestamptz, description text, payload jsonb, updated_at timestamptz) ON COMMIT DROP`,
          );
          const attempt = defineTransitions(fencedJobs, jobEdges, {
            terminal: ["done"],
            fence: "attempt",
          });
          const lease = defineTransitions(fencedJobs, jobEdges, {
            terminal: ["done"],
            fence: "leaseToken",
          });
          const claimed = defineTransitions(fencedJobs, jobEdges, {
            terminal: ["done"],
            fence: "claimedAt",
          });
          const unfenced = defineTransitions(fencedJobs, jobEdges, {
            terminal: ["done"],
          });
          const date = new Date("2026-01-01T00:00:00Z");
          await tx.insert(fencedJobs).values({
            id: "job",
            status: "queued",
            attempt: 2,
            leaseToken: "new-lease",
            claimedAt: date,
            description: "original",
          });
          expect(
            await transition(tx, attempt, "missing", {
              from: ["queued"],
              to: "running",
              fence: 2,
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition(tx, attempt, "job", {
              from: ["queued"],
              to: "running",
              fence: 1,
              set: { description: "wrong attempt" },
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition(tx, lease, "job", {
              from: ["queued"],
              to: "running",
              fence: "old-lease",
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition(tx, claimed, "job", {
              from: ["queued"],
              to: "running",
              fence: new Date("2025-01-01T00:00:00Z"),
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition(tx, unfenced, "job", {
              from: ["running"],
              to: "done",
            }),
          ).toEqual({ type: "stale" });
          const before = (await tx.select().from(fencedJobs)).at(0);
          expect(before?.status).toBe("queued");
          expect(before?.description).toBe("original");
          expect(
            await transition(tx, claimed, "job", {
              from: ["queued"],
              to: "running",
              fence: date,
              set: {
                description: "claimed",
                payload: { labels: ["a", "b"], count: 2 },
              },
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "job", status: "running" },
          });
          expect(
            await transition(tx, lease, "job", {
              from: ["running"],
              to: "done",
              fence: "new-lease",
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "job", status: "done" },
          });
          expect((await tx.select().from(fencedJobs)).at(0)?.description).toBe(
            "claimed",
          );
          expect((await tx.select().from(fencedJobs)).at(0)?.payload).toEqual({
            labels: ["a", "b"],
            count: 2,
          });
          expect((await tx.select().from(fencedJobs)).at(0)?.updatedAt).toEqual(
            updatedAt,
          );
          await tx
            .insert(fencedJobs)
            .values({ id: "attempt-success", status: "queued", attempt: 2 });
          expect(
            await transition(tx, attempt, "attempt-success", {
              from: ["queued"],
              to: "running",
              fence: 2,
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "attempt-success", status: "running" },
          });
          await tx
            .insert(fencedJobs)
            .values({ id: "null-lease", status: "queued", attempt: 1 });
          expect(
            await transition(tx, lease, "null-lease", {
              from: ["queued"],
              to: "running",
              fence: null,
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "null-lease", status: "running" },
          });
        });
      });
    });

    test("trigger generator refuses null and unknown transitions in the real engine", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_fenced_jobs (id text PRIMARY KEY, status text, attempt integer, lease_token text, claimed_at timestamptz, description text, payload jsonb, updated_at timestamptz) ON COMMIT DROP`,
          );
          const spec = defineTransitions(fencedJobs, jobEdges, {
            terminal: ["done"],
          });
          const statements = transitionTriggerSql(spec).split(
            "--> statement-breakpoint",
          );
          for (const statement of statements) {
            await tx.execute(sql.raw(statement));
          }
          await tx
            .insert(fencedJobs)
            .values({ id: "job", status: "done", attempt: 1 });
          await tx.execute(sql`SAVEPOINT invalid_transition`);
          const failed = await Result.tryPromise(() =>
            tx.execute(
              sql`UPDATE transition_fenced_jobs SET status = NULL WHERE id = 'stored:job'`,
            ),
          );
          expect(failed.isErr()).toBe(true);
          if (failed.isErr()) {
            expect(
              isPgConstraintError(
                failed.error,
                "23514",
                "transition_fenced_jobs_status_transition",
              ),
            ).toBe(true);
          }
          await tx.execute(sql`ROLLBACK TO SAVEPOINT invalid_transition`);
          expect((await tx.select().from(fencedJobs)).at(0)?.status).toBe(
            "done",
          );
          for (const value of [null, "unknown"]) {
            await tx.execute(
              sql`INSERT INTO transition_fenced_jobs (id, status) VALUES ('invalid', ${value})`,
            );
            await tx.execute(sql`SAVEPOINT invalid_state`);
            const invalid = await Result.tryPromise(() =>
              tx.execute(
                sql`UPDATE transition_fenced_jobs SET status = ${value} WHERE id = 'invalid'`,
              ),
            );
            expect(invalid.isErr()).toBe(true);
            if (invalid.isErr()) {
              expect(
                isPgConstraintError(
                  invalid.error,
                  "23514",
                  "transition_fenced_jobs_status_transition",
                ),
              ).toBe(true);
            }
            await tx.execute(sql`ROLLBACK TO SAVEPOINT invalid_state`);
            await tx.execute(
              sql`DELETE FROM transition_fenced_jobs WHERE id = 'invalid'`,
            );
          }
          await tx.execute(
            sql`DROP FUNCTION transition_fenced_jobs_status_transition_guard() CASCADE`,
          );
        });
      });
    });
  });
}
