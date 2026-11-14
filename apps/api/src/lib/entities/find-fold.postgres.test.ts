import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import type { EntityFind } from "@stll/api-contract";

import { entities } from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { buildFindConditions } from "@/api/lib/entity-filters";
import { typedPgArray } from "@/api/lib/search/sql";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

/**
 * The matter-table find against the real `unaccent` extension, which PGlite's
 * stand-in fold cannot prove: what a find returns in Czech, German and French
 * whatever the case and accents typed. The plan production runs under row
 * policies is pinned in `find-plan.db.test.ts`.
 */

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

// timeout: each test seeds thousands of rows through the triggers on `fields`
// and `entities`, about a millisecond per row, before a single assertion.
setDefaultTimeout(60_000);

/**
 * Rows with a memo cell around the named ones. The triggers on `fields` make
 * each seeded cell cost about a millisecond, which bounds the fixture.
 */
const CELL_ROWS = 2000;
const ROLLBACK = new Error("Roll back the find fixture");

type TestTransaction = TransactionOf<GatedTestDb>;

/** Row name and the one memo cell it carries. */
const NAMED_ROWS = [
  { name: "Antonín Dvořák", cell: "Smlouva Dvořák & syn" },
  { name: "JÜRGEN MÜLLER", cell: "Müller GmbH, Straße 5" },
  { name: "Élise Moreau", cell: "Élise et Cie" },
  { name: "Full-width offer", cell: "５０％ off" },
  { name: "Percent offer", cell: "50% off" },
  { name: "Decoy offer", cell: "50x off" },
  { name: "Underscore term", cell: "lease_end" },
  { name: "Underscore decoy", cell: "leasexend" },
] as const;

type NamedRow = (typeof NAMED_ROWS)[number]["name"];

type FindFixture = {
  propertyId: SafeId<"property">;
  tx: TestTransaction;
  workspaceId: SafeId<"workspace">;
};

type FindFixtureOptions = {
  database: GatedTestDb;
  run: (fixture: FindFixture) => Promise<void>;
};

/**
 * Seed one matter inside a transaction that never commits, so a run leaves
 * nothing behind and needs no cleanup ordering across the entity graph.
 */
const withFindFixture = async ({
  database,
  run,
}: FindFixtureOptions): Promise<void> => {
  const outcome = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (tx) => {
        const organizationId = mintAuthProviderId<"organization">();
        const workspaceId = createSafeId<"workspace">();
        const propertyId = createSafeId<"property">();
        await tx.execute(sql`
          INSERT INTO organization (id, name, slug, created_at)
          VALUES (${organizationId}, 'Find fold organization', ${organizationId}, now())`);
        await tx.execute(sql`
          INSERT INTO workspaces (id, organization_id, name, reference)
          VALUES (${workspaceId}, ${organizationId}, 'Find fold matter', ${`find-fold-${workspaceId}`})`);
        await tx.execute(sql`
          INSERT INTO properties (id, workspace_id, name, content, tool, status)
          VALUES (${propertyId}, ${workspaceId}, 'Memo',
            '{"version":1,"type":"text"}'::jsonb,
            '{"version":1,"type":"manual-input"}'::jsonb, 'fresh')`);
        await tx.execute(sql`
          WITH named AS (
            SELECT name, cell FROM unnest(
              ${typedPgArray(
                NAMED_ROWS.map(({ name }) => name),
                "text",
              )},
              ${typedPgArray(
                NAMED_ROWS.map(({ cell }) => cell),
                "text",
              )}
            ) AS input(name, cell)
            UNION ALL
            SELECT 'Plain row ' || n, 'plain memo ' || n
            FROM generate_series(1, ${CELL_ROWS}::int) AS series(n)
          ),
          seeded AS (
            SELECT gen_random_uuid() AS entity_id, gen_random_uuid() AS version_id,
              name, cell
            FROM named
          ),
          inserted_entities AS (
            INSERT INTO entities (id, workspace_id, kind, name, display_name)
            SELECT entity_id, ${workspaceId}::uuid, 'document', name, name FROM seeded
          ),
          inserted_versions AS (
            INSERT INTO entity_versions (id, workspace_id, entity_id)
            SELECT version_id, ${workspaceId}::uuid, entity_id FROM seeded
          )
          INSERT INTO fields (id, workspace_id, property_id, entity_version_id, content)
          SELECT gen_random_uuid(), ${workspaceId}::uuid, ${propertyId}::uuid, version_id,
            jsonb_build_object('version', 1, 'type', 'text', 'value', cell)
          FROM seeded
          WHERE cell IS NOT NULL`);
        // A separate statement: data-modifying CTEs share one snapshot, so the
        // statement above cannot see the versions it inserted.
        await tx.execute(sql`
          UPDATE entities SET current_version_id = entity_versions.id
          FROM entity_versions
          WHERE entity_versions.entity_id = entities.id
            AND entities.workspace_id = ${workspaceId}::uuid`);
        await tx.execute(sql`ANALYZE entities`);
        await tx.execute(sql`ANALYZE entity_versions`);
        await tx.execute(sql`ANALYZE fields`);
        await run({ propertyId, tx, workspaceId });
        throw ROLLBACK;
      }),
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(outcome) && outcome.error !== ROLLBACK) {
    throw outcome.error;
  }
  if (Result.isOk(outcome)) {
    panic("The find fixture committed");
  }
};

/** A find over the memo column alone, which drops the name half. */
const inMemo = ({ propertyId }: FindFixture, term: string): EntityFind => ({
  scope: { propertyIds: [propertyId], type: "columns" },
  term,
});

/** A find with no column searched: the row's name alone. */
const inName = (term: string): EntityFind => ({
  scope: { propertyIds: [], type: "all" },
  term,
});

const findWhere = ({ workspaceId }: FindFixture, find: EntityFind) =>
  and(
    eq(entities.workspaceId, workspaceId),
    isNotNull(entities.currentVersionId),
    ...buildFindConditions({ find, scope: { type: "matter", workspaceId } }),
  );

const foundNames = async (
  fixture: FindFixture,
  find: EntityFind,
): Promise<string[]> => {
  const rows = await fixture.tx
    .select({ name: entities.name })
    .from(entities)
    .where(findWhere(fixture, find));
  return rows.map(({ name }) => name).toSorted();
};

const named = (...names: NamedRow[]): string[] => names.toSorted();

describe.skipIf(!enabled)("accent-insensitive find (postgres)", () => {
  const fixture =
    enabled && databaseUrl !== undefined
      ? openGatedTestDatabase(databaseUrl, { max: 1 })
      : undefined;
  const database = (): GatedTestDb =>
    fixture?.db ?? panic("The find fold fixture is unavailable");

  test("a find ignores accents and case in Czech, German and French", async () => {
    await withFindFixture({
      database: database(),
      run: async (seeded) => {
        for (const term of ["dvorak", "DVORAK", "Dvořák", "dvořak"]) {
          expect(await foundNames(seeded, inMemo(seeded, term))).toEqual(
            named("Antonín Dvořák"),
          );
        }
        for (const term of ["muller", "MULLER", "Müller", "mÜller"]) {
          expect(await foundNames(seeded, inMemo(seeded, term))).toEqual(
            named("JÜRGEN MÜLLER"),
          );
        }
        for (const term of ["elise", "ELISE", "Élise", "élise"]) {
          expect(await foundNames(seeded, inMemo(seeded, term))).toEqual(
            named("Élise Moreau"),
          );
        }
        expect(await foundNames(seeded, inName("jurgen"))).toEqual(
          named("JÜRGEN MÜLLER"),
        );
      },
    });
  });

  test("LIKE metacharacters in a term still match only themselves", async () => {
    await withFindFixture({
      database: database(),
      run: async (seeded) => {
        // `％` folds to `%`: a term escaped before the fold would match `50x`.
        for (const term of ["50%", "50％", "５０％"]) {
          expect(await foundNames(seeded, inMemo(seeded, term))).toEqual(
            named("Full-width offer", "Percent offer"),
          );
        }
        expect(await foundNames(seeded, inMemo(seeded, "e_e"))).toEqual(
          named("Underscore term"),
        );
      },
    });
  });
});
