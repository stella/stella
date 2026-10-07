import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization, user } from "@/api/db/auth-schema";
import {
  systemAuditRuns,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { clampSharedPoolTimeout } from "@/api/db/shared-pool-timeout-policy";
import { sharedPoolTimeoutPolicy } from "@/api/db/shared-pool-timeouts";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import {
  ACTIVITY_UNAVAILABLE_REASONS,
  readAuditedActivitySummary,
} from "./read";

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

// Explicit UTC boundaries are independent of the production calendar calculation.
const daylightSavingDays = [
  { now: "2026-03-29T21:30:00Z", start: "2026-03-28T23:00:00Z" },
  { now: "2026-10-25T22:30:00Z", start: "2026-10-24T22:00:00Z" },
];

describe.skipIf(!enabled)("operator activity database summary", () => {
  test.each(daylightSavingDays)(
    "counts both tenants within the Prague day starting $start",
    async ({ now, start }) => {
      await withRollback(async (tx) => {
        const nowMs = Date.parse(now);
        const startMs = Date.parse(start);
        // A service-backed database can contain unrelated rows; compare fixture deltas.
        const before = await readAuditedActivitySummary(tx, nowMs);
        const previousAudits = new Set(
          (await auditIds(tx)).map(({ id }) => id),
        );
        const createdTimes = [
          startMs - 1,
          startMs,
          nowMs - 1,
          nowMs,
          nowMs + 1,
          nowMs - 7 * 24 * 60 * 60 * 1000,
          nowMs - 7 * 24 * 60 * 60 * 1000 - 1,
          startMs + 1,
        ];
        const users = createdTimes.map(() => mintAuthProviderIdValue());
        await tx.insert(user).values(
          createdTimes.map((createdAt, index) => {
            const id = users.at(index);
            if (id === undefined) {
              throw new TypeError("Fixture user required");
            }
            return {
              id,
              name: "Activity fixture",
              email: `${id}@example.test`,
              createdAt: new Date(createdAt),
              deletedAt: index === 7 ? new Date(nowMs) : null,
            };
          }),
        );
        const turnTimes = [
          nowMs - 60 * 60 * 1000 - 1,
          nowMs - 60 * 60 * 1000,
          nowMs - 1,
          nowMs,
          nowMs + 1,
        ];
        for (const tenant of [0, 1]) {
          const userId = users.at(tenant);
          if (userId === undefined) {
            throw new TypeError("Fixture user required");
          }
          const organizationId = mintAuthProviderId<"organization">();
          await tx.insert(organization).values({
            id: organizationId,
            name: "Activity fixture",
            slug: organizationId,
            createdAt: new Date(startMs),
          });
          for (const createdAt of turnTimes) {
            // Accepted turns are unique per thread, including fixture rows.
            const threadId = createSafeId<"chatThread">();
            await tx.insert(chatThreads).values({
              id: threadId,
              userId,
              organizationId,
              title: "Activity fixture",
            });
            const userMessageId = createSafeId<"chatMessage">();
            await tx.insert(chatMessages).values({
              id: userMessageId,
              userId,
              threadId,
              role: "user",
              content: toPersistedChatMessageContentV3({
                data: [{ type: "text", content: "Activity fixture" }],
              }),
            });
            await tx.insert(chatTurns).values({
              id: createSafeId<"chatTurn">(),
              organizationId,
              userId,
              threadId,
              userMessageId,
              createdAt: new Date(createdAt),
              leaseExpiresAt: new Date(nowMs + 60_000),
            });
          }
        }
        const summary = await readAuditedActivitySummary(tx, nowMs);
        expect(summary.signups_today - before.signups_today).toBe(2);
        expect(summary.signups_7d - before.signups_7d).toBe(4);
        expect(summary.chat_turns_1h - before.chat_turns_1h).toBe(4);
        expect(summary.generated_at).toBe(now);
        expect(summary.sessions_active_5m).toBeNull();
        expect(summary.users_active_today).toBeNull();
        expect(summary.tool_calls_1h).toBeNull();
        expect(summary.unavailable_reasons).toEqual(
          ACTIVITY_UNAVAILABLE_REASONS,
        );
        const audits = await tx
          .select()
          .from(systemAuditRuns)
          .where(eq(systemAuditRuns.actor, "system:operator-activity"));
        const added = audits.filter(({ id }) => !previousAudits.has(id));
        expect(added).toHaveLength(1);
        expect(added.at(0)?.counts).toEqual({ reads: 1 });
        expect(JSON.stringify(added)).not.toContain("@example.test");
      });
    },
  );

  test("an empty future window returns zero counts and records an access audit", async () => {
    await withRollback(async (tx) => {
      const previous = new Set((await auditIds(tx)).map(({ id }) => id));
      const summary = await readAuditedActivitySummary(
        tx,
        Date.parse("9999-01-08T12:00:00Z"),
      );
      expect(summary.signups_today).toBe(0);
      expect(summary.signups_7d).toBe(0);
      expect(summary.chat_turns_1h).toBe(0);
      const audits = await tx
        .select()
        .from(systemAuditRuns)
        .where(eq(systemAuditRuns.actor, "system:operator-activity"));
      const added = audits.filter(({ id }) => !previous.has(id));
      expect(added).toHaveLength(1);
      expect(added.at(0)?.counts).toEqual({ reads: 1 });
    });
  });

  test("the aggregate installs a bounded statement timeout", async () => {
    await withRollback(async (tx) => {
      await readAuditedActivitySummary(
        {
          transaction: async (run) =>
            await tx.transaction(async (nested) => {
              const summary = await run(nested);
              const row = executedRows(
                await nested.execute(
                  sql`SELECT current_setting('statement_timeout') AS timeout`,
                ),
              ).at(0);
              const expectedMs = clampSharedPoolTimeout(
                2000,
                sharedPoolTimeoutPolicy,
              );
              expect(row).toEqual({
                timeout:
                  expectedMs % 1000 === 0
                    ? `${expectedMs / 1000}s`
                    : `${expectedMs}ms`,
              });
              return summary;
            }),
        },
        Date.parse("9999-01-08T12:00:00Z"),
      );
    });
  });

  test("audit insertion failure refuses to return a summary", async () => {
    await withRollback(async (tx) => {
      const previous = await auditIds(tx);
      const read = readAuditedActivitySummary(
        {
          transaction: async (run) =>
            await tx.transaction(
              async (nested) =>
                await run({
                  select: nested.select.bind(nested),
                  execute: nested.execute.bind(nested),
                  insert: () => {
                    throw new TypeError("Audit insertion unavailable");
                  },
                }),
            ),
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
                query.includes('"chat_turns"') &&
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
            expect(rendered).toContain("chat_turns");
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
