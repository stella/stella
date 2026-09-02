import { describe, expect, test } from "bun:test";

import { isColumnReferenced, shouldScanFile } from "./check-dead-columns";

describe("isColumnReferenced", () => {
  test("finds a member-access reference by TS key", () => {
    expect(
      isColumnReferenced({
        corpus: "const value = row.autoInvokeHint;",
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(true);
  });

  test("finds a shorthand destructure reference by TS key", () => {
    expect(
      isColumnReferenced({
        corpus: "const { autoInvokeHint } = row;",
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(true);
  });

  test("finds a quoted-string columns-map reference by TS key", () => {
    expect(
      isColumnReferenced({
        corpus:
          'tx.query.agentSkills.findMany({ columns: { "autoInvokeHint": true } });',
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(true);
  });

  test("finds a SQL-name-only reference inside a sql template", () => {
    expect(
      isColumnReferenced({
        corpus: "sql`SELECT auto_invoke_hint FROM agent_skills`",
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(true);
  });

  test("reports no reference when neither the TS key nor the SQL name appears", () => {
    expect(
      isColumnReferenced({
        corpus: "const value = row.someOtherField;",
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(false);
  });

  // Each boundary is exercised on its own: a fixture with word characters on
  // both sides would still pass if only one of the two `\b` anchors broke.
  test("does not match a key that ends a longer identifier", () => {
    expect(
      isColumnReferenced({
        corpus: "const value = row.notautoInvokeHint;",
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(false);
  });

  test("does not match a key that starts a longer identifier", () => {
    expect(
      isColumnReferenced({
        corpus: "const value = row.autoInvokeHintAtAll;",
        tsKey: "autoInvokeHint",
        sqlName: "auto_invoke_hint",
      }),
    ).toBe(false);
  });
});

describe("shouldScanFile", () => {
  test("scans ordinary application source", () => {
    expect(shouldScanFile("apps/api/src/handlers/skills/create.ts")).toBe(true);
    expect(shouldScanFile("apps/web/src/components/search-dialog.tsx")).toBe(
      true,
    );
  });

  test("excludes the schema definitions", () => {
    expect(shouldScanFile("apps/api/src/db/schema.ts")).toBe(false);
  });

  test("excludes spec files as well as test files", () => {
    expect(shouldScanFile("apps/web/src/components/search.spec.ts")).toBe(
      false,
    );
    expect(shouldScanFile("apps/web/src/components/search.spec.tsx")).toBe(
      false,
    );
    expect(shouldScanFile("apps/api/src/db/schema/properties.ts")).toBe(false);
  });

  test("excludes test files, including integration and property suites", () => {
    expect(shouldScanFile("apps/api/src/handlers/skills/create.test.ts")).toBe(
      false,
    );
    expect(
      shouldScanFile("apps/api/src/lib/workspace-deletion.integration.test.ts"),
    ).toBe(false);
    expect(
      shouldScanFile("scripts/prepare-maintenance-release.property.test.ts"),
    ).toBe(false);
    expect(shouldScanFile("apps/api/src/db/schema/entities.test.ts")).toBe(
      false,
    );
  });

  test("excludes generated typings, migrations, and node_modules", () => {
    expect(shouldScanFile("apps/api/src/env.d.ts")).toBe(false);
    expect(
      shouldScanFile("apps/api/drizzle/20260101000000_x/migration.ts"),
    ).toBe(false);
    expect(shouldScanFile("apps/api/node_modules/foo/index.ts")).toBe(false);
  });

  test("excludes non-TypeScript files", () => {
    expect(shouldScanFile("apps/api/src/handlers/skills/README.md")).toBe(
      false,
    );
  });
});
