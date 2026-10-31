import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The test database boots with every migration applied and no legacy rows,
 * so the suite stores configs in the shapes found before the constraint,
 * removes it, and runs the migration file itself, in one transaction as the
 * migrator does.
 */
const MIGRATION_FILE = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261031082700_case_law_source_config_object/migration.sql",
);
const STATEMENTS = readFileSync(MIGRATION_FILE, "utf-8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

type PgliteClient = Awaited<ReturnType<typeof createTestPglite>>;

const seedWithoutConstraint = async (
  client: PgliteClient,
  configs: readonly (string | null)[],
) => {
  await client.exec(`ALTER TABLE public.case_law_sources
    DROP CONSTRAINT case_law_sources_config_object`);
  const ids: string[] = [];
  for (const config of configs) {
    const id = createSafeId<"caseLawSource">();
    await client.query(
      `INSERT INTO public.case_law_sources (id, adapter_key, name, config)
       VALUES ($1, $2, 'Config fixture', $3::text::jsonb)`,
      [id, `config-migration-${id}`, config],
    );
    ids.push(id);
  }
  return ids;
};

const runMigration = async (client: PgliteClient) =>
  await client.transaction(async (tx) => {
    for (const statement of STATEMENTS) {
      await tx.exec(statement);
    }
  });

const readRows = async (client: PgliteClient, ids: readonly string[]) =>
  (
    await client.query<{ id: string; config: unknown; version: string }>(
      `SELECT id, config, xmin::text AS version
       FROM public.case_law_sources WHERE id = ANY($1) ORDER BY id`,
      [ids],
    )
  ).rows;

const readConstraint = async (client: PgliteClient) =>
  (
    await client.query(
      `SELECT convalidated FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.case_law_sources'::regclass
         AND conname = 'case_law_sources_config_object'`,
    )
  ).rows;

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
test('stores the object a JSON string "{}" meant, leaves every other row unwritten, and adds the constraint NOT VALID', async () => {
  const client = await createTestPglite();
  try {
    const ids = await seedWithoutConstraint(client, [
      '"{}"',
      "{}",
      '{"unavailableItems":{"item":2}}',
      null,
    ]);
    const before = await readRows(client, ids);

    await runMigration(client);

    const after = await readRows(client, ids);
    expect(after).toEqual(
      before.map((row) =>
        row.config === "{}"
          ? { id: row.id, config: {}, version: expect.any(String) }
          : row,
      ),
    );
    expect(await readConstraint(client)).toEqual([{ convalidated: false }]);
    // The rewritten row takes later writes under the constraint.
    const rewritten = before.find((row) => row.config === "{}");
    await client.query(
      `UPDATE public.case_law_sources SET name = 'Renamed' WHERE id = $1`,
      [rewritten?.id],
    );
  } finally {
    await client.close();
  }
}, 120_000);

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
test("stops on any other non-object config and leaves the table as it was", async () => {
  const client = await createTestPglite();
  try {
    const ids = await seedWithoutConstraint(client, ['"{}"', '"paused"']);
    const before = await readRows(client, ids);

    expect(await rejectionOf(runMigration(client))).toMatchObject({
      message: expect.stringContaining("non-object value"),
    });
    expect(await readRows(client, ids)).toEqual(before);
    expect(await readConstraint(client)).toEqual([]);
  } finally {
    await client.close();
  }
}, 120_000);
