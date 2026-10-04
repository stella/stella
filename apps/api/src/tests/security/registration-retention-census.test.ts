import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { TABLE_RETENTION } from "@/api/db/retention";

import { collectRetentionWrites } from "./registration-retention-census";

const apiRoot = path.resolve(import.meta.dirname, "../../..");
const repoRoot = path.resolve(apiRoot, "../..");

const exemptRouteFiles = () => {
  const config = ts.createSourceFile(
    "oxlint.config.ts",
    readFileSync(path.join(repoRoot, "oxlint.config.ts"), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const files: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const rules = node.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          property.name.getText() === "rules",
      );
      if (
        rules &&
        ts.isPropertyAssignment(rules) &&
        ts.isObjectLiteralExpression(rules.initializer)
      ) {
        const exempt = rules.initializer.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.name) &&
            property.name.text ===
              "require-safe-route-handlers/require-safe-route-handlers" &&
            ts.isStringLiteral(property.initializer) &&
            property.initializer.text === "off",
        );
        if (exempt) {
          const paths = node.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText() === "files",
          );
          if (
            paths &&
            ts.isPropertyAssignment(paths) &&
            ts.isArrayLiteralExpression(paths.initializer)
          ) {
            for (const item of paths.initializer.elements) {
              if (
                ts.isStringLiteral(item) &&
                item.text.startsWith("apps/api/src/handlers/")
              ) {
                files.push(item.text.slice("apps/api/".length));
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(config);
  return files;
};

describe("handler retention declarations", () => {
  test("every collected table has a declaration", () => {
    for (const declaration of Object.values(TABLE_RETENTION)) {
      if ("boundedBy" in declaration) {
        expect(declaration.boundedBy.trim()).not.toBe("");
        continue;
      }
      expect(declaration.ttlColumn.trim()).not.toBe("");
      expect(declaration.sweeper.trim()).not.toBe("");
    }
    const sources = new Map<string, string>();
    for (const name of new Bun.Glob("src/**/*.{ts,tsx}").scanSync({
      cwd: apiRoot,
    })) {
      if (
        name.includes("/tests/") ||
        name.endsWith(".test.ts") ||
        name.endsWith(".test.tsx")
      ) {
        continue;
      }
      sources.set(name, readFileSync(path.join(apiRoot, name), "utf-8"));
    }
    const routes = exemptRouteFiles();
    expect(routes.length).toBeGreaterThan(0);
    const result = collectRetentionWrites({
      sources,
      roots: [...sources.keys()].filter((name) =>
        name.startsWith("src/handlers/"),
      ),
      routeFiles: routes,
      declarations: new Set(Object.keys(TABLE_RETENTION)),
    });
    expect(result.tables).toContain("agent_registration");
    expect(result.issues).toEqual([]);
  });

  test("follows imported callbacks and table aliases", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/routes.ts",
          'import { callback } from "./callback"; router.post(PATH, callback);',
        ],
        [
          "src/handlers/callback.ts",
          'import { records as target } from "../db/schema"; export const callback = () => db.insert(target).values({});',
        ],
        ["src/db/schema.ts", 'export const records = pgTable("records", {});'],
      ]),
      roots: ["src/handlers/routes.ts"],
      routeFiles: ["src/handlers/routes.ts"],
      declarations: new Set(["records"]),
    });
    expect(result).toEqual({ tables: ["records"], issues: [] });
  });

  test("requires a declaration for a new table", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          'const records = pgTable("records", {}); createSafePublicHandler({}, () => db.insert(records).values({}));',
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.tables).toEqual(["records"]);
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts: missing retention declaration for records",
    ]);
  });

  test("requires resolvable table targets", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          "createSafeTokenHandler({}, () => db.insert(selectTable()).values({}));",
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts: unresolved insert target selectTable()",
    ]);
  });

  test("excludes session callbacks and retains other callbacks", () => {
    const cases = [
      {
        route: "router.guard({ validateSession: true }).post(PATH, callback)",
        tables: [],
      },
      {
        route: "router.post(PATH, callback, { validateAuth: true })",
        tables: [],
      },
      {
        route:
          "router.guard({ validateAuth: true }).guard({ validateAuth: false }).post(PATH, callback)",
        tables: ["records"],
      },
      {
        route:
          "router.guard({ validateAuth: true }).post(PATH, callback, { validateAuth: false })",
        tables: ["records"],
      },
    ];
    for (const { route, tables } of cases) {
      const result = collectRetentionWrites({
        sources: new Map([
          [
            "src/handlers/routes.ts",
            `const records = pgTable("records", {}); const callback = () => db.insert(records); ${route};`,
          ],
        ]),
        roots: ["src/handlers/routes.ts"],
        routeFiles: ["src/handlers/routes.ts"],
        declarations: new Set(["records"]),
      });
      expect(result).toEqual({ tables, issues: [] });
    }
  });

  test("follows reexports and aliased public factories", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        ["src/handlers/routes.ts", 'export { route } from "./route-core";'],
        [
          "src/handlers/route-core.ts",
          'import { callback } from "./callback"; export const route = router.post(PATH, callback);',
        ],
        [
          "src/handlers/callback.ts",
          'import { records } from "../db/schema"; export const callback = () => db.insert(records);',
        ],
        [
          "src/handlers/public.ts",
          'import { createSafePublicHandler as createPublic } from "external"; import { records } from "../db/schema"; createPublic({}, () => db.insert(records));',
        ],
        ["src/db/schema.ts", 'export { rows as records } from "./tables";'],
        ["src/db/tables.ts", 'export const rows = pgTable("records", {});'],
      ]),
      roots: ["src/handlers/routes.ts", "src/handlers/public.ts"],
      routeFiles: ["src/handlers/routes.ts"],
      declarations: new Set(["records"]),
    });
    expect(result).toEqual({ tables: ["records"], issues: [] });
  });

  test("requires resolvable repository imports", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          'import { callback } from "./missing"; createSafePublicHandler({}, callback);',
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts:callback: unresolved import",
    ]);
  });

  test("follows namespace helpers and callback aliases", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          'import * as helpers from "./helpers"; const callback = helpers.callback; createSafePublicHandler({}, callback);',
        ],
        [
          "src/handlers/helpers.ts",
          'import * as tables from "../db/schema"; export const callback = () => store.write(); const store = { write: () => db.insert(tables.records) };',
        ],
        ["src/db/schema.ts", 'export const records = pgTable("records", {});'],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(["records"]),
    });
    expect(result).toEqual({ tables: ["records"], issues: [] });
  });

  test("requires declarations for SQL insert targets", () => {
    const interpolationStart = "$";
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          `createSafePublicHandler({}, () => db.execute(sql\`INSERT INTO records (id) VALUES (${interpolationStart}{value})\`));`,
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result).toEqual({
      tables: ["records"],
      issues: [
        "src/handlers/fixture.ts: missing retention declaration for records",
      ],
    });
  });

  test("requires resolvable SQL insert targets", () => {
    const interpolationStart = "$";
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          `createSafePublicHandler({}, () => db.execute(sql\`INSERT INTO ${interpolationStart}{selectTable()} (id) VALUES (${interpolationStart}{value})\`));`,
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts: unresolved insert target selectTable()",
    ]);
  });

  test("requires resolvable imported bindings", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          'import { callback } from "./helpers"; createSafePublicHandler({}, callback);',
        ],
        ["src/handlers/helpers.ts", "export const ready = true;"],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts:callback: unresolved imported binding",
    ]);
  });

  test("requires resolvable namespace callback selection", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          'import * as helpers from "./helpers"; createSafePublicHandler({}, helpers[operation]);',
        ],
        ["src/handlers/helpers.ts", "export const callback = () => undefined;"],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts: unresolved namespace access helpers[operation]",
    ]);
  });

  test("requires declarations for raw SQL insert targets", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          'const statement = sql.raw("INSERT INTO records (id) VALUES (1)"); createSafePublicHandler({}, () => db.execute(statement));',
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts: missing retention declaration for records",
    ]);
  });

  test("requires resolvable raw SQL commands", () => {
    const result = collectRetentionWrites({
      sources: new Map([
        [
          "src/handlers/fixture.ts",
          "const statement = sql.raw(makeStatement()); createSafePublicHandler({}, () => db.execute(statement));",
        ],
      ]),
      roots: ["src/handlers/fixture.ts"],
      routeFiles: [],
      declarations: new Set(),
    });
    expect(result.issues).toEqual([
      "src/handlers/fixture.ts: unresolved SQL command",
    ]);
  });
});
