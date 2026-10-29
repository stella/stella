import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  readRolePrivilegeCensus,
  type RoleCensus,
  withMigratedRolePrivilegeCensus,
} from "@/api/tests/helpers/role-privilege-census-fixture";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const describePostgres = describe.skipIf(!runPostgresTests);
const censusPath = path.join(import.meta.dir, "role-privilege-census.json");

const censusLines = (census: RoleCensus[]) =>
  census.flatMap(({ role, attributes, memberships, privileges }) => [
    `${role} role`,
    ...attributes.map((attribute) => `${role} attribute:${attribute}`),
    ...memberships.map((membership) => `${role} membership:${membership}`),
    ...privileges.map((privilege) => `${role} ${privilege}`),
  ]);

const assertCensus = (expected: RoleCensus[], actual: RoleCensus[]) => {
  const expectedLines = new Set(censusLines(expected));
  const actualLines = new Set(censusLines(actual));
  const removed = [...expectedLines]
    .filter((line) => !actualLines.has(line))
    .map((line) => `- ${line}`);
  const added = [...actualLines]
    .filter((line) => !expectedLines.has(line))
    .map((line) => `+ ${line}`);
  if (removed.length > 0 || added.length > 0) {
    throw new Error(
      `Database role privilege census changed:\n${[...removed, ...added].join("\n")}`,
    );
  }
};

describePostgres("database role privilege census", () => {
  // timeout: initializing PostgreSQL and applying the complete migration chain is the behavior under test.
  test("matches every migrated role and effective privilege", async () => {
    const expected = JSON.parse(readFileSync(censusPath, "utf-8"));
    await withMigratedRolePrivilegeCensus(async (_database, actual) => {
      assertCensus(expected, actual);
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a fixture migration's additional role privilege", async () => {
    const expected = JSON.parse(readFileSync(censusPath, "utf-8"));
    await withMigratedRolePrivilegeCensus(async (database, baseline) => {
      assertCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE ROLE "${role}" NOLOGIN; GRANT SELECT ON TABLE public.account TO "${role}"`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCensus(expected, mutated)).toThrow(
          `${role} table:public.account:SELECT`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);
});
