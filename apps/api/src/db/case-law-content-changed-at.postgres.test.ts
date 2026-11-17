import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { sql, TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  CASE_LAW_CONTENT_CHANGE_FUNCTION,
  CASE_LAW_CONTENT_CHANGE_TRIGGER,
  CASE_LAW_CONTENT_COLUMNS,
  type CaseLawContentColumn,
  CONTENT_COMPARISON,
} from "@/api/db/case-law-content-changed-at";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type Transaction = Parameters<Parameters<GatedTestDb["transaction"]>[0]>[0];

/** Runs `work` and rolls it back, so no fixture outlives its test. */
const rolledBack = async (
  db: GatedTestDb,
  work: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  const outcome = await Result.tryPromise({
    try: async () =>
      await db.transaction(async (tx) => {
        await work(tx);
        tx.rollback();
      }),
    catch: (error) => error,
  });
  expect(
    outcome.isErr() && outcome.error instanceof TransactionRollbackError,
  ).toBe(true);
};

const insertSource = async (tx: Transaction) => {
  const sourceId = createSafeId<"caseLawSource">();
  await tx.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${sourceId}, ${`content-change-${sourceId}`}, 'content change fixture')`);
  return sourceId;
};

const insertDecision = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
  createdAt: SQL = sql`DEFAULT`,
) => {
  const id = createSafeId<"caseLawDecision">();
  await tx.execute(sql`INSERT INTO case_law_decisions
    (id, source_id, case_number, court, country, language, fulltext, metadata,
      created_at)
    VALUES (${id}, ${sourceId}, ${`content-${id}`}, 'fixture court', 'POL',
      'pl', 'abc', '{"title": "first", "keywords": ["a"]}'::jsonb,
      ${createdAt})`);
  return id;
};

/**
 * Every content column as the trigger compares it, read back so the test
 * compares the row in JavaScript rather than by the trigger's own SQL.
 */
const contentProjection = sql.raw(
  Object.entries(CASE_LAW_CONTENT_COLUMNS)
    .map(([column, comparison]) =>
      comparison === CONTENT_COMPARISON.storedSize
        ? `octet_length(${column})::text AS ${column}`
        : `${column}::text AS ${column}`,
    )
    .join(", "),
);

type Snapshot = {
  stamp: string | null;
  createdAt: string;
  transactionStart: string;
  content: Record<string, string | null>;
};

const snapshotOf = async (tx: Transaction, id: string): Promise<Snapshot> => {
  const rows = await tx.execute<Record<string, string | null>>(sql`
    SELECT content_changed_at::text AS stamp,
      created_at::text AS created,
      now()::text AS transaction_start,
      ${contentProjection}
    FROM case_law_decisions WHERE id = ${id}`);
  const row = rows.at(0);
  if (row === undefined) {
    throw new Error("decision fixture disappeared");
  }
  const { stamp, created, transaction_start: start, ...content } = row;
  if (
    created === undefined ||
    created === null ||
    start === undefined ||
    start === null
  ) {
    throw new Error("decision fixture lacks its creation time");
  }
  return {
    stamp: stamp ?? null,
    createdAt: created,
    transactionStart: start,
    content,
  };
};

const update = async (tx: Transaction, id: string, assignment: SQL) => {
  await tx.execute(
    sql`UPDATE case_law_decisions SET ${assignment} WHERE id = ${id}`,
  );
};

type ColumnWrites = {
  /**
   * Leaves the fixture where the change is allowed without touching this
   * column: a redacted row holds no text.
   */
  prepare?: SQL;
  /** Writes a value that differs from the fixture's. */
  changed: (otherSourceId: SafeId<"caseLawSource">) => SQL;
};

/**
 * One change per content column. Typed by the owner list, so a column added
 * to it does not compile here until it has a change the trigger must see.
 */
const CONTENT_WRITES = {
  source_id: { changed: (otherSourceId) => sql`source_id = ${otherSourceId}` },
  redacted_at: {
    prepare: sql`fulltext = NULL`,
    changed: () => sql`redacted_at = clock_timestamp()`,
  },
  country: { changed: () => sql`country = 'CZE'` },
  case_number: { changed: () => sql`case_number = case_number || '-2'` },
  court: { changed: () => sql`court = court || ' II'` },
  decision_type: { changed: () => sql`decision_type = 'judgment'` },
  ecli: { changed: () => sql`ecli = 'ECLI:PL:FX:2026:1'` },
  fulltext: { changed: () => sql`fulltext = fulltext || 'd'` },
  metadata: {
    changed: () => sql`metadata = metadata || '{"title": "second"}'::jsonb`,
  },
} as const satisfies Record<CaseLawContentColumn, ColumnWrites>;

/** Writes that leave every content column's value as it was. */
const UNCHANGED_WRITES = [
  sql`decision_date = DATE '2020-01-02'`,
  sql`language = 'cs'`,
  sql`citation_count = citation_count + 1`,
  sql`updated_at = clock_timestamp()`,
  sql`extraction_warnings = '[{"code": "fixture"}]'::jsonb`,
  // A rewrite of the same text, and a new text of the same stored size.
  sql`fulltext = fulltext`,
  sql`fulltext = repeat('x', octet_length(fulltext))`,
  // Equal JSON written as a new value, with its keys in another order.
  sql`metadata = '{"keywords": ["a"], "title": "first"}'::jsonb`,
  // The stamp is the trigger's: a writer's value is discarded.
  sql`content_changed_at = TIMESTAMPTZ '2001-01-01 00:00:00+00'`,
] as const;

type WriteStep =
  | { type: "content"; column: CaseLawContentColumn }
  | { type: "other"; index: number };

/** A step's assignment: a content column's change, or a write that keeps it. */
const assignmentOf = (
  step: WriteStep,
  otherSourceId: SafeId<"caseLawSource">,
): SQL => {
  if (step.type === "other") {
    return UNCHANGED_WRITES[step.index] ?? sql`language = language`;
  }
  const write: ColumnWrites = CONTENT_WRITES[step.column];
  return write.prepare === undefined
    ? write.changed(otherSourceId)
    : sql`${write.prepare}, ${write.changed(otherSourceId)}`;
};

/** Whether any content column's value differs, compared in JavaScript. */
const contentDiffers = (left: Snapshot, right: Snapshot): boolean =>
  Object.keys(CASE_LAW_CONTENT_COLUMNS).some(
    (column) => left.content[column] !== right.content[column],
  );

const contentColumns = Object.keys(
  CASE_LAW_CONTENT_COLUMNS,
) as CaseLawContentColumn[];

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law content change stamp (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("case-law content change stamp (postgres)", () => {
    test("an insert stamps its creation time", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await rolledBack(db, async (tx) => {
          const id = await insertDecision(tx, await insertSource(tx));
          const row = await snapshotOf(tx, id);
          expect(row.stamp).toBe(row.createdAt);
        });
      });
    });

    // A reader that waits out the transactions older than an instant must
    // still see a row whose writer backdated it.
    test("an insert with a chosen creation time stamps the clock", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await rolledBack(db, async (tx) => {
          const id = await insertDecision(
            tx,
            await insertSource(tx),
            sql`TIMESTAMPTZ '2001-01-01 00:00:00+00'`,
          );
          const row = await snapshotOf(tx, id);
          expect(row.createdAt).not.toBe(row.stamp);
          expect(row.stamp).not.toBeNull();
          expect(Date.parse(row.stamp ?? "")).toBeGreaterThanOrEqual(
            Date.parse(row.transactionStart),
          );
        });
      });
    });

    for (const column of contentColumns) {
      test(`a raw write that changes ${column} moves the stamp`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          await rolledBack(db, async (tx) => {
            const sourceId = await insertSource(tx);
            const otherSourceId = await insertSource(tx);
            const id = await insertDecision(tx, sourceId);
            const write: ColumnWrites = CONTENT_WRITES[column];
            if (write.prepare !== undefined) {
              await update(tx, id, write.prepare);
            }
            const before = await snapshotOf(tx, id);
            await update(tx, id, write.changed(otherSourceId));
            const after = await snapshotOf(tx, id);
            // The fixture reaches the column: its value did change.
            expect(after.content[column]).not.toBe(before.content[column]);
            expect(after.stamp).not.toBeNull();
            expect(after.stamp).not.toBe(before.stamp);
          });
        });
      });

      test(`a raw write of ${column}'s own value keeps the stamp`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          await rolledBack(db, async (tx) => {
            const id = await insertDecision(tx, await insertSource(tx));
            const before = await snapshotOf(tx, id);
            await update(
              tx,
              id,
              sql`${sql.identifier(column)} = ${sql.identifier(column)}`,
            );
            expect((await snapshotOf(tx, id)).stamp).toBe(before.stamp);
          });
        });
      });
    }

    test("a write that changes no content column keeps the stamp", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await rolledBack(db, async (tx) => {
          const id = await insertDecision(tx, await insertSource(tx));
          const before = await snapshotOf(tx, id);
          for (const write of UNCHANGED_WRITES) {
            // db-await-in-loop: each write is the step whose result is checked.
            await update(tx, id, write);
            const after = await snapshotOf(tx, id);
            expect(after.content).toEqual(before.content);
            expect(after.stamp).toBe(before.stamp);
          }
        });
      });
    });

    // A column list fires only for the columns a statement names, so it
    // would miss a content column an earlier trigger rewrites. The stamp
    // fires on every write and compares the row the earlier triggers leave.
    test("the stamp fires on every insert and update, not on a column list", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const rows = await db.execute<{ columns: string; type: number }>(sql`
          SELECT tgattr::text AS columns, tgtype::int AS type FROM pg_trigger
          WHERE tgrelid = 'public.case_law_decisions'::regclass
            AND tgname = ${CASE_LAW_CONTENT_CHANGE_TRIGGER}`);
        // tgtype 23: row-level (1), before (2), on insert (4) and update (16).
        expect(rows).toEqual([{ columns: "", type: 23 }]);
      });
    });

    test("the stamp moves exactly when a content column's value changed", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const writeStep = fc.oneof(
          fc.constantFrom(...contentColumns).map((column) => ({
            type: "content" as const,
            column,
          })),
          fc
            .integer({ min: 0, max: UNCHANGED_WRITES.length - 1 })
            .map((index) => ({ type: "other" as const, index })),
        );
        await assertProperty(
          "the stamp moves exactly when a content column's value changed",
          fc.asyncProperty(
            fc.array(writeStep, { minLength: 1, maxLength: 8 }),
            async (writes) => {
              await rolledBack(db, async (tx) => {
                const otherSourceId = await insertSource(tx);
                const id = await insertDecision(tx, await insertSource(tx));
                let previous = await snapshotOf(tx, id);
                for (const step of writes) {
                  // db-await-in-loop: each write is the step whose result the property checks.
                  await update(tx, id, assignmentOf(step, otherSourceId));
                  const next = await snapshotOf(tx, id);
                  expect(next.stamp !== previous.stamp).toBe(
                    contentDiffers(previous, next),
                  );
                  previous = next;
                }
              });
            },
          ),
          { numRuns: 30 },
        );
      });
    });

    // The owner list and the trigger function name the same columns, each
    // compared the way the list says, in both directions.
    test("the trigger compares exactly the owner list's columns", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const rows = await db.execute<{ source: string }>(sql`
          SELECT prosrc AS source FROM pg_proc
          WHERE proname = ${CASE_LAW_CONTENT_CHANGE_FUNCTION}`);
        const source = rows.at(0)?.source ?? "";
        const compared = (row: "OLD" | "NEW") => {
          const sized = new Set(
            [
              ...source.matchAll(
                new RegExp(String.raw`octet_length\(${row}\.(\w+)\)`, "gu"),
              ),
            ].map((match) => match[1]),
          );
          return Object.fromEntries(
            [...source.matchAll(new RegExp(String.raw`\b${row}\.(\w+)`, "gu"))]
              .map((match) => match[1] ?? "")
              .filter((column) => column !== "content_changed_at")
              .map((column) => [
                column,
                sized.has(column)
                  ? CONTENT_COMPARISON.storedSize
                  : CONTENT_COMPARISON.value,
              ]),
          );
        };
        // `NEW.created_at` is read only to stamp an insert.
        const { created_at: insertStamp, ...updated } = compared("NEW");
        expect(insertStamp).toBe(CONTENT_COMPARISON.value);
        expect(updated).toEqual(CASE_LAW_CONTENT_COLUMNS);
        expect(compared("OLD")).toEqual(CASE_LAW_CONTENT_COLUMNS);
      });
    });

    // Row triggers of one timing fire in name order. Every before-row
    // trigger that can write a content column must fire first; the only one
    // after it derives the parsed-input state and writes no content column.
    test("the stamp fires after every before-row trigger that writes content", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const rows = await db.execute<{ name: string }>(sql`
          SELECT tgname AS name FROM pg_trigger
          WHERE tgrelid = 'public.case_law_decisions'::regclass
            AND NOT tgisinternal
            AND (tgtype & 1) = 1
            AND (tgtype & 2) = 2
          ORDER BY tgname COLLATE "C"`);
        const names = rows.map(({ name }) => name);
        expect(
          names.slice(names.indexOf(CASE_LAW_CONTENT_CHANGE_TRIGGER)),
        ).toEqual([
          CASE_LAW_CONTENT_CHANGE_TRIGGER,
          "case_law_decisions_zz_parsed_input_state",
        ]);
      });
    });
  });
}
