import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { FEATURE_REGISTRY } from "../../src/lib/feature-access/registry";
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
  test.each(["registry", "admitted"] as const)(
    "%s dispatch boundaries preserve direct-access ownership enforcement",
    (type) => {
      const module = "apps/api/src/dispatch/tools.ts";
      const boundary =
        type === "registry"
          ? { type, module, registry: "TOOL_SETS" }
          : { type, module, admission: "isMcpDescriptorFeatureEnabled" };
      const declaration =
        type === "registry"
          ? "export const TOOL_SETS = [core];"
          : 'import { isMcpDescriptorFeatureEnabled as admit } from "@/api/mcp/feature-access"; export const run = () => admit({}) && core();';
      const sources = new Map([
        ...baseSources,
        [
          "apps/api/src/mcp/feature-access.ts",
          "export const isMcpDescriptorFeatureEnabled = () => true;",
        ],
        [
          module,
          `import { run as core } from "../feature/core"; ${declaration}`,
        ],
        [
          "apps/api/src/routes/ordinary.ts",
          'import * as tools from "../dispatch/tools"; export const run = () => tools;',
        ],
      ]);
      const validate = () =>
        validateFeatureAccessDeclarations({
          registry: {
            fixture: {
              ...registry.fixture,
              ownership: {
                ...registry.fixture.ownership,
                dispatchModules: [boundary],
              },
            },
          },
          endpoints: [{ file: "apps/api/src/routes/ordinary.ts", config: {} }],
          sources,
        });
      expect(validate()).toEqual([]);
      sources.set(
        "apps/api/src/routes/ordinary.ts",
        'import { run } from "../feature/core"; export const direct = () => run();',
      );
      expect(validate()).toContainEqual({
        file: "apps/api/src/routes/ordinary.ts",
        message: "source ownership requires featureAccess fixture",
      });
      sources.set(
        module,
        type === "registry"
          ? "export const TOOL_SETS = {};"
          : 'import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access"; export const run = () => true;',
      );
      expect(validate()).toContainEqual({
        file: module,
        message: `feature fixture has an invalid ${type} dispatch boundary`,
      });
      sources.delete(module);
      expect(validate()).toContainEqual({
        file: module,
        message: "feature fixture owns a missing dispatch module",
      });
    },
  );
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
  test("dispatch feature ids that share a conditional table name remain required metadata", () => {
    const sources = new Map([
      ...baseSources,
      [
        "apps/api/src/db/schema/conditional.ts",
        'export const fixture = p.pgTable("fixture", {});',
      ],
      [
        "apps/api/src/dispatch/registry.ts",
        'export const CAPABILITY_DISPATCH = { run: { featureId: "fixture", load: () => import("../routes/feature/run") } };',
      ],
    ]);
    const ownership = {
      ...registry.fixture.ownership,
      conditionalTableSchemas: {
        "apps/api/src/db/schema/conditional.ts": ["fixture"],
      },
    };
    const options = {
      registry: { fixture: { ...registry.fixture, ownership } },
      sources,
      endpoints: [],
    };
    expect(validateFeatureAccessDeclarations(options)).toEqual([]);
    sources.set(
      "apps/api/src/routes/ordinary.ts",
      "export const read = () => sql`select * from fixture`;",
    );
    expect(
      validateFeatureAccessDeclarations({
        ...options,
        endpoints: [{ file: "apps/api/src/routes/ordinary.ts", config: {} }],
      }),
    ).toContainEqual({
      file: "apps/api/src/routes/ordinary.ts",
      message: "source ownership requires featureAccess fixture",
    });
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
  test("generic aggregate locking attributes table ownership to the selected resource", () => {
    const engine = "apps/api/src/lib/db/aggregate-lock.ts";
    const source = `
      const rowResource = (options) => {
        switch (options.aggregate) {
          case "ordinary": return { table: "ordinary_rows" };
          case "feature": return { table: "fixture_rows" };
        }
      };
      export const lock = (options) => rowResource(options);
      export const transaction = (work) => work();
    `;
    const imports =
      'import { lock, transaction } from "@/api/lib/db/aggregate-lock";';
    expect(
      check(
        `${imports} transaction(() => lock({ aggregate: "ordinary" }));`,
        {},
        [[engine, source]],
      ),
    ).toEqual([]);
    expect(
      check(`${imports} lock({ aggregate: "feature" });`, {}, [
        [engine, source],
      ]),
    ).toHaveLength(1);
    expect(
      check('import { read } from "./helper"; read();', {}, [
        [engine, source],
        [
          "apps/api/src/routes/helper.ts",
          `${imports} export const read = () => lock({ aggregate: "feature" });`,
        ],
      ]),
    ).toHaveLength(1);
    expect(
      check(`${imports} transaction(() => true);`, {}, [
        [
          engine,
          `${source} export const read = () => sql\`select * from fixture_rows\`;`,
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
    const ordinary = "apps/api/src/handlers/contacts/get.ts";
    const featureFile = "apps/api/src/handlers/lists/verifications/create.ts";
    expect(sources.has(ordinary)).toBe(true);
    expect(sources.has(featureFile)).toBe(true);
    const additional = "apps/api/src/handlers/lists/fixture/list.ts";
    sources.set(additional, "export const list = () => true;");
    expect(
      validateFeatureAccessDeclarations({
        registry: FEATURE_REGISTRY,
        endpoints: [{ file: additional, config: {} }],
        sources,
      }),
    ).toContainEqual({
      file: additional,
      message: "source ownership requires featureAccess legal-lists",
    });

    const violations = validateFeatureAccessDeclarations({
      registry: FEATURE_REGISTRY,
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
          violation.message.includes(
            "requires featureAccess list-verification",
          ),
      ),
    ).toBe(true);

    const isolatedConsumers = [
      "apps/api/src/lib/files/pdf-signing/sessions.ts",
      "apps/api/src/lib/lists/sanctions/monitoring-backfill.ts",
      "apps/api/src/lib/lists/sanctions/monitoring-fanout.ts",
    ];
    const flowRegistry = {
      flows: {
        enrolment: "self-serve",
        ownership: {
          handlerDirectories: [],
          tableSchemaFiles: [],
          conditionalTableSchemas: {
            "apps/api/src/db/schema/flows.ts": ["flowRuns", "flowRunSteps"],
          },
          coreModules: ["apps/api/src/lib/db/flow-run-transition-spec.ts"],
        },
      },
    } as const;
    const isolatedEndpoints = isolatedConsumers.map((file) => ({
      file,
      config: {},
    }));
    expect(
      validateFeatureAccessDeclarations({
        registry: flowRegistry,
        endpoints: isolatedEndpoints,
        sources,
      }).filter((violation) => isolatedConsumers.includes(violation.file)),
    ).toEqual([]);
    for (const file of isolatedConsumers) {
      const source = sources.get(file);
      const owner = file.includes("/pdf-signing/")
        ? "@/api/lib/files/pdf-signing/transition-spec"
        : "@/api/lib/lists/sanctions/monitoring-transition-specs";
      expect(source).toContain(owner);
      const contaminated = new Map(sources);
      contaminated.set(
        file,
        `${source ?? ""}\nimport { TRANSITIONS } from "@/api/lib/db/transition-specs"; export const candidate = TRANSITIONS.flowRuns;`,
      );
      expect(
        validateFeatureAccessDeclarations({
          registry: flowRegistry,
          endpoints: isolatedEndpoints,
          sources: contaminated,
        }).some((violation) => violation.file === file),
      ).toBe(true);
    }
  });

  test("every endpoint reaching a shared module receives its feature uses", () => {
    const declared = "apps/api/src/routes/declared.ts";
    const throughTable = "apps/api/src/routes/through-table.ts";
    const throughCore = "apps/api/src/routes/through-core.ts";
    // The declared endpoint is checked first and reaches both shared modules,
    // so the later endpoints read the table use and the ownership boundary
    // from the per-run cache.
    expect(
      validateFeatureAccessDeclarations({
        registry,
        endpoints: [
          { file: declared, config: required },
          { file: throughTable, config: {} },
          { file: throughCore, config: {} },
        ],
        sources: new Map([
          ...baseSources,
          [
            "apps/api/src/lib/rows.ts",
            'export const read = (tx) => tx.execute("select * from fixture_rows");',
          ],
          [
            declared,
            'import { read } from "../lib/rows"; import { run } from "../feature/core"; export default () => run() && read;',
          ],
          [
            throughTable,
            'import { read } from "../lib/rows"; export default read;',
          ],
          [
            throughCore,
            'import { run } from "../feature/core"; export default run;',
          ],
        ]),
      }),
    ).toEqual([
      {
        file: throughCore,
        message: "source ownership requires featureAccess fixture",
      },
      {
        file: throughTable,
        message: "source ownership requires featureAccess fixture",
      },
    ]);
  });

  // The capability exporter runs this over ~1,400 endpoints sharing most of
  // one module graph. Re-analysing every reachable module per endpoint once
  // cost ~30 s per export. Module analysis enumerates the registry, so the
  // enumerations each extra endpoint adds must stay below the shared module
  // count (per-endpoint re-analysis added ~11 per module).
  test("shared modules are analysed once, not once per endpoint", () => {
    const moduleCount = 20;
    const body = Array.from(
      { length: 10 },
      (_, index) =>
        `export const f${index} = (db: Db) => db.query.rows${index}.findMany({ where: "ordinary_rows_${index}" });`,
    ).join("\n");
    const shared = new Map(baseSources);
    for (let index = 0; index < moduleCount; index += 1) {
      const next =
        index + 1 < moduleCount
          ? `import { f0 as next } from "./m${index + 1}";\nexport const chain = () => next;\n`
          : "";
      shared.set(`apps/api/src/lib/m${index}.ts`, `${next}${body}`);
    }
    const registryReads = (count: number) => {
      let reads = 0;
      const counted = new Proxy(registry, {
        ownKeys: (target) => {
          reads += 1;
          return Reflect.ownKeys(target);
        },
      });
      const endpoints = Array.from({ length: count }, (_, index) => ({
        file: `apps/api/src/routes/e${index}.ts`,
        config: {},
      }));
      const sources = new Map(shared);
      for (const { file } of endpoints) {
        sources.set(file, 'import { f0 } from "../lib/m0"; export default f0;');
      }
      validateFeatureAccessDeclarations({
        registry: counted,
        endpoints,
        sources,
      });
      return reads;
    };
    const perEndpoint = (registryReads(9) - registryReads(1)) / 8;
    expect(perEndpoint).toBeLessThan(moduleCount);
  });
});

describe("operational dispatch ownership", () => {
  const facade = "apps/api/src/dispatch/receipt.ts";
  const owner = "apps/api/src/feature/receipt-owner.ts";
  const endpoint = "apps/api/src/routes/upload.ts";
  const source =
    'import { record } from "../feature/receipt-owner"; export const upload = async (): Promise<void> => { await record(); };';
  const ownerSource =
    'import { featureRows } from "../db/schema/feature"; export const record = async (): Promise<void> => { await db.insert(featureRows); }; export const read = () => featureRows;';
  const boundary = {
    type: "operational",
    module: facade,
    effects: ["record-recovery"],
    owners: [{ effect: "record-recovery", module: owner, exports: ["record"] }],
    reason: "Persist replay receipts before feature admission.",
  } as const;
  const validate = (
    facadeSource = source,
    ownerBody = ownerSource,
    extra: readonly (readonly [string, string])[] = [],
  ) =>
    validateFeatureAccessDeclarations({
      registry: {
        fixture: {
          ...registry.fixture,
          ownership: {
            ...registry.fixture.ownership,
            dispatchModules: [boundary],
          },
        },
      },
      endpoints: [{ file: endpoint, config: {} }],
      sources: new Map([
        ...baseSources,
        [facade, facadeSource],
        [owner, ownerBody],
        [
          endpoint,
          'import { upload } from "../dispatch/receipt"; export const run = () => upload();',
        ],
        ...extra,
      ]),
    });
  const invalid = {
    file: facade,
    message: "feature fixture has an invalid operational dispatch boundary",
  };

  test("a named void receipt owner does not require upload admission", () => {
    expect(validate()).toEqual([]);
    expect(
      validate(
        source
          .replace("record }", "record as persist }")
          .replace("await record()", "await persist()"),
      ),
    ).toEqual([]);
  });
  test.each([
    'import { record, read } from "../feature/receipt-owner"; export const upload = async (): Promise<void> => { await record(); read(); };',
    'import * as receipts from "../feature/receipt-owner"; export const upload = async (): Promise<void> => { await receipts.record(); };',
    'import receipt from "../feature/receipt-owner"; export const upload = async (): Promise<void> => { await receipt(); };',
    'export { record } from "../feature/receipt-owner";',
    'export * from "../feature/receipt-owner";',
    'export const upload = async (): Promise<void> => { const receipt = await import("../feature/receipt-owner"); await receipt.record(); };',
    'import { record } from "../feature/receipt-owner"; export const upload = async (): Promise<void> => { return record(); };',
    'import { record } from "../feature/receipt-owner"; export const upload = async () => { await record(); };',
    'import { record } from "../feature/receipt-owner"; export const upload = async (): Promise<void> => { const call = record; await call(); };',
    'import { record } from "../feature/receipt-owner"; import { featureRows } from "../db/schema/feature"; export const upload = async (): Promise<void> => { await record(); db.select(featureRows); };',
  ])("rejects an indirect or non-void operational export: %s", (candidate) => {
    expect(validate(candidate)).toContainEqual(invalid);
  });
  test("an unlisted wrapper cannot hide direct feature access", () => {
    const candidate = `${source} import { wrapper } from "./wrapper"; wrapper();`;
    expect(
      validate(candidate, ownerSource, [
        [
          "apps/api/src/dispatch/wrapper.ts",
          'import { run } from "../feature/core"; export const wrapper = () => run();',
        ],
      ]),
    ).toContainEqual(invalid);
  });
  test.each([
    'import { featureRows } from "../db/schema/feature"; export const record = async (): Promise<void> => { return featureRows; };',
    'import { featureRows } from "../db/schema/feature"; export const record = async () => { await db.insert(featureRows); };',
    'import { featureRows } from "../db/schema/feature"; export const different = async (): Promise<void> => { await db.insert(featureRows); };',
  ])("rejects missing or escaping owner exports: %s", (candidate) => {
    expect(validate(source, candidate)).toContainEqual(invalid);
  });
  test("a generic handler still needs its own direct table declaration", () => {
    expect(
      validate(source, ownerSource, [
        [
          endpoint,
          'import { featureRows } from "../db/schema/feature"; export const run = () => db.select(featureRows);',
        ],
      ]),
    ).toContainEqual({
      file: endpoint,
      message: "source ownership requires featureAccess fixture",
    });
  });
  test.each([
    { ...boundary, reason: " " },
    { ...boundary, effects: [] },
    { ...boundary, effects: ["record-recovery", "record-recovery"] },
    { ...boundary, owners: [] },
    { ...boundary, owners: [...boundary.owners, ...boundary.owners] },
    {
      ...boundary,
      owners: [{ effect: "cleanup", module: owner, exports: ["record"] }],
    },
    {
      ...boundary,
      owners: [{ effect: "record-recovery", module: owner, exports: [] }],
    },
  ] as const)("rejects incomplete effect ownership %j", (candidate) => {
    expect(
      validateFeatureAccessDeclarations({
        registry: {
          fixture: {
            ...registry.fixture,
            ownership: {
              ...registry.fixture.ownership,
              dispatchModules: [candidate],
            },
          },
        },
        endpoints: [],
        sources: new Map([
          ...baseSources,
          [facade, source],
          [owner, ownerSource],
        ]),
      }),
    ).toContainEqual(invalid);
  });
});

describe("module paths and SQL table ownership", () => {
  const endpoint = "apps/api/src/routes/ordinary.ts";
  const path = "apps/api/src/lib/fixture_rows/helper.ts";
  const validate = (source: string) =>
    validateFeatureAccessDeclarations({
      registry,
      endpoints: [{ file: endpoint, config: {} }],
      sources: new Map([
        ...baseSources,
        [path, "export const ordinary = () => 1;"],
        [endpoint, source],
      ]),
    });
  test.each([
    'import { ordinary } from "../lib/fixture_rows/helper"; export const run = () => ordinary();',
    'export { ordinary } from "../lib/fixture_rows/helper";',
    'export const run = async () => await import("../lib/fixture_rows/helper");',
  ])("module addresses alone do not declare feature access: %s", (source) => {
    expect(validate(source)).toEqual([]);
  });
  test("real raw SQL table reads still declare feature access", () => {
    expect(
      validate(
        'import { ordinary } from "../lib/fixture_rows/helper"; export const run = (tx) => tx.execute("select * from fixture_rows");',
      ),
    ).toContainEqual({
      file: endpoint,
      message: "source ownership requires featureAccess fixture",
    });
  });
  test("dynamic module expressions still expose their own feature reads", () => {
    expect(
      validate(
        'export const run = (tx) => import(tx.execute("select * from fixture_rows"));',
      ),
    ).toContainEqual({
      file: endpoint,
      message: "source ownership requires featureAccess fixture",
    });
  });
});
