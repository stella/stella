import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { replaySelectionPredicate } from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const STATE_TRIGGER = "case_law_decisions_zz_parsed_input_state";
const CURRENT_PARSER = 3;

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
    VALUES (${sourceId}, ${`parsed-input-${sourceId}`}, 'parsed input fixture')`);
  return sourceId;
};

const insertDecision = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
) => {
  const id = createSafeId<"caseLawDecision">();
  await tx.execute(sql`INSERT INTO case_law_decisions
    (id, source_id, case_number, court, country, language, parser_version,
      source_hash, source_hash_version, source_raw_s3_key,
      parsed_source_hash, parsed_source_hash_version, parsed_source_raw_s3_key)
    VALUES (${id}, ${sourceId}, ${`state-${id}`}, 'fixture court', 'POL', 'pl',
      ${CURRENT_PARSER}, 'h1', 1, 'raw/k1', 'h1', 1, 'raw/k1')`);
  return id;
};

/** The stored state beside what the comparison function says it must be. */
const stateOf = async (tx: Transaction, id: string) =>
  (
    await tx.execute<{ stored: string | null; derived: string }>(sql`
      SELECT parsed_input_state AS stored,
        case_law_parsed_input_state(source_hash, source_hash_version,
          source_raw_s3_key, parsed_source_hash, parsed_source_hash_version,
          parsed_source_raw_s3_key) AS derived
      FROM case_law_decisions WHERE id = ${id}`)
  ).at(0);

// A write of one kind: the input moves, a parse of the current input is
// recorded, a column the invalidation watches changes, or a writer claims a
// state outright.
const WRITES = [
  sql`source_hash = CASE WHEN source_hash = 'h1' THEN 'h2' ELSE 'h1' END`,
  sql`source_hash_version = 1 - source_hash_version`,
  sql`source_raw_s3_key = CASE WHEN source_raw_s3_key = 'raw/k1' THEN 'raw/k2' ELSE 'raw/k1' END`,
  sql`parsed_source_hash = source_hash, parsed_source_hash_version = source_hash_version, parsed_source_raw_s3_key = source_raw_s3_key`,
  sql`parsed_source_hash = 'stale', parsed_source_hash_version = 0, parsed_source_raw_s3_key = 'raw/stale'`,
  sql`court = court || '.'`,
  sql`parser_version = parser_version + 1`,
  sql`parsed_input_state = 'parsed'`,
  sql`parsed_input_state = 'unparsed'`,
] as const;

// Independent sessions and installed migration triggers need the
// Postgres-gated runner's fully migrated database.
if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law parsed-input state (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("case-law parsed-input state (postgres)", () => {
    // Row triggers of one timing fire in name order, so the state trigger
    // must sort after every trigger that can change the row it reads.
    test("the state trigger fires after every other before-row trigger on decisions", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const rows = await db.execute<{ name: string }>(sql`
          SELECT tgname AS name FROM pg_trigger
          WHERE tgrelid = 'public.case_law_decisions'::regclass
            AND NOT tgisinternal
            AND (tgtype & 1) = 1
            AND (tgtype & 2) = 2
            AND (tgtype & (4 | 16)) <> 0
          ORDER BY tgname COLLATE "C"`);
        const names = rows.map(({ name }) => name);
        expect(names).toContain(
          "case_law_decisions_parsed_source_invalidation",
        );
        expect(names.at(-1)).toBe(STATE_TRIGGER);
      });
    });

    test("an invalidation in the same update leaves the row unparsed", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await rolledBack(db, async (tx) => {
          const id = await insertDecision(tx, await insertSource(tx));
          expect(await stateOf(tx, id)).toEqual({
            stored: "parsed",
            derived: "parsed",
          });
          await tx.execute(
            sql`UPDATE case_law_decisions SET court = 'another court' WHERE id = ${id}`,
          );
          expect(await stateOf(tx, id)).toEqual({
            stored: "unparsed",
            derived: "unparsed",
          });
          // A writer cannot claim a state the row does not have.
          await tx.execute(
            sql`UPDATE case_law_decisions SET parsed_input_state = 'parsed' WHERE id = ${id}`,
          );
          expect((await stateOf(tx, id))?.stored).toBe("unparsed");
        });
      });
    });

    test("the stored state equals the comparison after any sequence of writes", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await assertProperty(
          "the stored state equals the comparison after any sequence of writes",
          fc.asyncProperty(
            fc.array(fc.integer({ min: 0, max: WRITES.length - 1 }), {
              minLength: 1,
              maxLength: 8,
            }),
            async (writes) => {
              await rolledBack(db, async (tx) => {
                const id = await insertDecision(tx, await insertSource(tx));
                for (const write of writes) {
                  // db-await-in-loop: each write is the step whose result the property checks.
                  await tx.execute(
                    sql`UPDATE case_law_decisions SET ${WRITES[write]} WHERE id = ${id}`,
                  );
                  const state = await stateOf(tx, id);
                  expect(state?.stored).toBe(state?.derived);
                }
              });
            },
          ),
          { numRuns: 30 },
        );
      });
    });

    // The probe, the page and the scope end all filter by this predicate, so
    // selecting the same rows here is selecting the same rows there.
    test("the replay selection is the same for derived and not yet derived rows", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const version = fc.constantFrom(
          null,
          CURRENT_PARSER - 1,
          CURRENT_PARSER,
          CURRENT_PARSER + 1,
        );
        const input = fc.record({
          hash: fc.constantFrom("h1", "h2", null),
          hashVersion: fc.constantFrom(0, 1),
          key: fc.constantFrom("raw/k1", "raw/k2"),
        });
        const row = fc.record({
          parserVersion: version,
          input,
          parsed: fc.option(input, { nil: null }),
          derived: fc.boolean(),
        });
        await assertProperty(
          "the replay selection is the same for derived and not yet derived rows",
          fc.asyncProperty(
            fc.array(row, { minLength: 1, maxLength: 12 }),
            async (rows) => {
              await rolledBack(db, async (tx) => {
                await isolatedReplayTables(tx);
                const sourceId = await insertSource(tx);
                for (const generated of rows) {
                  // db-await-in-loop: one fixture row per generated case, inside one rolled-back transaction.
                  await insertGenerated(tx, sourceId, generated);
                }
                const selected = await tx.execute<{ id: string }>(sql`
                  SELECT id FROM case_law_decisions
                  WHERE source_id = ${sourceId}
                    AND ${replaySelectionPredicate(
                      {
                        type: "background",
                        currentParserVersion: CURRENT_PARSER,
                        mode: "dry-run",
                      },
                      tx,
                    )}
                  ORDER BY id`);
                // The selection as it was written before the state existed.
                const expected = await tx.execute<{ id: string }>(sql`
                  SELECT id FROM case_law_decisions
                  WHERE source_id = ${sourceId}
                    AND (parser_version IS NULL OR parser_version < ${CURRENT_PARSER}
                      OR (parser_version = ${CURRENT_PARSER} AND NOT coalesce(
                        parsed_source_hash = source_hash
                        AND parsed_source_hash_version = source_hash_version
                        AND parsed_source_raw_s3_key = source_raw_s3_key, false)))
                  ORDER BY id`);
                expect(selected.map(({ id }) => id)).toEqual(
                  expected.map(({ id }) => id),
                );
              });
            },
          ),
          { numRuns: 40 },
        );
      });
    });
  });
}

type GeneratedInput = {
  hash: string | null;
  hashVersion: number;
  key: string;
};

type GeneratedRow = {
  parserVersion: number | null;
  input: GeneratedInput;
  parsed: GeneratedInput | null;
  derived: boolean;
};

/**
 * Copies of the replay's tables without their triggers, so a row can be left
 * as a row written before the state existed (NULL) or given its derived
 * state, as the backfill would.
 */
const isolatedReplayTables = async (tx: Transaction) => {
  const fixtureSchema = `parsed_input_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  await tx.execute(
    sql.raw(`CREATE SCHEMA ${fixtureSchema};
      SET LOCAL search_path TO ${fixtureSchema}, public;
      CREATE TABLE case_law_sources (LIKE public.case_law_sources INCLUDING ALL);
      CREATE TABLE case_law_decisions (LIKE public.case_law_decisions INCLUDING ALL);
      CREATE TABLE case_law_replay_batches (LIKE public.case_law_replay_batches INCLUDING ALL);
      CREATE TABLE case_law_replay_blocked (LIKE public.case_law_replay_blocked INCLUDING ALL)`),
  );
};

const insertGenerated = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
  { parserVersion, input, parsed, derived }: GeneratedRow,
) => {
  const id = createSafeId<"caseLawDecision">();
  await tx.execute(sql`INSERT INTO case_law_decisions
    (id, source_id, case_number, court, country, language, parser_version,
      source_hash, source_hash_version, source_raw_s3_key,
      parsed_source_hash, parsed_source_hash_version, parsed_source_raw_s3_key)
    VALUES (${id}, ${sourceId}, ${`select-${id}`}, 'fixture court', 'POL', 'pl',
      ${parserVersion}, ${input.hash}, ${input.hashVersion}, ${input.key},
      ${parsed === null ? null : (parsed.hash ?? "missing")},
      ${parsed?.hashVersion ?? null}, ${parsed?.key ?? null})`);
  if (derived) {
    await tx.execute(sql`UPDATE case_law_decisions
      SET parsed_input_state = case_law_parsed_input_state(source_hash,
        source_hash_version, source_raw_s3_key, parsed_source_hash,
        parsed_source_hash_version, parsed_source_raw_s3_key)
      WHERE id = ${id}`);
  }
};
