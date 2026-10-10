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
  test("verifies a canonical catalog fixture", async () => {
    const namespace = `corpus_${Bun.randomUUIDv7().replaceAll("-", "_")}`;
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
        const rows = await tx.execute<PublicCorpusCatalogPosture>(
          publicCorpusCatalogQuery({ schemaName: namespace, tableName }),
        );
        expect(verifyPublicCorpusCatalog(rows.at(0))).toEqual([]);
      } finally {
        await tx.execute(sql.raw(`DROP SCHEMA ${namespace} CASCADE`));
      }
    });
  });
});
