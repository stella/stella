import { expect, test } from "bun:test";
import path from "node:path";

import { inspectDatabasePropertyBudgets } from "./db-property-budget-guard";

const DATABASE_FILE = "apps/api/src/example.test.ts";

const inspect = (body: string, relativePath = DATABASE_FILE) =>
  inspectDatabasePropertyBudgets({
    relativePath,
    source: `
      import fc from "fast-check";
      import { assertProperty, propertyConfig } from "@stll/property-testing";
      import { testDb } from "@/api/tests/security/test-utils";
      import { seedThroughHelper } from "@/api/tests/helpers/seed";
      ${body}
    `,
  });

test("every property in a database-backed file needs an explicit budget", () => {
  const assertion = (config: string) =>
    inspect(
      `assertProperty("p", fc.asyncProperty(fc.string(), seedThroughHelper)${config});`,
    );
  expect(assertion("")).toEqual([
    `${DATABASE_FILE}:6: property in a database-backed test file must configure an explicit numRuns`,
  ]);
  expect(assertion(", propertyConfig()")).toHaveLength(1);
  expect(assertion(", propertyConfig({ seed: 1 })")).toHaveLength(1);
  expect(assertion(", propertyConfig({ numRuns: 12 })")).toEqual([]);
  expect(assertion(", { numRuns: 12 }")).toEqual([]);
  // A property that never reaches the database still shares the file's budget rule.
  expect(
    inspect(`fc.assert(fc.property(fc.string(), (value) => value === value));`),
  ).toHaveLength(1);
});

test("budgeted config helpers count, unbudgeted ones do not", () => {
  expect(
    inspect(`
      const config = (numRuns: number) => propertyConfig({ numRuns, seed: 1 });
      fc.assert(fc.property(fc.string(), () => true), config(40));
    `),
  ).toEqual([]);
  expect(
    inspect(`
      const config = () => propertyConfig({ seed: 1 });
      fc.assert(fc.property(fc.string(), () => true), config());
    `),
  ).toHaveLength(1);
});

test("database-backed files are recognized by provider, name or database URL", () => {
  const unbudgeted = `fc.assert(fc.property(fc.string(), () => true));`;
  const source = (header: string) => `
    import * as fc from "fast-check";
    ${header}
    ${unbudgeted}
  `;
  const check = (relativePath: string, header: string) =>
    inspectDatabasePropertyBudgets({ relativePath, source: source(header) });

  expect(
    check(DATABASE_FILE, `import { db } from "@/api/tests/pglite-test-db";`),
  ).toHaveLength(1);
  expect(
    check(
      DATABASE_FILE,
      `import { gated } from "@/api/tests/gated-test-database";`,
    ),
  ).toHaveLength(1);
  expect(check("apps/api/src/example.postgres.test.ts", "")).toHaveLength(1);
  expect(check("apps/api/src/example.db.test.ts", "")).toHaveLength(1);
  expect(
    check(DATABASE_FILE, `const url = process.env["DATABASE_URL"];`),
  ).toHaveLength(1);
  expect(
    check(DATABASE_FILE, `import { mock } from "@/api/tests/scoped-db-mock";`),
  ).toEqual([]);
});

test("removing the entity-create property budget fails the guard", async () => {
  const relativePath = "apps/api/src/lib/uploads/entity-create.test.ts";
  const source = await Bun.file(
    path.resolve(import.meta.dir, "..", relativePath),
  ).text();
  expect(inspectDatabasePropertyBudgets({ relativePath, source })).toEqual([]);

  const unbudgeted = source.replace(/^\s*numRuns: \d+,\n/mu, "");
  expect(unbudgeted).not.toBe(source);
  expect(
    inspectDatabasePropertyBudgets({ relativePath, source: unbudgeted }),
  ).toHaveLength(1);
});
