import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { jsonb } from "@/api/db/columns";
import { compareAndSetStructuredState } from "@/api/lib/db/transitions";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const structuredRows = pgTable("structured_state_transition_rows", {
  id: text().primaryKey(),
  revision: integer().notNull(),
  state: jsonb().$type<{ revision: number; value: string }>().notNull(),
});

const stateSchema = v.object({
  revision: v.pipe(v.number(), v.integer()),
  value: v.pipe(v.string(), v.trim()),
});

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.execute(sql`
    CREATE TEMPORARY TABLE structured_state_transition_rows (
      id text PRIMARY KEY,
      revision integer NOT NULL,
      state jsonb NOT NULL
    ) ON COMMIT PRESERVE ROWS
  `);
  await db.execute(sql`
    CREATE TEMPORARY TABLE structured_state_transition_audits (id text NOT NULL)
  `);
});

afterAll(async () => {
  await client.close();
});

describe("structured state transitions", () => {
  test("writes the caller schema's normalized state and audits applied rows", async () => {
    await db.insert(structuredRows).values({
      id: "normalized",
      revision: 1,
      state: { revision: 1, value: "old" },
    });

    const result = await db.transaction(
      async (tx) =>
        await compareAndSetStructuredState({
          tx,
          column: structuredRows.state,
          identity: structuredRows.id,
          schema: stateSchema,
          changes: [
            {
              id: "normalized",
              value: { revision: 2, value: "  canonical  " },
              fence: eq(structuredRows.revision, 1),
            },
          ],
          recordTransitionAuditEvent: async (auditTx, ids) => {
            for (const id of ids) {
              await auditTx.execute(
                sql`INSERT INTO structured_state_transition_audits (id) VALUES (${id})`,
              );
            }
          },
        }),
    );

    expect(result).toEqual({ type: "updated", ids: ["normalized"] });
    expect(await db.select().from(structuredRows)).toEqual([
      {
        id: "normalized",
        revision: 1,
        state: { revision: 2, value: "canonical" },
      },
    ]);
    expect(
      (await db.execute(sql`SELECT id FROM structured_state_transition_audits`))
        .rows,
    ).toEqual([{ id: "normalized" }]);
  });

  test("returns stale for a caller revision fence without writing or auditing", async () => {
    await db.insert(structuredRows).values({
      id: "stale",
      revision: 3,
      state: { revision: 3, value: "current" },
    });

    const result = await db.transaction(
      async (tx) =>
        await compareAndSetStructuredState({
          tx,
          column: structuredRows.state,
          identity: structuredRows.id,
          schema: stateSchema,
          changes: [
            {
              id: "stale",
              value: { revision: 4, value: "should not persist" },
              fence: eq(structuredRows.revision, 2),
            },
          ],
          recordTransitionAuditEvent: async (auditTx, ids) => {
            for (const id of ids) {
              await auditTx.execute(
                sql`INSERT INTO structured_state_transition_audits (id) VALUES (${id})`,
              );
            }
          },
        }),
    );

    expect(result).toEqual({ type: "stale-fence" });
    expect(
      await db
        .select()
        .from(structuredRows)
        .where(eq(structuredRows.id, "stale")),
    ).toEqual([
      {
        id: "stale",
        revision: 3,
        state: { revision: 3, value: "current" },
      },
    ]);
    expect(
      (
        await db.execute(
          sql`SELECT id FROM structured_state_transition_audits WHERE id = 'stale'`,
        )
      ).rows,
    ).toEqual([]);
  });

  test("rejects an invalid member before writing or auditing any batch row", async () => {
    await db.insert(structuredRows).values([
      {
        id: "valid-batch",
        revision: 1,
        state: { revision: 1, value: "before" },
      },
      {
        id: "invalid-batch",
        revision: 1,
        state: { revision: 1, value: "before" },
      },
    ]);

    const result = await db.transaction(
      async (tx) =>
        await compareAndSetStructuredState({
          tx,
          column: structuredRows.state,
          identity: structuredRows.id,
          schema: stateSchema,
          changes: [
            {
              id: "valid-batch",
              value: { revision: 2, value: "valid" },
              fence: eq(structuredRows.revision, 1),
            },
            {
              id: "invalid-batch",
              value: { revision: 2, value: 42 },
              fence: eq(structuredRows.revision, 1),
            },
          ],
          recordTransitionAuditEvent: async (auditTx, ids) => {
            for (const id of ids) {
              await auditTx.execute(
                sql`INSERT INTO structured_state_transition_audits (id) VALUES (${id})`,
              );
            }
          },
        }),
    );

    expect(result).toMatchObject({ type: "schema-rejected" });
    expect(
      await db
        .select()
        .from(structuredRows)
        .where(eq(structuredRows.id, "valid-batch")),
    ).toEqual([
      {
        id: "valid-batch",
        revision: 1,
        state: { revision: 1, value: "before" },
      },
    ]);
    expect(
      await db
        .select()
        .from(structuredRows)
        .where(eq(structuredRows.id, "invalid-batch")),
    ).toEqual([
      {
        id: "invalid-batch",
        revision: 1,
        state: { revision: 1, value: "before" },
      },
    ]);
    expect(
      (
        await db.execute(
          sql`SELECT id FROM structured_state_transition_audits WHERE id IN ('valid-batch', 'invalid-batch')`,
        )
      ).rows,
    ).toEqual([]);
  });
});
