import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  assertFeatureAccessDeclarations,
  validateFeatureAccessDeclarations,
} from "./feature-access-declarations";

const registry = {
  fixture: {
    enrolment: "invitation",
    ownership: {
      handlerDirectories: ["apps/api/src/routes/feature"],
      tableSchemaFiles: ["apps/api/src/db/schema/feature.ts"],
      coreModules: ["apps/api/src/feature/core.ts"],
      conditionalModules: ["apps/api/src/feature/layout.ts"],
    },
  },
} as const;
const baseSources = new Map([
  ["apps/api/src/routes/feature/run.ts", "export const run = () => true;"],
  [
    "apps/api/src/db/schema/feature.ts",
    'export const featureRows = p.pgTable("fixture_rows", {});',
  ],
  [
    "apps/api/src/db/schema/ordinary.ts",
    'export const ordinaryRows = p.pgTable("ordinary_rows", {});',
  ],
  [
    "apps/api/src/db/schema.ts",
    'export * from "./schema/feature"; export * from "./schema/ordinary";',
  ],
  ["apps/api/src/feature/core.ts", "export const run = () => true;"],
  [
    "apps/api/src/feature/layout.ts",
    'import { run } from "./core"; export const layout = () => run();',
  ],
]);
const check = (
  source: string,
  config: Record<string, unknown> = {},
  additional: readonly (readonly [string, string])[] = [],
) =>
  validateFeatureAccessDeclarations({
    registry,
    endpoints: [{ file: "apps/api/src/routes/ordinary.ts", config }],
    sources: new Map([
      ...baseSources,
      ["apps/api/src/routes/ordinary.ts", source],
      ...additional,
    ]),
  });
const required = { featureAccess: { type: "required", featureId: "fixture" } };
const conditional = {
  featureAccess: {
    type: "conditional",
    featureId: "fixture",
    usesFeature: () => true,
  },
};

describe("feature source declarations", () => {
  test("named schema barrel imports require only the selected table owner", () => {
    expect(check('import { ordinaryRows } from "@/api/db/schema";')).toEqual(
      [],
    );
    expect(
      check('import { featureRows as rows } from "@/api/db/schema";'),
    ).toHaveLength(1);
    expect(
      check('import { featureRows } from "@/api/db/schema";', required),
    ).toEqual([]);
    expect(
      check('import type { featureRows } from "@/api/db/schema";'),
    ).toEqual([]);
    expect(
      check('import { type featureRows } from "@/api/db/schema";'),
    ).toEqual([]);
  });
  test("helper imports and named reexports preserve table ownership", () => {
    const additional = [
      [
        "apps/api/src/helpers/read.ts",
        'import { featureRows } from "../db/schema"; export const read = () => featureRows;',
      ],
      [
        "apps/api/src/helpers/barrel.ts",
        'export { read as renamed } from "./read";',
      ],
    ] as const;
    expect(
      check('import { renamed } from "../helpers/barrel";', {}, additional),
    ).toHaveLength(1);
    expect(
      check(
        'import { renamed } from "../helpers/barrel";',
        required,
        additional,
      ),
    ).toEqual([]);
  });
  test("direct and helper SQL literals require the owned table policy", () => {
    expect(
      check('const query = sql`select * from "fixture_rows"`;'),
    ).toHaveLength(1);
    expect(
      check('import { read } from "../helpers/read";', {}, [
        [
          "apps/api/src/helpers/read.ts",
          'export const read = () => sql.raw("select * from fixture_rows");',
        ],
      ]),
    ).toHaveLength(1);
    expect(
      check("// fixture_rows\nconst query = sql`select * from ordinary_rows`;"),
    ).toEqual([]);
    expect(
      check("const query = sql`select * from fixture_rows`; ", required),
    ).toEqual([]);
  });
  test("conditional helper is a policy boundary, requiring the conditional declaration", () => {
    const source = 'import { layout } from "../feature/layout";';
    expect(check(source)).toHaveLength(1);
    expect(check(source, required)).toHaveLength(1);
    expect(check(source, conditional)).toEqual([]);
    expect(
      check(source, {
        featureAccess: { type: "conditional", featureId: "fixture" },
      }),
    ).toHaveLength(1);
  });
  test("Drizzle schema registration is structural; actual table access still requires policy", () => {
    const registration =
      'import { drizzle as connect } from "drizzle-orm/bun-sql"; import * as schema from "../db/schema"; export const db = connect({ schema });';
    const additional = [["apps/api/src/helpers/db.ts", registration]] as const;
    expect(
      check('import { db } from "../helpers/db";', {}, additional),
    ).toEqual([]);
    expect(
      check('import { db } from "../helpers/db";', {}, [
        [
          "apps/api/src/helpers/db.ts",
          `${registration} export const read = () => schema.featureRows;`,
        ],
      ]),
    ).toHaveLength(1);
  });
  test("dynamic core imports and owned handler directories require a declaration", () => {
    expect(check('const run = await import("../feature/core");')).toHaveLength(
      1,
    );
    expect(
      validateFeatureAccessDeclarations({
        registry,
        endpoints: [{ file: "apps/api/src/routes/feature/run.ts", config: {} }],
        sources: new Map([
          ...baseSources,
          [
            "apps/api/src/routes/feature/run.ts",
            "export const run = () => true;",
          ],
        ]),
      }),
    ).toHaveLength(1);
  });
  test("unknown declarations, missing sources and empty ownership refuse the build", () => {
    expect(
      check("", { featureAccess: { type: "required", featureId: "unknown" } }),
    ).toHaveLength(1);
    expect(
      validateFeatureAccessDeclarations({
        registry: { fixture: { enrolment: "invitation" } },
        endpoints: [],
        sources: new Map(),
      }),
    ).toHaveLength(1);
    expect(() =>
      assertFeatureAccessDeclarations({
        registry,
        endpoints: [],
        sources: new Map(),
      }),
    ).toThrow("missing source");
  });
  test("real ordinary and verification handlers distinguish source ownership", async () => {
    const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
    const sources = new Map<string, string>();
    for await (const file of new Bun.Glob("{src,scripts}/**/*.{ts,tsx}").scan({
      cwd: apiDirectory,
    })) {
      if (file.includes(".test.") || file.startsWith("src/tests/")) {
        continue;
      }
      sources.set(
        `apps/api/${file}`,
        await Bun.file(`${apiDirectory}${file}`).text(),
      );
    }
    const ownedRegistry = {
      fixture: {
        enrolment: "invitation",
        ownership: {
          handlerDirectories: ["apps/api/src/handlers/lists/verifications"],
          tableSchemaFiles: ["apps/api/src/db/schema/lists-verification.ts"],
          coreModules: ["apps/api/src/lib/lists/verification/run-queue.ts"],
        },
      },
    } as const;
    const ordinary = "apps/api/src/handlers/seller-profiles/get.ts";
    const featureFile = "apps/api/src/handlers/lists/verifications/create.ts";
    expect(sources.has(ordinary)).toBe(true);
    expect(sources.has(featureFile)).toBe(true);
    const violations = validateFeatureAccessDeclarations({
      registry: ownedRegistry,
      endpoints: [
        { file: ordinary, config: {} },
        { file: featureFile, config: {} },
      ],
      sources,
    });
    expect(
      violations.filter((violation) => violation.file === ordinary),
    ).toEqual([]);
    expect(
      violations.some(
        (violation) =>
          violation.file === featureFile &&
          violation.message.includes("requires featureAccess fixture"),
      ),
    ).toBe(true);
  });
});
