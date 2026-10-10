import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  systemAuditRuns,
  chatMessages,
  chatThreads,
} from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { clampSharedPoolTimeout } from "@/api/db/shared-pool-timeout-policy";
import { sharedPoolTimeoutPolicy } from "@/api/db/shared-pool-timeouts";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { readAuditedActivitySummary } from "./read";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type TestTransaction = TransactionOf<GatedTestDb>;

const withRollback = async (run: (tx: TestTransaction) => Promise<void>) => {
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const outcome = await Result.tryPromise({
      try: async () =>
        await openClient().db.transaction(async (tx) => {
          await run(tx);
          tx.rollback();
        }),
      catch: (cause) => cause,
    });
    if (
      Result.isError(outcome) &&
      !(outcome.error instanceof TransactionRollbackError)
    ) {
      throw outcome.error;
    }
    expect(Result.isError(outcome)).toBe(true);
  });
};

const auditIds = async (tx: TestTransaction) =>
  await tx
    .select({ id: systemAuditRuns.id })
    .from(systemAuditRuns)
    .where(eq(systemAuditRuns.actor, "system:operator-activity"));

type HistoricalAuditOptions = {
  tx: TestTransaction;
  bindings: Parameters<typeof createBackgroundAuditRecorder>[0];
  createdAt: Date;
  performerId: string | null;
};

const recordHistoricalAudit = async ({
  tx,
  bindings,
  createdAt,
  performerId,
}: HistoricalAuditOptions) => {
  const resourceId = createSafeId<"chatThread">();
  await createBackgroundAuditRecorder(bindings)(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId,
  });
  // Owner-only fixture adjustments share the enclosing rollback transaction.
  const updated = await tx
    .update(auditLogs)
    .set({ createdAt, performerId })
    .where(
      and(
        eq(auditLogs.organizationId, bindings.organizationId),
        eq(auditLogs.resourceId, resourceId),
      ),
    )
    .returning({ id: auditLogs.id });
  expect(updated).toHaveLength(1);
};

// Explicit Monday boundaries bracket Prague's short and long DST weeks.
const daylightSavingWeeks = [
  {
    now: "2030-04-03T12:00:00Z",
    current: "2030-03-31T22:00:00Z",
    previous: "2030-03-24T23:00:00Z",
    comparisonEnd: "2030-03-27T13:00:00Z",
    dates: [
      "2030-02-11",
      "2030-02-18",
      "2030-02-25",
      "2030-03-04",
      "2030-03-11",
      "2030-03-18",
      "2030-03-25",
      "2030-04-01",
    ],
  },
  {
    now: "2030-10-30T12:00:00Z",
    current: "2030-10-27T23:00:00Z",
    previous: "2030-10-20T22:00:00Z",
    comparisonEnd: "2030-10-23T11:00:00Z",
    dates: [
      "2030-09-09",
      "2030-09-16",
      "2030-09-23",
      "2030-09-30",
      "2030-10-07",
      "2030-10-14",
      "2030-10-21",
      "2030-10-28",
    ],
  },
];

describe.skipIf(!enabled)("operator activity database summary", () => {
  test.each(daylightSavingWeeks)(
    "aggregates eight Prague weeks ending in $current with distinct organizations and signup cohorts",
    async ({ now, current, previous, comparisonEnd, dates }) => {
      await withRollback(async (tx) => {
        const nowMs = Date.parse(now);
        const currentMs = Date.parse(current);
        const previousMs = Date.parse(previous);
        const baseline = await readAuditedActivitySummary(tx, nowMs);
        // Future fixture clocks keep percentage denominators independent of existing data.
        expect(
          baseline.weeks.every(
            ({ active_orgs, signups }) => active_orgs === 0 && signups === 0,
          ),
        ).toBe(true);
        const previousAudits = new Set(
          (await auditIds(tx)).map(({ id }) => id),
        );
        const orgA = mintAuthProviderId<"organization">();
        const orgB = mintAuthProviderId<"organization">();
        await tx.insert(organization).values(
          [orgA, orgB].map((id) => ({
            id,
            name: "Weekly fixture",
            slug: id,
            createdAt: new Date(previousMs),
          })),
        );
        const actor = mintAuthProviderId<"user">();
        await tx.insert(user).values({
          id: actor,
          name: "Weekly fixture",
          email: `${actor}@example.test`,
          createdAt: new Date(previousMs - 10 * 7 * 24 * 60 * 60_000),
        });
        const threadId = createSafeId<"chatThread">();
        await tx.insert(chatThreads).values({
          id: threadId,
          userId: actor,
          organizationId: orgA,
          title: "Weekly fixture",
        });
        for (const date of dates) {
          // UTC noon belongs to this Monday in either Prague offset.
          const at = new Date(`${date}T12:00:00Z`);
          if (date !== dates.at(0)) {
            await recordHistoricalAudit({
              tx,
              bindings: {
                organizationId: orgA,
                workspaceId: null,
                userId: actor,
                execution: {
                  performer: { type: "user", id: actor },
                  trigger: { type: "direct" },
                },
              },
              createdAt: at,
              performerId: null,
            });
          }
          await tx.insert(chatMessages).values({
            id: createSafeId<"chatMessage">(),
            threadId,
            userId: actor,
            role: "user",
            createdAt: at,
            content: toPersistedChatMessageContentV3({ data: [] }),
          });
        }
        await recordHistoricalAudit({
          tx,
          bindings: {
            organizationId: orgA,
            workspaceId: null,
            userId: actor,
            execution: {
              performer: { type: "user", id: actor },
              trigger: { type: "direct" },
            },
          },
          createdAt: new Date(previousMs),
          performerId: actor,
        });
        // This prior-week event is after the same-point comparison cutoff.
        await recordHistoricalAudit({
          tx,
          bindings: {
            organizationId: orgB,
            workspaceId: null,
            userId: actor,
            execution: {
              performer: { type: "user", id: actor },
              trigger: { type: "direct" },
            },
          },
          createdAt: new Date(Date.parse(comparisonEnd) + 1),
          performerId: actor,
        });
        // Automated actions and actions exactly at now do not activate a second org.
        for (const at of [nowMs - 1, nowMs]) {
          await recordHistoricalAudit({
            tx,
            bindings: {
              organizationId: orgB,
              workspaceId: null,
              userId: actor,
              execution: {
                performer:
                  at === nowMs
                    ? { type: "user", id: actor }
                    : { type: "agent", id: actor, name: null },
                trigger: { type: "direct" },
              },
            },
            createdAt: new Date(at),
            performerId: actor,
          });
        }
        // A newly active org must not inflate retention of the prior cohort.
        const orgC = mintAuthProviderId<"organization">();
        await tx.insert(organization).values({
          id: orgC,
          name: "Newly active fixture",
          slug: orgC,
          createdAt: new Date(currentMs),
        });
        await recordHistoricalAudit({
          tx,
          bindings: {
            organizationId: orgC,
            workspaceId: null,
            userId: actor,
            execution: {
              performer: { type: "user", id: actor },
              trigger: { type: "direct" },
            },
          },
          createdAt: new Date(currentMs),
          performerId: actor,
        });
        const assistantThreadId = createSafeId<"chatThread">();
        await tx.insert(chatThreads).values({
          id: assistantThreadId,
          userId: actor,
          organizationId: orgB,
          title: "Automated fixture",
        });
        await tx.insert(chatMessages).values({
          id: createSafeId<"chatMessage">(),
          threadId: assistantThreadId,
          userId: actor,
          role: "assistant",
          createdAt: new Date(nowMs - 1),
          content: toPersistedChatMessageContentV3({ data: [] }),
        });
        const cohorts = [
          {
            signup: previousMs + 60_000,
            action: previousMs + 60_000,
            lifecycle: "live",
          },
          {
            signup: previousMs + 120_000,
            action: previousMs + 120_000 + 24 * 60 * 60_000,
            lifecycle: "live",
          },
          {
            signup: currentMs - 60_000,
            action: currentMs + 60_000,
            lifecycle: "live",
          },
          { signup: nowMs - 1, action: null, lifecycle: "live" },
          { signup: nowMs, action: null, lifecycle: "live" },
          {
            signup: previousMs + 180_000,
            action: previousMs + 180_000,
            lifecycle: "deleted",
          },
        ] as const;
        for (const { signup, action, lifecycle } of cohorts) {
          const userId = mintAuthProviderId<"user">();
          await tx.insert(user).values({
            id: userId,
            name: "Signup fixture",
            email: `${userId}@example.test`,
            createdAt: new Date(signup),
            deletedAt: lifecycle === "deleted" ? new Date(nowMs) : null,
          });
          if (action === null) {
            continue;
          }
          await recordHistoricalAudit({
            tx,
            bindings: {
              organizationId: orgA,
              workspaceId: null,
              userId: actor,
              execution: {
                performer: { type: "user", id: userId },
                trigger: { type: "direct" },
              },
            },
            createdAt: new Date(action),
            performerId: userId,
          });
        }
        const summary = await readAuditedActivitySummary(tx, nowMs);
        expect(summary.generated_at).toBe(now);
        expect(summary.timezone).toBe("Europe/Prague");
        expect(summary.weeks.map(({ week_start }) => week_start)).toEqual(
          dates,
        );
        expect(summary.weeks.map(({ partial }) => partial)).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
          false,
          true,
        ]);
        expect(summary.weeks.map(({ active_orgs }) => active_orgs)).toEqual([
          1, 1, 1, 1, 1, 1, 2, 2,
        ]);
        expect(summary.weeks.map(({ signups }) => signups)).toEqual([
          0, 0, 0, 0, 0, 0, 3, 1,
        ]);
        const previousWeek = summary.weeks.at(6);
        const currentWeek = summary.weeks.at(7);
        expect(previousWeek?.activated_24h_pct).toBeCloseTo(200 / 3);
        expect(currentWeek?.activated_24h_pct).toBe(0);
        expect(
          summary.weeks.map(({ weekly_retention_pct }) => weekly_retention_pct),
        ).toEqual([null, 100, 100, 100, 100, 100, 100, 50]);
        expect(summary.same_point_last_week.active_orgs).toBe(1);
        expect(summary.same_point_last_week.signups).toBe(2);
        const added = (
          await tx
            .select()
            .from(systemAuditRuns)
            .where(eq(systemAuditRuns.actor, "system:operator-activity"))
        ).filter(({ id }) => !previousAudits.has(id));
        expect(added).toHaveLength(1);
        expect(added.at(0)?.counts).toEqual({ reads: 1 });
        expect(JSON.stringify(added)).not.toContain("@example.test");
      });
    },
  );

  test("an empty future window returns eight zero weeks with explicit unavailable ratios and an audit", async () => {
    await withRollback(async (tx) => {
      const previous = new Set((await auditIds(tx)).map(({ id }) => id));
      const summary = await readAuditedActivitySummary(
        tx,
        Date.parse("9999-01-08T12:00:00Z"),
      );
      expect(summary.weeks).toHaveLength(8);
      for (const week of summary.weeks) {
        expect(week.active_orgs).toBe(0);
        expect(week.signups).toBe(0);
        expect(week.activated_24h_pct).toBeNull();
        expect(week.weekly_retention_pct).toBeNull();
        expect(
          summary.unavailable_reasons[
            `weeks.${week.week_start}.activated_24h_pct`
          ],
        ).toBe("No signups in this week.");
        expect(
          summary.unavailable_reasons[
            `weeks.${week.week_start}.weekly_retention_pct`
          ],
        ).toBe("No active organizations in the preceding week.");
      }
      expect(summary.same_point_last_week.active_orgs).toBe(0);
      expect(summary.same_point_last_week.signups).toBe(0);
      const added = (
        await tx
          .select()
          .from(systemAuditRuns)
          .where(eq(systemAuditRuns.actor, "system:operator-activity"))
      ).filter(({ id }) => !previous.has(id));
      expect(added).toHaveLength(1);
      expect(added.at(0)?.counts).toEqual({ reads: 1 });
    });
  });

  test("the aggregate installs a bounded statement timeout", async () => {
    await withRollback(async (tx) => {
      await readAuditedActivitySummary(tx, Date.parse("9999-01-08T12:00:00Z"));
      const row = executedRows(
        await tx.execute(
          sql`SELECT current_setting('statement_timeout') AS timeout`,
        ),
      ).at(0);
      const expectedMs = clampSharedPoolTimeout(2000, sharedPoolTimeoutPolicy);
      expect(row).toEqual({
        timeout:
          expectedMs % 1000 === 0 ? `${expectedMs / 1000}s` : `${expectedMs}ms`,
      });
    });
  });

  test("audit insertion failure refuses to return a summary", async () => {
    await withRollback(async (tx) => {
      const previous = await auditIds(tx);
      const read = readAuditedActivitySummary(
        {
          select: tx.select.bind(tx),
          execute: tx.execute.bind(tx),
          insert: () => {
            throw new TypeError("Audit insertion unavailable");
          },
        },
        Date.parse("9999-01-08T12:00:00Z"),
      );
      expect(await rejectionOf(read)).toEqual(
        new TypeError("Audit insertion unavailable"),
      );
      expect(await auditIds(tx)).toEqual(previous);
    });
  });

  test("the production aggregate has indexed access paths for each source", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const statements: { query: string; params: unknown[] }[] = [];
      const db = openClient({
        logger: {
          logQuery: (query, params) => {
            statements.push({ query, params });
          },
        },
      }).db;
      const outcome = await Result.tryPromise({
        try: async () =>
          await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL enable_seqscan = off`);
            await readAuditedActivitySummary(
              tx,
              Date.parse("9999-01-08T12:00:00Z"),
            );
            const aggregate = statements.find(
              ({ query }) =>
                query.startsWith("select") &&
                query.includes('"chat_messages"') &&
                query.includes('"audit_logs"') &&
                query.includes('"user"'),
            );
            if (aggregate === undefined) {
              throw new TypeError("Production aggregate query required");
            }
            // Rebind the captured query, rather than maintaining a second SQL implementation.
            const pieces = aggregate.query.split(/(\$\d+)/u).map((part) => {
              if (!/^\$\d+$/u.test(part)) {
                return sql.raw(part);
              }
              return sql`${aggregate.params.at(Number(part.slice(1)) - 1)}`;
            });
            const plan = executedRows(
              await tx.execute(
                sql`EXPLAIN (FORMAT TEXT) ${sql.join(pieces, sql``)}`,
              ),
            );
            const rendered = JSON.stringify(plan);
            expect(rendered).not.toContain("Seq Scan");
            expect(rendered).toContain("Index");
            // Empty CI tables make the chosen index a cost tie; production
            // statistics, not this plan, decide between BRIN and the btree.
            const timeIndexes = executedRows(
              await tx.execute(
                sql`SELECT indexname, indexdef FROM pg_indexes
                  WHERE schemaname = current_schema()
                    AND indexname IN ('chat_messages_created_at_brin_idx', 'audit_logs_created_at_brin_idx')
                  ORDER BY indexname`,
              ),
            );
            expect(timeIndexes).toEqual([
              {
                indexname: "audit_logs_created_at_brin_idx",
                indexdef: expect.stringContaining("USING brin (created_at)"),
              },
              {
                indexname: "chat_messages_created_at_brin_idx",
                indexdef: expect.stringContaining("USING brin (created_at)"),
              },
            ]);
            tx.rollback();
          }),
        catch: (cause) => cause,
      });
      if (
        Result.isError(outcome) &&
        !(outcome.error instanceof TransactionRollbackError)
      ) {
        throw outcome.error;
      }
      expect(Result.isError(outcome)).toBe(true);
    });
  });
});
