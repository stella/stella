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
  test("shared view storage and feature execution have separate owners", () => {
    const file = "apps/api/src/routes/ordinary.ts";
    const shared = "apps/api/src/db/schema/views.ts";
    const source =
      'import { views } from "@/api/db/schema/views"; export const read = (tx) => tx.select().from(views);';
    const sources = new Map([
      ...baseSources,
      [shared, 'export const views = p.pgTable("workspace_views", {});'],
      [file, source],
    ]);
    const options = { sources, endpoints: [{ file, config: {} }] };
    expect(validateFeatureAccessDeclarations({ ...options, registry })).toEqual(
      [],
    );
    const broadRegistry = {
      fixture: {
        ...registry.fixture,
        ownership: {
          ...registry.fixture.ownership,
          conditionalTableSchemas: { [shared]: ["views"] },
        },
      },
    };
    expect(
      validateFeatureAccessDeclarations({
        ...options,
        registry: broadRegistry,
      }),
    ).toContainEqual({
      file,
      message: "source ownership requires featureAccess fixture",
    });
    sources.set(
      file,
      'import { run } from "@/api/feature/core"; export const execute = () => run();',
    );
    expect(
      validateFeatureAccessDeclarations({ ...options, registry }),
    ).toContainEqual({
      file,
      message: "source ownership requires featureAccess fixture",
    });
  });
  test.each(["capability", "scheduler"] as const)(
    "%s registration is a dispatch boundary with independently declared entries",
    (kind) => {
      const handler =
        kind === "scheduler"
          ? "apps/api/src/lib/scheduler/tasks/feature.ts"
          : "apps/api/src/routes/feature/run.ts";
      const registryFile = "apps/api/src/dispatch/registry.ts";
      const name =
        kind === "scheduler" ? "SCHEDULER_TASKS" : "CAPABILITY_DISPATCH";
      const target =
        kind === "scheduler"
          ? "task: run"
          : 'load: () => import("../routes/feature/run")';
      const registration = `import { run } from "${kind === "scheduler" ? "../lib/scheduler/tasks/feature" : "../routes/feature/run"}";
export const ${name} = { run: { featureId: "fixture", ${target} } };`;
      const sources = new Map([
        ...baseSources,
        [
          handler,
          'import { run as core } from "@/api/feature/core"; export const featureAccess = { type: "required", featureId: "fixture" }; export const run = () => core();',
        ],
        [registryFile, registration],
        [
          "apps/api/src/routes/ordinary.ts",
          `import * as registry from "../dispatch/registry"; export const list = () => registry;`,
        ],
      ]);
      const endpoints = [
        { file: "apps/api/src/routes/ordinary.ts", config: {} },
        ...(kind === "capability" ? [{ file: handler, config: required }] : []),
      ];
      const validate = () =>
        validateFeatureAccessDeclarations({ registry, endpoints, sources });
      expect(validate()).toEqual([]);
      sources.set(
        registryFile,
        registration.replace('featureId: "fixture", ', ""),
      );
      expect(validate()).toContainEqual({
        file: `${registryFile}.dispatch-entry-0.ts`,
        message: "source ownership requires featureAccess fixture",
      });
      sources.set(registryFile, registration);
      sources.set(
        "apps/api/src/routes/ordinary.ts",
        `import { run } from "${kind === "scheduler" ? "../lib/scheduler/tasks/feature" : "./feature/run"}"; export const direct = () => run();`,
      );
      expect(validate()).toContainEqual({
        file: "apps/api/src/routes/ordinary.ts",
        message: "source ownership requires featureAccess fixture",
      });
      sources.set(
        "apps/api/src/routes/ordinary.ts",
        "export const ordinary = true;",
      );
      if (kind === "scheduler") {
        sources.set(
          handler,
          sources
            .get(handler)
            ?.replace(
              'export const featureAccess = { type: "required", featureId: "fixture" }; ',
              "",
            ) ?? "",
        );
      } else {
        endpoints.splice(1, 1, { file: handler, config: {} });
      }
      expect(validate()).toContainEqual({
        file: handler,
        message: "source ownership requires featureAccess fixture",
      });
    },
  );
  test("aggregate registry spreads retain entry validation and mixed imports retain ownership", () => {
    const additional = [
      [
        "apps/api/src/dispatch/leaf.ts",
        'export const CAPABILITY_DISPATCH = { run: { featureId: "fixture", load: () => import("../routes/feature/run") } };',
      ],
      [
        "apps/api/src/dispatch/registry.ts",
        'import { CAPABILITY_DISPATCH as leaf } from "./leaf"; export const CAPABILITY_DISPATCH = { ...leaf };',
      ],
    ] as const;
    expect(
      check(
        'import { CAPABILITY_DISPATCH } from "../dispatch/registry";',
        {},
        additional,
      ),
    ).toEqual([]);
    expect(
      check(
        'import { run } from "./feature/run"; export const CAPABILITY_DISPATCH = { run: { featureId: "fixture", task: run } }; export const direct = () => run();',
      ),
    ).toContainEqual({
      file: "apps/api/src/routes/ordinary.ts",
      message: "source ownership requires featureAccess fixture",
    });
    expect(
      check(
        'import { run } from "./feature/run"; export const CAPABILITY_DISPATCH = { ...run };',
      ),
    ).toHaveLength(1);
  });
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
  test("conditional table consumers require the shared policy helper", () => {
    const conditionalRegistry = {
      fixture: {
        ...registry.fixture,
        ownership: {
          ...registry.fixture.ownership,
          conditionalTableSchemas: {
            "apps/api/src/db/schema/layout.ts": ["layouts"],
          },
        },
      },
    } as const;
    const file = "apps/api/src/routes/ordinary.ts";
    const sources = new Map([
      ...baseSources,
      [
        "apps/api/src/db/schema/layout.ts",
        'export const layouts = p.pgTable("fixture_layouts", {});',
      ],
    ]);
    sources.set(file, 'import { other } from "../db/schema/layout";');
    expect(
      validateFeatureAccessDeclarations({
        registry: conditionalRegistry,
        endpoints: [{ file, config: {} }],
        sources,
      }),
    ).toEqual([]);
    sources.set(
      file,
      'import * as tables from "../db/schema/layout"; const rows = tables.other;',
    );
    expect(
      validateFeatureAccessDeclarations({
        registry: conditionalRegistry,
        endpoints: [{ file, config: {} }],
        sources,
      }),
    ).toEqual([]);
    for (const read of [
      'import { layouts } from "../db/schema/layout";',
      'import * as tables from "../db/schema/layout"; const rows = tables.layouts;',
      'import * as tables from "../db/schema/layout"; const rows = Object.values(tables);',
      'import * as tables from "../db/schema/layout"; const key = "layouts"; const rows = tables[key];',
      "const rows = sql`select * from fixture_layouts`;",
    ]) {
      sources.set(file, read);
      expect(
        validateFeatureAccessDeclarations({
          registry: conditionalRegistry,
          endpoints: [{ file, config: conditional }],
          sources,
        }),
      ).toEqual([
        {
          file,
          message:
            "featureAccess fixture conditional tables require the shared policy module",
        },
      ]);
      sources.set(file, `${read} import { layout } from "../feature/layout";`);
      expect(
        validateFeatureAccessDeclarations({
          registry: conditionalRegistry,
          endpoints: [{ file, config: conditional }],
          sources,
        }),
      ).toEqual([]);
    }
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
