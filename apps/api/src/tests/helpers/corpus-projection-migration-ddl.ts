const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);

/**
 * Projection migrations whose functions and triggers the test database build
 * installs already (`pglite-test-db.ts`); replaying them would create them
 * twice.
 */
const INSTALLED_BY_TEST_DATABASE_BUILD = [
  "projection_revision",
  "projection_delete_tasks",
] as const;

type CorpusProjectionMigrationDdlOptions = {
  /** Only migrations whose directory sorts before this one. */
  before?: string;
};

/**
 * The projection guards and triggers the corpus projection migrations define,
 * in migration order, for a test database built by schema push, which
 * creates tables but no functions or triggers.
 */
export const corpusProjectionMigrationDdl = async ({
  before,
}: CorpusProjectionMigrationDdlOptions = {}): Promise<string[]> => {
  const migrations = [
    ...new Bun.Glob("*corpus*projection*/migration.sql").scanSync(
      Bun.fileURLToPath(DRIZZLE_DIR),
    ),
  ]
    .filter(
      (migration) =>
        !INSTALLED_BY_TEST_DATABASE_BUILD.some((installed) =>
          migration.includes(installed),
        ),
    )
    .filter((migration) => before === undefined || migration < before)
    .toSorted();
  const texts = await Promise.all(
    migrations.map(
      async (migration) =>
        await Bun.file(new URL(migration, DRIZZLE_DIR)).text(),
    ),
  );
  return texts.flatMap((text) =>
    text
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(
        (ddl) =>
          /(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl) ||
          /(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl),
      ),
  );
};
