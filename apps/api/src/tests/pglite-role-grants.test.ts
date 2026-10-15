import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName, isTable } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

import * as schema from "@/api/db/schema";
import {
  createTestPglite,
  HARNESS_RELATIONS_SQL,
  ROLE_GRANT_STATEMENTS,
} from "@/api/tests/pglite-test-db";
import {
  deriveStellaTablePrivileges,
  readCommittedMigrations,
} from "@/api/tests/stella-table-privileges";
import type {
  MigrationSource,
  TablePrivilege,
} from "@/api/tests/stella-table-privileges";

/**
 * The PGlite harness hand-maintains the role grants the committed migrations
 * apply, because it builds its schema by pushing the Drizzle definitions
 * rather than by replaying 300 migrations. A hand-maintained mirror drifts:
 * `case_law_reconciliation_items` was granted to `stella_ingestion` in a
 * migration and never here, so every suite that SET ROLE'd to ingestion saw a
 * permission error the real deployment does not have.
 *
 * This is the mirror check. Every `(role, table)` pair a committed migration
 * grants must also be granted by the harness, for every table the schema still
 * defines. It compares the pairs, not the verbs: the harness deliberately
 * spells some grants more coarsely (one statement per role rather than per
 * migration), and a table nobody may touch at all is the failure worth
 * catching.
 */

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");

/**
 * Roles whose table privileges this pair check leaves to another one.
 * `stella`'s are derived from the migrations and compared on the harness
 * catalog below.
 */
const WHOLESALE_ROLES = new Set(["stella", "public"]);

/** The PGlite schema installer replays these migration-owned grants verbatim. */
const MIGRATION_REPLAYED_ROLES = new Set(["stella_entity_gate"]);

/**
 * Column grants are compared for every role but `public`: the harness narrows
 * `stella` table by table, and those column lists must match the deployment.
 */
const COLUMN_UNSCOPED_ROLES = new Set(["public"]);

const GRANT_STATEMENT =
  /\bGRANT\b([\s\S]*?)\bTO\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*(?:;|$)/gu;

const OBJECT_CLAUSE = /\bON\s+(?:TABLE\s+)?([\s\S]*?)$/u;

const NOT_A_TABLE_GRANT =
  /\bON\s+(?:ALL\s+TABLES|ALL\s+SEQUENCES|SCHEMA|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|DATABASE|TYPE|LARGE\s+OBJECT)\b/iu;

const IDENTIFIER = /"([a-zA-Z_][a-zA-Z0-9_]*)"|\b([a-z_][a-z0-9_]*)\b/gu;

const PRIVILEGE_WORDS = new Set([
  "grant",
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "maintain",
  "usage",
  "create",
  "connect",
  "temporary",
  "execute",
  "all",
  "privileges",
  "on",
  "table",
  "to",
  "with",
  "option",
]);

/**
 * A column-scoped grant carries its list in parentheses after the privilege
 * and before `ON`, which the table parser above deliberately discards.
 */
const COLUMN_PRIVILEGE = /\b(SELECT|INSERT|UPDATE|REFERENCES)\s*\(([^)]*)\)/giu;

const unquote = (value: string): string => value.replaceAll('"', "");

/** Every `(role, table)` pair the given SQL grants, as `role:table`. */
const grantedPairs = (sqlText: string): Set<string> => {
  const pairs = new Set<string>();
  for (const match of sqlText.matchAll(GRANT_STATEMENT)) {
    const [, body = "", rawRole = ""] = match;
    if (NOT_A_TABLE_GRANT.test(body)) {
      continue;
    }
    const objects = OBJECT_CLAUSE.exec(body)?.[1];
    if (objects === undefined) {
      continue;
    }
    const role = unquote(rawRole);
    // A column grant carries its column list in parentheses before `ON`; the
    // object clause starts after it, so only table names survive here.
    for (const identifier of objects.matchAll(IDENTIFIER)) {
      const name = identifier[1] ?? identifier[2] ?? "";
      if (name.length === 0 || PRIVILEGE_WORDS.has(name.toLowerCase())) {
        continue;
      }
      pairs.add(`${role}:${name}`);
    }
  }
  return pairs;
};

/**
 * Every `(role, table, column, privilege)` the given SQL grants column by
 * column, as `role:table:column:PRIVILEGE`.
 */
const grantedColumnPairs = (sqlText: string): Set<string> => {
  const pairs = new Set<string>();
  for (const match of sqlText.matchAll(GRANT_STATEMENT)) {
    const [, body = "", rawRole = ""] = match;
    const role = unquote(rawRole);
    const objects = OBJECT_CLAUSE.exec(body)?.[1];
    if (objects === undefined) {
      continue;
    }
    const tables = objects.split(",").map((object) => {
      const identifiers = [...object.matchAll(IDENTIFIER)];
      const identifier = identifiers.at(-1);
      return unquote(identifier?.[1] ?? identifier?.[2] ?? "");
    });
    for (const columnPrivilege of body.matchAll(COLUMN_PRIVILEGE)) {
      const [, privilege = "", columnList = ""] = columnPrivilege;
      for (const table of tables) {
        for (const rawColumn of columnList.split(",")) {
          const column = unquote(rawColumn.trim());
          if (table.length > 0 && column.length > 0) {
            pairs.add(`${role}:${table}:${column}:${privilege.toUpperCase()}`);
          }
        }
      }
    }
  }
  return pairs;
};

const schemaTableNames = new Set<string>(
  Object.values(schema)
    .filter((value) => isTable(value))
    .map((table) => getTableName(table)),
);

const readMigrationSql = async (): Promise<string> => {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => nodePath.join(MIGRATIONS_DIR, entry.name, "migration.sql"))
    .toSorted();
  const contents = await Promise.all(
    files.map(async (file) => {
      const handle = Bun.file(file);
      return (await handle.exists()) ? await handle.text() : "";
    }),
  );
  // The migrator splits on this marker; joining with `;` keeps each statement
  // terminated for the parser above.
  return contents.join("\n").replaceAll("--> statement-breakpoint", ";");
};

describe("pglite role grants mirror the committed migrations", () => {
  test("the migrations grant no table the harness leaves ungranted", async () => {
    const migrationPairs = grantedPairs(await readMigrationSql());
    const harnessPairs = grantedPairs(ROLE_GRANT_STATEMENTS.join(";\n"));

    const missing = [...migrationPairs]
      .filter((pair) => {
        const [role = "", table = ""] = pair.split(":");
        return (
          !WHOLESALE_ROLES.has(role) &&
          !MIGRATION_REPLAYED_ROLES.has(role) &&
          schemaTableNames.has(table) &&
          !harnessPairs.has(pair)
        );
      })
      .toSorted();

    expect(missing).toEqual([]);
  });

  /**
   * Column-scoped grants drift the same way, and worse in both directions. A
   * harness that grants fewer columns than the migrations makes a SET ROLE
   * suite fail on access the deployment has; a harness that grants more makes
   * one pass on access the deployment does not. `stored_total` was the second
   * kind of gap in reverse: the columns landed with a reader grant and none
   * for `stella_ingestion`, and nothing here or in any suite noticed, because
   * the pair check above sees only `stella_ingestion:case_law_sources`.
   *
   * So this compares the sets, both ways. The tables the schema still defines
   * are the scope, for every role including `stella`: its table privileges
   * come from the migrations (compared on the catalog below), and a column it
   * holds in the harness but not in the deployment would let a scoped suite
   * pass on a statement production refuses.
   */
  test("the migration and harness column grants are the same set", async () => {
    const inScope = (pair: string): boolean => {
      const [role = "", table = ""] = pair.split(":");
      return (
        !COLUMN_UNSCOPED_ROLES.has(role) &&
        !MIGRATION_REPLAYED_ROLES.has(role) &&
        schemaTableNames.has(table)
      );
    };
    const migrationColumns = [
      ...grantedColumnPairs(await readMigrationSql()),
    ].filter(inScope);
    const harnessColumns = [
      ...grantedColumnPairs(ROLE_GRANT_STATEMENTS.join(";\n")),
    ].filter(inScope);

    expect(harnessColumns.toSorted()).toEqual(migrationColumns.toSorted());
  });

  test("the parser reads both migration and harness grant spellings", async () => {
    // A parser that matched nothing would pass the mirror check silently.
    const migrationPairs = grantedPairs(await readMigrationSql());
    const harnessPairs = grantedPairs(ROLE_GRANT_STATEMENTS.join(";\n"));

    expect(migrationPairs.has("stella_ingestion:case_law_decisions")).toBe(
      true,
    );
    expect(
      migrationPairs.has("stella_ingestion:case_law_reconciliation_items"),
    ).toBe(true);
    expect(harnessPairs.has("stella_ingestion:case_law_decisions")).toBe(true);

    // An empty column set on both sides would satisfy the equality above.
    const migrationColumns = grantedColumnPairs(await readMigrationSql());
    const harnessColumns = grantedColumnPairs(
      ROLE_GRANT_STATEMENTS.join(";\n"),
    );
    const storedTotalGrant =
      "stella_ingestion:case_law_sources:stored_total:UPDATE";
    expect(migrationColumns.has(storedTotalGrant)).toBe(true);
    expect(harnessColumns.has(storedTotalGrant)).toBe(true);
  });
});

/**
 * `stella` table privileges, compared on the built harness catalog rather than
 * on its statement text: whatever the harness ran (the derived privileges,
 * the hand-kept grants, the migration replays in `pglite-schema.ts`), the
 * role must end up holding exactly what the committed migrations leave it.
 * Every relation in the harness is compared, in both directions, so a
 * migration REVOKE the harness ignores and a harness GRANT the migrations
 * never made both fail here.
 */
describe("pglite stella table privileges mirror the committed migrations", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = await createTestPglite();
  });

  afterAll(async () => {
    await client.close();
  });

  const harnessPrivileges = async (): Promise<Map<string, Set<string>>> => {
    const relations = await client.query<{ relation: string }>(
      HARNESS_RELATIONS_SQL,
    );
    const granted = await client.query<{
      relation: string;
      privilege: string;
    }>(`
      SELECT c.relname AS relation, acl.privilege_type AS privilege
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
      WHERE n.nspname = 'public'
        AND acl.grantee = 'stella'::regrole
    `);
    const privileges = new Map<string, Set<string>>(
      relations.rows.map(({ relation }) => [relation, new Set<string>()]),
    );
    for (const { relation, privilege } of granted.rows) {
      privileges.get(relation)?.add(privilege);
    }
    return privileges;
  };

  /**
   * `relation:PRIVILEGE` on one side only, labelled by the side holding it,
   * over the relations of both sides: one the harness never builds still
   * counts with no privileges.
   */
  const privilegeDrift = (
    harness: ReadonlyMap<string, ReadonlySet<string>>,
    migrations: ReadonlyMap<string, ReadonlySet<TablePrivilege>>,
  ): string[] => {
    const drift: string[] = [];
    const relations = new Set([...harness.keys(), ...migrations.keys()]);
    for (const relation of relations) {
      const held: ReadonlySet<string> = harness.get(relation) ?? new Set();
      const expected: ReadonlySet<string> =
        migrations.get(relation) ?? new Set();
      for (const privilege of held) {
        if (!expected.has(privilege)) {
          drift.push(`harness only: ${relation}:${privilege}`);
        }
      }
      for (const privilege of expected) {
        if (!held.has(privilege)) {
          drift.push(`migrations only: ${relation}:${privilege}`);
        }
      }
    }
    return drift.toSorted();
  };

  test("the harness holds stella to exactly the migration privileges", async () => {
    const harness = await harnessPrivileges();
    const derived = deriveStellaTablePrivileges(readCommittedMigrations());

    expect(derived.unexpandedDynamicMigrations).toEqual([]);
    expect(derived.unusedDynamicExpansions).toEqual([]);
    expect(derived.unsupportedStatements).toEqual([]);
    expect(privilegeDrift(harness, derived.privileges)).toEqual([]);

    // A comparison over an empty catalog would pass; pin each kind of
    // narrowing the mirror exists for. The cleanup claim on
    // `buffer_object_cleanup_intents` may write its retry schedule only
    // through column grants, so the table itself holds no UPDATE.
    expect(harness.get("legal_list_item_reviews")).toEqual(
      new Set(["SELECT", "INSERT"]),
    );
    expect(harness.get("buffer_object_cleanup_intents")).toEqual(
      new Set(["INSERT", "DELETE"]),
    );
    expect(harness.get("case_law_corpus_upload_intents")).toEqual(new Set());
    expect(harness.get("legal_lists")).toEqual(
      new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]),
    );
  });

  test("the maintenance role has only its migration-owned column grants", async () => {
    const migrationColumns = [...grantedColumnPairs(await readMigrationSql())]
      .filter((pair) => pair.startsWith("stella_entity_gate:"))
      .toSorted();
    const harnessColumns = await client.query<{
      table_name: string;
      column_name: string;
      privilege_type: string;
    }>(`
      SELECT table_name, column_name, privilege_type
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND grantee = 'stella_entity_gate'
      ORDER BY table_name, column_name, privilege_type
    `);
    const actualColumns = harnessColumns.rows.map(
      ({ table_name, column_name, privilege_type }) =>
        `stella_entity_gate:${table_name}:${column_name}:${privilege_type}`,
    );
    const tablePrivileges = await client.query<{ relation: string }>(`
      SELECT c.relname AS relation
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
      WHERE n.nspname = 'public'
        AND acl.grantee = 'stella_entity_gate'::regrole
    `);

    expect(migrationColumns).not.toHaveLength(0);
    expect(actualColumns).toEqual(migrationColumns);
    expect(tablePrivileges.rows).toEqual([]);
  });

  test("a migration privilege change the harness ignores is drift", async () => {
    const harness = await harnessPrivileges();
    const committed = readCommittedMigrations();
    const synthetic = (sql: string): MigrationSource[] => [
      ...committed,
      { name: "99999999999999_synthetic", sql },
    ];

    const revoked = deriveStellaTablePrivileges(
      synthetic(`REVOKE UPDATE, DELETE ON TABLE "legal_lists" FROM stella;`),
    );
    expect(privilegeDrift(harness, revoked.privileges)).toEqual([
      "harness only: legal_lists:DELETE",
      "harness only: legal_lists:UPDATE",
    ]);

    const granted = deriveStellaTablePrivileges(
      synthetic(
        `GRANT INSERT ON TABLE public."legal_list_item_reviews" TO "stella";`,
      ),
    );
    expect(privilegeDrift(harness, granted.privileges)).toEqual([]);
    const widened = deriveStellaTablePrivileges(
      synthetic(`GRANT UPDATE ON legal_list_item_reviews TO stella;`),
    );
    expect(privilegeDrift(harness, widened.privileges)).toEqual([
      "migrations only: legal_list_item_reviews:UPDATE",
    ]);

    // A relation the harness never builds is compared too: granted, it is
    // drift; closed, there is nothing to differ.
    const missing = deriveStellaTablePrivileges(
      synthetic(
        `CREATE TABLE "migration_only" (id text);
         CREATE TABLE "migration_only_closed" (id text);
         GRANT SELECT ON "migration_only" TO stella;`,
      ),
    );
    expect(privilegeDrift(harness, missing.privileges)).toEqual([
      "migrations only: migration_only:SELECT",
    ]);
  });
});

describe("stella table privilege derivation", () => {
  const derive = (...sqls: string[]) =>
    deriveStellaTablePrivileges(
      sqls.map((sql, index) => ({ name: `0000000000000${index}_case`, sql })),
      {},
    );
  const privilegesOf = (sqls: string[], relation: string) =>
    [...(derive(...sqls).privileges.get(relation) ?? [])].toSorted();

  test("folds grants and revokes in statement order", () => {
    expect(
      privilegesOf(
        [
          `CREATE TABLE "t" ("id" text);
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "t" TO stella;
           REVOKE UPDATE, DELETE ON TABLE "t" FROM stella;`,
          `GRANT DELETE ON t TO stella_ingestion, stella;`,
        ],
        "t",
      ),
    ).toEqual(["DELETE", "INSERT", "SELECT"]);
    expect(
      privilegesOf(
        [
          `CREATE TABLE t (id text);
           REVOKE ALL PRIVILEGES ON TABLE t FROM stella;
           GRANT SELECT ON TABLE t TO stella;`,
        ],
        "t",
      ),
    ).toEqual(["SELECT"]);
  });

  test("a new relation starts closed and a recreated one starts over", () => {
    expect(
      privilegesOf([`CREATE TABLE IF NOT EXISTS t (id text);`], "t"),
    ).toEqual([]);
    expect(
      privilegesOf(
        [
          `CREATE TABLE t (id text); GRANT SELECT ON t TO stella;`,
          `DROP TABLE t; CREATE TABLE t (id text);`,
        ],
        "t",
      ),
    ).toEqual([]);
    expect(
      privilegesOf(
        [
          `CREATE TABLE t (id text); GRANT SELECT ON t TO stella;`,
          `ALTER TABLE t RENAME TO u;`,
        ],
        "u",
      ),
    ).toEqual(["SELECT"]);
  });

  test("ignores column grants, other roles, other objects and comments", () => {
    expect(
      privilegesOf(
        [
          `CREATE TABLE t (id text);
           -- GRANT SELECT ON t TO stella;
           GRANT UPDATE (id) ON TABLE t TO stella;
           GRANT SELECT ON t TO stella_ingestion;
           GRANT USAGE, SELECT ON SEQUENCE t TO stella;
           GRANT stella TO stella_ingestion;`,
        ],
        "t",
      ),
    ).toEqual([]);
  });

  test("reads mixed column grants on schema-qualified tables", () => {
    const pairs = grantedColumnPairs(`
      GRANT SELECT ("id", "workspace_id"),
        UPDATE ("entity_feature_gate")
      ON public."maintenance_table" TO stella_entity_gate;
    `);

    expect([...pairs].toSorted()).toEqual([
      "stella_entity_gate:maintenance_table:entity_feature_gate:UPDATE",
      "stella_entity_gate:maintenance_table:id:SELECT",
      "stella_entity_gate:maintenance_table:workspace_id:SELECT",
    ]);
  });

  test("a schema-wide grant reaches every public relation that exists", () => {
    const derivation = derive(
      `CREATE TABLE t (id text);
       CREATE VIEW v AS SELECT id FROM t;
       GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO stella;
       REVOKE INSERT ON ALL TABLES IN SCHEMA "public" FROM stella;
       GRANT DELETE ON ALL TABLES IN SCHEMA audit TO stella;
       CREATE TABLE later (id text);`,
    );
    const privileges = (relation: string) =>
      [...(derivation.privileges.get(relation) ?? [])].toSorted();
    expect(privileges("t")).toEqual(["SELECT"]);
    expect(privileges("v")).toEqual(["SELECT"]);
    expect(privileges("later")).toEqual([]);
    expect(derivation.unsupportedStatements).toEqual([]);
  });

  test("a default table grant is reported, a default revoke agrees", () => {
    const derivation = derive(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM stella;
       ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT ON TABLES TO stella;`,
    );
    expect(derivation.unsupportedStatements).toEqual([
      "00000000000000_case: GRANT SELECT ON TABLES TO stella",
    ]);
  });

  test("a format() grant must be expanded by hand", () => {
    const derivation = derive(
      `DO $$ BEGIN
         EXECUTE format('REVOKE ALL ON TABLE %I FROM stella', 't');
       END $$;`,
    );
    expect(derivation.unexpandedDynamicMigrations).toEqual([
      "00000000000000_case",
    ]);
  });
});
