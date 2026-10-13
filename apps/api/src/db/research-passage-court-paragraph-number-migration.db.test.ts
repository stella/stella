import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Stating `courtParagraphNumber: null` on research passages stored before the
 * field existed.
 *
 * The shared test database runs every migration before any row exists, so it
 * never holds a passage without the field. This suite seeds the answers
 * table in the shape the migration reads and runs the migration file itself.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261012120000_research_passage_court_paragraph_number/migration.sql",
);

const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

// Only the column the migration rewrites, and an id to read rows back by.
const SCHEMA = `
CREATE TABLE case_law_research_answers (
  id text PRIMARY KEY,
  run jsonb
);
`;

const runWith = (blocks: readonly unknown[]) => ({
  version: 1,
  model: "test-model",
  completedAt: "2026-10-01T10:00:00.000Z",
  retrieved: false,
  rationale: "As held.",
  justification: { version: 1, blocks },
});

const legacyPassage = (anchorId: string) => ({
  kind: "decision-passage",
  anchorId,
  excerpt: `Excerpt ${anchorId}.`,
});

const ROWS = {
  // Passages from before the field, around blocks the migration must keep.
  legacy: runWith([
    legacyPassage("p-1"),
    { kind: "playbook-verdict", rationale: "Graded." },
    { ...legacyPassage("p-2"), courtParagraphNumber: 6 },
    legacyPassage("p-3"),
  ]),
  // Already in the current shape: a number and an explicit null.
  current: runWith([
    { ...legacyPassage("p-4"), courtParagraphNumber: 9 },
    { ...legacyPassage("p-5"), courtParagraphNumber: null },
  ]),
  // No passage at all.
  verdictOnly: runWith([{ kind: "playbook-verdict", rationale: "Graded." }]),
  empty: runWith([]),
  pending: null,
} as const;

const seed = async (database: PGlite): Promise<void> => {
  await database.exec(SCHEMA);
  for (const [id, run] of Object.entries(ROWS)) {
    await database.query(
      "INSERT INTO case_law_research_answers (id, run) VALUES ($1, $2)",
      [id, run === null ? null : JSON.stringify(run)],
    );
  }
};

const runsById = async (database: PGlite): Promise<Record<string, unknown>> =>
  Object.fromEntries(
    (
      await database.query<{ id: string; run: unknown }>(
        "SELECT id, run FROM case_law_research_answers ORDER BY id",
      )
    ).rows.map(({ id, run }) => [id, run]),
  );

const EXPECTED = {
  ...ROWS,
  legacy: runWith([
    { ...legacyPassage("p-1"), courtParagraphNumber: null },
    { kind: "playbook-verdict", rationale: "Graded." },
    { ...legacyPassage("p-2"), courtParagraphNumber: 6 },
    { ...legacyPassage("p-3"), courtParagraphNumber: null },
  ]),
};

test("only passages without the field gain a null number; every other block and run is kept as stored", async () => {
  await using database = new PGlite();
  await seed(database);
  // The fixture reaches the fault: a stored passage really lacks the field.
  expect(await runsById(database)).not.toEqual(EXPECTED);

  await database.exec(migrationSql);

  expect(await runsById(database)).toEqual(EXPECTED);
});

test("a rerun changes nothing and touches no row", async () => {
  await using database = new PGlite();
  await seed(database);
  await database.exec(migrationSql);
  // A row version changes on every UPDATE, even one that writes equal data.
  const versions = async () =>
    (
      await database.query<{ id: string; xmin: string }>(
        "SELECT id, xmin::text AS xmin FROM case_law_research_answers ORDER BY id",
      )
    ).rows;
  const before = await versions();

  await database.exec(migrationSql);

  expect(await versions()).toEqual(before);
  expect(await runsById(database)).toEqual(EXPECTED);
});
