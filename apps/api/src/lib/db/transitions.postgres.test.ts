import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  customType,
  integer,
  pgTable,
  text,
  primaryKey,
} from "drizzle-orm/pg-core";
import fc from "fast-check";

import { FLOW_RUN_STATUSES, FLOW_RUN_STEP_STATUSES } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";

import { jsonb, timestamptz } from "@/api/db/columns";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionTriggerSql } from "@/api/lib/db/transition-sql";
import {
  defineScopedTransitions,
  transitionUpsertBatch,
  transitionScopedCount,
  defineTransitions,
  permitsTransition,
  transition,
} from "@/api/lib/db/transitions";
import { isPgConstraintError } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const noAudit = async () => await Promise.resolve();
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
const countRows = pgTable(
  "transition_count_rows",
  {
    organizationId: text("organization_id").notNull(),
    id: text().notNull(),
    state: text({ enum: ["active", "lapsed"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.id] })],
);
const jobEdges = { queued: ["running"], running: ["done"], done: [] } as const;

if (!databaseUrl || !enabled) {
  describe.skip("status transitions (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("status transitions (postgres)", () => {
    test("set-based scoped transitions audit one count and roll back with their audit", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_count_rows (organization_id text NOT NULL, id text NOT NULL, state text NOT NULL, PRIMARY KEY (organization_id, id)) ON COMMIT DROP`,
          );
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_count_audits (count integer NOT NULL) ON COMMIT DROP`,
          );
          await tx.execute(
            sql`INSERT INTO transition_count_rows VALUES ('first', 'one', 'active'), ('first', 'two', 'active'), ('other', 'one', 'active')`,
          );
          const spec = defineScopedTransitions({
            table: countRows,
            key: "id",
            scope: ["organizationId"],
            stateColumn: "state",
            edges: { active: ["lapsed"], lapsed: [] },
            initial: [],
          });
          const move = async (failAudit: boolean) =>
            await tx.transaction(
              async (nested) =>
                await transitionScopedCount({
                  tx: nested,
                  spec,
                  where: eq(countRows.organizationId, "first"),
                  options: { from: ["active"], to: "lapsed" },
                  recordTransitionAuditEvent: async (auditTx, count) => {
                    await auditTx.execute(
                      sql`INSERT INTO transition_count_audits VALUES (${count})`,
                    );
                    if (failAudit) {
                      panic("Synthetic count audit failure");
                    }
                  },
                }),
            );
          const census = async () => ({
            rows: await tx
              .select()
              .from(countRows)
              .orderBy(countRows.organizationId, countRows.id),
            audits: await tx.execute(
              sql`SELECT count FROM transition_count_audits`,
            ),
          });
          const initial = await census();
          expect(
            (await Result.tryPromise(async () => await move(true))).isErr(),
          ).toBe(true);
          expect(await census()).toEqual(initial);
          expect(await move(false)).toBe(2);
          const committed = await census();
          expect(committed.audits).toEqual([{ count: 2 }]);
          expect(
            committed.rows.map(({ organizationId, state }) => [
              organizationId,
              state,
            ]),
          ).toEqual([
            ["first", "lapsed"],
            ["first", "lapsed"],
            ["other", "active"],
          ]);
          expect(await move(false)).toBe(0);
          expect(await census()).toEqual(committed);
        });
      });
    });

    test("scoped upserts enforce initial states and roll back the journal with failed audit", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_fenced_jobs (id text PRIMARY KEY, status text NOT NULL, attempt integer NOT NULL, lease_token text, claimed_at timestamptz, description text, payload jsonb, updated_at timestamptz) ON COMMIT DROP`,
          );
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_test_audit_events (status text NOT NULL) ON COMMIT DROP`,
          );
          const spec = defineScopedTransitions({
            table: fencedJobs,
            key: "id",
            scope: [],
            stateColumn: "status",
            edges: jobEdges,
            initial: ["queued"],
            sameStateUpsert: "ignore",
          });
          const upsert = async (
            status: "queued" | "running" | "done",
            failAudit = false,
          ) =>
            await tx.transaction(
              async (nested) =>
                await transitionUpsertBatch({
                  tx: nested,
                  spec,
                  values: [{ id: "job", status, attempt: 1 }],
                  recordTransitionAuditEvent: async (auditTx, rows) => {
                    for (const row of rows) {
                      await auditTx.execute(
                        sql`INSERT INTO transition_test_audit_events (status) VALUES (${row.status})`,
                      );
                    }
                    if (failAudit) {
                      panic("Synthetic transition audit failure");
                    }
                  },
                }),
            );
          const census = async () => ({
            rows: await tx.select().from(fencedJobs),
            audit: await tx.execute(
              sql`SELECT status FROM transition_test_audit_events ORDER BY status`,
            ),
          });
          expect(
            (
              await Result.tryPromise(async () => await upsert("running"))
            ).isErr(),
          ).toBe(true);
          expect(await census()).toEqual({ rows: [], audit: [] });
          expect(await upsert("queued")).toHaveLength(1);
          const initial = await census();
          expect(initial.audit).toHaveLength(1);
          expect(await upsert("queued")).toHaveLength(0);
          expect(await census()).toEqual(initial);
          expect(
            (
              await Result.tryPromise(async () => await upsert("running", true))
            ).isErr(),
          ).toBe(true);
          expect(await census()).toEqual(initial);
          expect(await upsert("running")).toHaveLength(1);
          const running = await census();
          expect(running.audit).toHaveLength(2);
          expect(
            (
              await Result.tryPromise(async () => await upsert("queued"))
            ).isErr(),
          ).toBe(true);
          expect(await census()).toEqual(running);
        });
      });
    });

    test("competing transitions commit exactly one result and return stale for the loser", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: competitor } = openClient();
        const fixture = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const recordTransitionAuditEvent = createBackgroundAuditRecorder({
          execution: {
            performer: {
              id: "transition-test",
              name: "Transition test",
              type: "service",
            },
            trigger: { type: "system" },
          },
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
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
              return await transition({
                tx,
                spec: TRANSITIONS.flowRuns,
                id: fixture.runId,
                options: { from: ["pending"], to: "running" },
                recordTransitionAuditEvent: async (auditTx, row) =>
                  await recordTransitionAuditEvent(auditTx, {
                    action: AUDIT_ACTION.UPDATE,
                    resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
                    resourceId: row.id,
                    metadata: { status: row.status },
                  }),
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
        const recordTransitionAuditEvent = createBackgroundAuditRecorder({
          execution: {
            performer: {
              id: "transition-test",
              name: "Transition test",
              type: "service",
            },
            trigger: { type: "system" },
          },
          organizationId: fixture.organizationId,
          userId: fixture.userId,
          workspaceId: fixture.workspaceId,
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
                await db.transaction(
                  async (tx) =>
                    await transition({
                      tx,
                      spec: TRANSITIONS.flowRuns,
                      id: ownerId,
                      // @ts-expect-error arbitrary external pairs exercise runtime validation too
                      options: move,
                      recordTransitionAuditEvent: async (auditTx, row) =>
                        await recordTransitionAuditEvent(auditTx, {
                          action: AUDIT_ACTION.UPDATE,
                          resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
                          resourceId: row.id,
                          metadata: { status: row.status },
                        }),
                    }),
                ),
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
          // This isolated custom-codec table has no flow fixture or audit tenant context.
          // A temporary journal still proves the audit callback is transaction-bound.
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_fenced_jobs (id text PRIMARY KEY, status text NOT NULL, attempt integer NOT NULL, lease_token text, claimed_at timestamptz, description text, payload jsonb, updated_at timestamptz) ON COMMIT DROP`,
          );
          await tx.execute(
            sql`CREATE TEMPORARY TABLE transition_test_audit_events (resource_id text NOT NULL, status text NOT NULL) ON COMMIT DROP`,
          );
          const recordTempAuditEvent = async (
            auditTx: typeof tx,
            row: { id: string; status: "queued" | "running" | "done" },
          ) => {
            await auditTx.execute(
              sql`INSERT INTO transition_test_audit_events (resource_id, status) VALUES (${row.id}, ${row.status})`,
            );
          };
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
            await transition({
              tx,
              spec: attempt,
              id: "missing",
              options: { from: ["queued"], to: "running", fence: 2 },
              recordTransitionAuditEvent: noAudit,
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition({
              tx,
              spec: attempt,
              id: "job",
              options: {
                from: ["queued"],
                to: "running",
                fence: 1,
                set: { description: "wrong attempt" },
              },
              recordTransitionAuditEvent: noAudit,
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition({
              tx,
              spec: lease,
              id: "job",
              options: { from: ["queued"], to: "running", fence: "old-lease" },
              recordTransitionAuditEvent: noAudit,
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition({
              tx,
              spec: claimed,
              id: "job",
              options: {
                from: ["queued"],
                to: "running",
                fence: new Date("2025-01-01T00:00:00Z"),
              },
              recordTransitionAuditEvent: noAudit,
            }),
          ).toEqual({ type: "stale" });
          expect(
            await transition({
              tx,
              spec: unfenced,
              id: "job",
              options: { from: ["running"], to: "done" },
              recordTransitionAuditEvent: noAudit,
            }),
          ).toEqual({ type: "stale" });
          expect(
            await tx.execute(sql`SELECT * FROM transition_test_audit_events`),
          ).toEqual([]);
          const before = (await tx.select().from(fencedJobs)).at(0);
          expect(before?.status).toBe("queued");
          expect(before?.description).toBe("original");
          expect(
            await transition({
              tx,
              spec: claimed,
              id: "job",
              options: {
                from: ["queued"],
                to: "running",
                fence: date,
                set: {
                  description: "claimed",
                  payload: { labels: ["a", "b"], count: 2 },
                },
              },
              recordTransitionAuditEvent: recordTempAuditEvent,
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "job", status: "running" },
          });
          expect(
            await transition({
              tx,
              spec: lease,
              id: "job",
              options: { from: ["running"], to: "done", fence: "new-lease" },
              recordTransitionAuditEvent: recordTempAuditEvent,
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
            await transition({
              tx,
              spec: attempt,
              id: "attempt-success",
              options: { from: ["queued"], to: "running", fence: 2 },
              recordTransitionAuditEvent: recordTempAuditEvent,
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "attempt-success", status: "running" },
          });
          await tx
            .insert(fencedJobs)
            .values({ id: "null-lease", status: "queued", attempt: 1 });
          expect(
            await transition({
              tx,
              spec: lease,
              id: "null-lease",
              options: { from: ["queued"], to: "running", fence: null },
              recordTransitionAuditEvent: recordTempAuditEvent,
            }),
          ).toEqual({
            type: "transitioned",
            row: { id: "null-lease", status: "running" },
          });
          expect(
            await tx.execute(
              sql`SELECT resource_id, status FROM transition_test_audit_events ORDER BY resource_id, status`,
            ),
          ).toEqual([
            { resource_id: "attempt-success", status: "running" },
            { resource_id: "job", status: "done" },
            { resource_id: "job", status: "running" },
            { resource_id: "null-lease", status: "running" },
          ]);
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
