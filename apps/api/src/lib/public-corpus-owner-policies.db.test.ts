import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { stellaPublicLawReader } from "@/api/db/rls";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  readLegislationAmendments,
  readLegislationAmendmentSnapshot,
} from "@/api/lib/legal-search/legislation-amendments";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
type OwnerFixture = {
  client: SQL;
  schema: string;
  owner: string;
};

type WithOwnerFixtureOptions = {
  tables: readonly string[];
  functions?: readonly string[];
  triggers?: readonly string[];
  run: (fixture: OwnerFixture) => Promise<void>;
};

const withOwnerFixture = async ({
  tables,
  functions = [],
  triggers = [],
  run,
}: WithOwnerFixtureOptions) => {
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const client = openClient().sql;
    const suffix = Bun.randomUUIDv7().replaceAll("-", "");
    const schema = `corpus_owner_${suffix}`;
    const owner = `corpus_role_${suffix}`;
    const [login] = await client<
      { name: string }[]
    >`SELECT current_user AS name`;
    if (login === undefined) {
      panic("Fixture login required");
    }
    const localize = (definition: string) =>
      definition
        .replaceAll("public.", () => `${schema}.`)
        .replaceAll("'public'", () => `'${schema}'`);
    await client.unsafe(`CREATE SCHEMA ${schema};
      CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
      GRANT ${owner} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
      GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${owner};
      SET search_path TO ${schema}, public`);
    try {
      // Copy the migrated tables, policies and functions so the fixture tracks
      // the shipped contracts. Foreign keys are outside these visibility tests.
      for (const table of tables) {
        await client.unsafe(`CREATE TABLE ${identifier(table)}
          (LIKE public.${identifier(table)} INCLUDING DEFAULTS INCLUDING GENERATED);
          ALTER TABLE ${identifier(table)} OWNER TO ${owner}`);
        const constraints = await client<
          { name: string; definition: string }[]
        >`
          SELECT conname AS name, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid = ${`public.${table}`}::regclass
          AND contype IN ('p', 'u', 'c')`;
        for (const constraint of constraints) {
          await client.unsafe(`ALTER TABLE ${identifier(table)}
            ADD CONSTRAINT ${identifier(constraint.name)} ${localize(constraint.definition)}`);
        }
        const policies = await client<
          {
            name: string;
            command: string;
            permissive: boolean;
            roles: string[];
            using: string | null;
            check: string | null;
          }[]
        >`
          SELECT polname AS name,
            CASE polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END AS command,
            polpermissive AS permissive,
            ARRAY(SELECT CASE WHEN role = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role) END FROM unnest(polroles) role) AS roles,
            pg_get_expr(polqual, polrelid) AS using,
            pg_get_expr(polwithcheck, polrelid) AS check
          FROM pg_policy WHERE polrelid = ${`public.${table}`}::regclass`;
        for (const policy of policies) {
          await client.unsafe(`CREATE POLICY ${identifier(policy.name)} ON ${identifier(table)}
            AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${policy.command}
            TO ${policy.roles.map((role) => (role === "PUBLIC" ? role : identifier(role))).join(", ")}
            ${policy.using === null ? "" : `USING (${localize(policy.using)})`}
            ${policy.check === null ? "" : `WITH CHECK (${localize(policy.check)})`}`);
        }
        const [posture] = await client<{ enabled: boolean; forced: boolean }[]>`
          SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE oid = ${`public.${table}`}::regclass`;
        if (posture?.enabled) {
          await client.unsafe(
            `ALTER TABLE ${identifier(table)} ENABLE ROW LEVEL SECURITY`,
          );
        }
        if (posture?.forced) {
          await client.unsafe(
            `ALTER TABLE ${identifier(table)} FORCE ROW LEVEL SECURITY`,
          );
        }
        await client.unsafe(`CREATE POLICY fixture_seed ON ${identifier(table)}
          FOR ALL TO ${identifier(login.name)} USING (true) WITH CHECK (true)`);
      }
      for (const name of functions) {
        const [definition] = await client<{ definition: string }[]>`
          SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
          WHERE pronamespace = 'public'::regnamespace AND proname = ${name}`;
        if (definition === undefined) {
          panic("Migrated fixture function required", name);
        }
        await client.unsafe(localize(definition.definition));
      }
      for (const name of triggers) {
        const [definition] = await client<{ definition: string }[]>`
          SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
          WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
          AND tgname = ${name}`;
        if (definition === undefined) {
          panic("Migrated fixture trigger required", name);
        }
        await client.unsafe(localize(definition.definition));
      }
      const [posture] = await client`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${owner}`;
      expect(posture).toMatchObject({ rolsuper: false, rolbypassrls: false });
      await run({ client, schema, owner });
    } finally {
      await client.unsafe(`RESET ROLE; RESET search_path;
        DROP SCHEMA ${schema} CASCADE; DROP OWNED BY ${owner}; DROP ROLE ${owner}`);
    }
  });
};

const asOwner = async <T>(
  { client, owner }: OwnerFixture,
  run: () => Promise<T>,
) => {
  await client.unsafe(`SET ROLE ${owner}`);
  try {
    return await run();
  } finally {
    await client.unsafe("RESET ROLE");
  }
};

const seedDecision = async (client: SQL, id: string, sourceId: string) => {
  await client`INSERT INTO case_law_decisions
    (id, source_id, case_number, court, country, language, decision_date)
    VALUES (${id}, ${sourceId}, ${id}, 'Fixture court', 'CZE', 'cs', '2026-01-01')`;
};

describe.skipIf(!enabled)("public corpus owner behaviour", () => {
  test("the shared public reader returns a statute's amendment snapshot and amendments", async () => {
    expect(process.env["PUBLIC_LAW_DATABASE_URL"]).toBeUndefined();
    await withOwnerFixture({
      tables: [
        "legislation_sources",
        "legislation_documents",
        "legislation_amendment_snapshots",
        "legislation_amendments",
      ],
      run: async (fixture) => {
        const { client, schema } = fixture;
        const sourceId = createSafeId<"legislationSource">();
        const documentId = createSafeId<"legislationDocument">();
        const work = { sourceId, eli: "eli/cz/sb/2012/89", language: "cs" };
        await client`INSERT INTO legislation_sources (id, adapter_key, name)
          VALUES (${sourceId}, 'owner-fixture', 'Fixture source')`;
        await client`INSERT INTO legislation_documents (id, source_id, eli, title, country, language)
          VALUES (${documentId}, ${sourceId}, ${work.eli}, 'Fixture statute', 'CZE', 'cs')`;
        await client`INSERT INTO legislation_amendment_snapshots
          VALUES (${sourceId}, ${work.eli}, 'cs', '2026-10-18T10:00:00Z', '{"type":"complete"}')`;
        await client`INSERT INTO legislation_amendments
          (source_id, target_eli, language, publisher_id, amending_eli, affected_anchor, change_kind, effective_type, effective_date)
          VALUES (${sourceId}, ${work.eli}, 'cs', 'fixture-amendment', 'eli/cz/sb/2026/159', 'section-1', 'inserted', 'date', '2027-01-01')`;
        await client.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO ${stellaPublicLawReader.name}`,
        );
        for (const table of [
          "legislation_sources",
          "legislation_documents",
          "legislation_amendment_snapshots",
          "legislation_amendments",
        ]) {
          const columns = await client<{ name: string }[]>`
            SELECT attname AS name FROM pg_attribute
            WHERE attrelid = ${`public.${table}`}::regclass AND attnum > 0 AND NOT attisdropped
              AND has_column_privilege(${stellaPublicLawReader.name}, attrelid, attnum, 'SELECT')`;
          expect(columns.length).toBeGreaterThan(0);
          await client.unsafe(`GRANT SELECT (${columns.map(({ name }) => identifier(name)).join(", ")})
            ON ${schema}.${identifier(table)} TO ${stellaPublicLawReader.name}`);
        }
        const read = async () =>
          await publicLawReadDb(async (tx) => {
            await tx.execute(
              sql`SELECT set_config('search_path', ${`${schema}, public`}, true)`,
            );
            const posture = await tx.execute<{
              name: string;
              rolsuper: boolean;
              rolbypassrls: boolean;
            }>(sql`
            SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
            expect(executedRows(posture).at(0)).toMatchObject({
              name: stellaPublicLawReader.name,
              rolsuper: false,
              rolbypassrls: false,
            });
            return {
              snapshot: await readLegislationAmendmentSnapshot(tx, work),
              amendments: await readLegislationAmendments(tx, {
                work,
                direction: "incoming",
                limit: 10,
              }),
            };
          });
        const result = await read();
        expect(result.snapshot?.coverage).toEqual({ type: "complete" });
        expect(result.amendments.items.length).toBeGreaterThan(0);
        expect(
          result.amendments.items.map(({ publisherId }) => publisherId),
        ).toEqual(["fixture-amendment"]);
      },
    });
  });

  test("shared public reads use the reader role and deny writes", async () => {
    expect(process.env["PUBLIC_LAW_DATABASE_URL"]).toBeUndefined();
    const role = await publicLawReadDb(async (tx) =>
      executedRows(await tx.execute(sql`SELECT current_user AS name`)).at(0),
    );
    expect(role).toMatchObject({ name: stellaPublicLawReader.name });
    const denied = await rejectionOf(
      publicLawReadDb(async (tx) => {
        // COPY checks INSERT privileges before the read-only transaction guard.
        await tx.execute(sql`COPY legislation_amendments FROM STDIN`);
      }),
    );
    expect(getPgErrorCode(denied)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
  });

  test("owner inserts reject a retired decision UUID", async () => {
    await withOwnerFixture({
      tables: [
        "case_law_sources",
        "case_law_decisions",
        "case_law_decision_aliases",
      ],
      functions: ["case_law_decision_reject_retired_uuid"],
      triggers: ["case_law_decision_reject_retired_uuid"],
      run: async (fixture) => {
        const { client, schema } = fixture;
        const retired = createSafeId<"caseLawDecision">();
        const canonical = createSafeId<"caseLawDecision">();
        const sourceId = createSafeId<"caseLawSource">();
        await seedDecision(client, canonical, sourceId);
        await client`INSERT INTO case_law_decision_aliases (retired_decision_id, canonical_decision_id) VALUES (${retired}, ${canonical})`;
        expect(
          await rejectionOf(
            asOwner(
              fixture,
              async () => await seedDecision(client, retired, sourceId),
            ),
          ),
        ).toMatchObject({
          message: expect.stringContaining("Decision UUID is retired"),
        });
        await client.unsafe(
          `DROP POLICY case_law_decision_aliases_owner ON ${schema}.case_law_decision_aliases`,
        );
        await asOwner(
          fixture,
          async () => await seedDecision(client, retired, sourceId),
        );
        expect(
          await client`SELECT id FROM case_law_decisions WHERE id = ${retired}`,
        ).toEqual([{ id: retired }]);
      },
    });
  });
});
