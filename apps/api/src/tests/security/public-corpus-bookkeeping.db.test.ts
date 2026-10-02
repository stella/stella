import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { publicCorpusCatalogQuery } from "@/api/lib/db/public-corpus-audit/catalog-query";
import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "@/api/lib/db/public-corpus-audit/membership";
import { corpusSqlStatements } from "@/api/lib/db/public-corpus-audit/migration-verification";
import { verifyPublicCorpusCatalog } from "@/api/lib/db/public-corpus-audit/schema-verification";
import type { PublicCorpusCatalogPosture } from "@/api/lib/db/public-corpus-audit/schema-verification";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const cases = [
  { name: "qualifying owner-only table", mutation: "", reason: "" },
  {
    name: "table grant",
    mutation: "GRANT SELECT ON @table TO stella",
    reason: "application role has table or column privileges",
  },
  {
    name: "column grant",
    mutation: "GRANT SELECT (cursor) ON @table TO stella",
    reason: "application role has table or column privileges",
  },
  {
    name: "PUBLIC grant",
    mutation: "GRANT SELECT ON @table TO PUBLIC",
    reason: "application role has table or column privileges",
  },
  {
    name: "role inheritance",
    mutation:
      "CREATE ROLE @role; GRANT SELECT ON @table TO @role; GRANT @role TO stella",
    reason: "application role has table or column privileges",
  },
  {
    name: "other non-owner role",
    mutation: "CREATE ROLE @role; GRANT SELECT ON @table TO @role",
    reason: "non-owner role has privileges",
  },
  {
    name: "no FORCE",
    mutation: "ALTER TABLE @table NO FORCE ROW LEVEL SECURITY",
    reason: "catalog RLS must be enabled and forced",
  },
  {
    name: "disabled RLS",
    mutation: "ALTER TABLE @table DISABLE ROW LEVEL SECURITY",
    reason: "catalog RLS must be enabled and forced",
  },
  {
    name: "additional permissive policy",
    mutation:
      "CREATE POLICY extra ON @table FOR ALL TO PUBLIC USING (true) WITH CHECK (true)",
    reason: "catalog policy must exclusively admit the table owner",
  },
  {
    name: "restrictive policy",
    mutation:
      "DROP POLICY owner ON @table; CREATE POLICY owner ON @table AS RESTRICTIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)",
    reason: "catalog policy must exclusively admit the table owner",
  },
  {
    name: "role-specific policy",
    mutation:
      "DROP POLICY owner ON @table; CREATE POLICY owner ON @table FOR ALL TO stella USING (true) WITH CHECK (true)",
    reason: "catalog policy must exclusively admit the table owner",
  },
  {
    name: "trigger",
    mutation:
      "CREATE FUNCTION @schema.trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER change AFTER INSERT ON @table FOR EACH ROW EXECUTE FUNCTION @schema.trigger_fn()",
    reason: "user trigger could perform an unclassified write",
  },
  {
    name: "tenant dependent",
    mutation:
      "ALTER TABLE @table ADD PRIMARY KEY (cursor); CREATE TABLE @schema.tenant (organization_id uuid, parent integer REFERENCES @table(cursor) ON DELETE CASCADE)",
    reason: "migrated foreign key can mutate dependent rows",
  },
  {
    name: "accessible view",
    mutation:
      "CREATE VIEW @schema.visible AS SELECT * FROM @table; GRANT SELECT ON @schema.visible TO stella",
    reason: "non-owner can read a dependent view",
  },
  {
    name: "security definer",
    mutation:
      "CREATE FUNCTION @schema.visible() RETURNS SETOF integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT cursor FROM @table $$",
    reason: "security definer may expose the relation",
  },
  {
    name: "rewrite rule",
    mutation: "CREATE RULE redirect AS ON UPDATE TO @table DO ALSO SELECT 1",
    reason: "rewrite rule can redirect mutations",
  },
  {
    name: "inheritance",
    mutation: "CREATE TABLE @schema.child () INHERITS (@table)",
    reason: "relation participates in inheritance",
  },
] as const;

describe.skipIf(!enabled)("public corpus category migrated privileges", () => {
  test("verifies every member after the PR migrations", async () => {
    for (const entry of PUBLIC_CORPUS_BOOKKEEPING_TABLES) {
      const rows = await rootDb.execute<PublicCorpusCatalogPosture>(
        publicCorpusCatalogQuery({
          schemaName: "public",
          tableName: entry.sqlName,
        }),
      );
      expect(verifyPublicCorpusCatalog(rows.at(0))).toEqual([]);
    }
  });
  test.each(cases)(
    "real catalog rejects $name",
    async ({ mutation, reason }) => {
      const namespace = `corpus_${Bun.randomUUIDv7().replaceAll("-", "_")}`;
      const role = `${namespace}_reader`;
      const tableName = `${namespace}_checkpoint`;
      const table = `${namespace}.${tableName}`;
      await rootDb.transaction(async (tx) => {
        const executeDDL = async (source: string) => {
          const statements = corpusSqlStatements(source);
          if (statements === null) {
            panic("Invalid scratch fixture SQL");
          }
          for (const statement of statements) {
            await tx.execute(sql.raw(statement));
          }
        };
        await executeDDL(`CREATE SCHEMA ${namespace}`);
        try {
          const owner = `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = '${table}'::regclass)`;
          await executeDDL(`CREATE TABLE ${table} (cursor integer);
          ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
          ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
          REVOKE ALL ON ${table} FROM stella, PUBLIC;
          CREATE POLICY owner ON ${table} FOR ALL TO PUBLIC USING (${owner}) WITH CHECK (${owner});`);
          if (mutation !== "") {
            await executeDDL(
              mutation
                .replaceAll("@table", () => table)
                .replaceAll("@schema", () => namespace)
                .replaceAll("@role", () => role),
            );
          }
          const rows = await tx.execute<PublicCorpusCatalogPosture>(
            publicCorpusCatalogQuery({ schemaName: namespace, tableName }),
          );
          const errors = verifyPublicCorpusCatalog(rows.at(0));
          if (reason === "") {
            expect(errors).toEqual([]);
          } else {
            expect(errors).toContain(reason);
          }
        } finally {
          await tx.execute(sql.raw(`DROP SCHEMA ${namespace} CASCADE`));
          if (mutation.includes("CREATE ROLE")) {
            await tx.execute(sql.raw(`DROP ROLE ${role}`));
          }
        }
      });
    },
  );
});
