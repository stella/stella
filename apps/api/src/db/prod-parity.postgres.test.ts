import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getPgErrorCode, PG_ERROR } from "../lib/pg-error";
import { withGatedTestClients } from "../tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("Postgres execution and schema owner parity", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("Postgres execution and schema owner parity", () => {
    test("matches every shared setting and disables JIT", async () => {
      const fragment = await readFile(
        path.resolve(
          import.meta.dir,
          "../../../../docker/postgres/prod-parity.conf",
        ),
        "utf-8",
      );
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const settings = await db.execute<{ name: string; setting: string }>(
          sql`SELECT name, setting FROM pg_settings`,
        );
        const actual = new Map(
          settings.map(({ name, setting }) => [name, setting]),
        );
        let checked = 0;
        for (const line of fragment.split("\n")) {
          if (line.trim() === "" || line.trimStart().startsWith("#")) {
            continue;
          }
          const match = /^([a-z_.]+)\s*=\s*'?([a-z_0-9]+)'?$/u.exec(line);
          if (!match) {
            throw new TypeError(`Invalid parity setting: ${line}`);
          }
          const name = match.at(1);
          const expected = match.at(2);
          if (name === undefined || expected === undefined) {
            throw new TypeError(`Missing parity setting: ${line}`);
          }
          expect(actual.get(name)).toBe(expected);
          checked++;
        }
        expect(checked).toBeGreaterThan(0);
        expect(actual.get("jit")).toBe("off");
        expect(
          await db.execute<{ available: boolean }>(
            sql`SELECT pg_jit_available() AS available`,
          ),
        ).toEqual([{ available: false }]);
      });
    });

    test("FORCE RLS denies the owner a write without a policy", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const write = await Result.tryPromise(async () =>
          db.transaction(async (tx) => {
            await tx.execute(
              sql`CREATE TEMPORARY TABLE parity_rls_probe (id integer)`,
            );
            await tx.execute(
              sql`ALTER TABLE parity_rls_probe ENABLE ROW LEVEL SECURITY`,
            );
            await tx.execute(
              sql`ALTER TABLE parity_rls_probe FORCE ROW LEVEL SECURITY`,
            );
            await tx.execute(sql`INSERT INTO parity_rls_probe (id) VALUES (1)`);
          }),
        );
        expect(write.isErr()).toBe(true);
        if (write.isErr()) {
          expect(getPgErrorCode(write.error)).toBe(
            PG_ERROR.INSUFFICIENT_PRIVILEGE,
          );
        }
      });
    });

    test("runs as the schema owner without superuser or RLS bypass privileges", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        expect(
          await db.execute<{
            superuser: boolean;
            bypass: boolean;
            ownsDatabase: boolean;
          }>(sql`
          SELECT role.rolsuper AS superuser, role.rolbypassrls AS bypass,
            database.datdba = role.oid AS "ownsDatabase"
          FROM pg_roles role
          JOIN pg_database database ON database.datname = current_database()
          WHERE role.rolname = current_user
        `),
        ).toEqual([{ superuser: false, bypass: false, ownsDatabase: true }]);
        const owners = await db.execute<{
          name: string;
          superuser: boolean;
          bypass: boolean;
        }>(sql`
          SELECT relation.relname AS name, owner.rolsuper AS superuser, owner.rolbypassrls AS bypass
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_roles owner ON owner.oid = relation.relowner
          WHERE namespace.nspname IN ('public', 'drizzle') AND relation.relkind IN ('r', 'p')
            AND NOT EXISTS (
              SELECT 1 FROM pg_depend dependency
              WHERE dependency.classid = 'pg_class'::regclass AND dependency.objid = relation.oid
                AND dependency.deptype = 'e'
            )
        `);
        expect(owners.length).toBeGreaterThan(0);
        expect(
          owners.filter(({ superuser, bypass }) => superuser || bypass),
        ).toEqual([]);
      });
    });
  });
}
