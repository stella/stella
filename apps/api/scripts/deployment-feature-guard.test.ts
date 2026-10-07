import { describe, expect, test } from "bun:test";

import {
  BASELINE_REASON,
  buildBaseline,
  diffBaseline,
  loadRealInput,
  readBaseBaseline,
  runSelfTest,
  SELF_TEST_CASES,
} from "./deployment-feature-guard";
import type { ScanInput } from "./lib/deployment-feature-scan";
import {
  createParseCache,
  findingKey,
  scanDeploymentFeatures,
} from "./lib/deployment-feature-scan";

const OWNER = `const LOCAL_DEV_ACCESS_BY_FLAG = {
  FEATURE_A: LOCAL_DEV_ACCESS.open,
  FEATURE_B: LOCAL_DEV_ACCESS.followsFlag,
} as const satisfies Record<DeploymentFeatureFlag, LocalDevAccess>;`;

const HANDLER = "apps/api/src/handlers/things/list.ts";
const ROUTE = "apps/api/src/handlers/things/routes.ts";
const CHILD = "apps/api/src/handlers/things/child-routes.ts";
const IMPORTS = `import Elysia from "elysia";
import list from "@/api/handlers/things/list";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";
`;
const GATE_A = `.use(deploymentFeatureGate(() => isDeploymentFeatureEnabled("FEATURE_A")))`;

const input = ({
  routes,
  handlerSource = "export default {};",
  readers = [
    {
      file: "apps/api/src/lib/b.ts",
      source: `export const b = () => isDeploymentFeatureEnabled("FEATURE_B");`,
    },
  ],
  features = new Map([["things.list", "FEATURE_A"]]),
}: {
  routes: Record<string, string>;
  handlerSource?: string;
  readers?: { file: string; source: string }[];
  features?: Map<string, string | undefined>;
}): ScanInput => {
  const sources = new Map<string, string>([
    [HANDLER, handlerSource],
    ...Object.entries(routes),
  ]);
  return {
    ownerSource: OWNER,
    readerFiles: readers,
    processEnvFiles: [],
    routeFiles: Object.entries(routes).map(([file, source]) => ({
      file,
      source,
    })),
    catalogFeatures: features,
    alwaysOnRouteFiles: new Map(),
    readSource: (file) => sources.get(file),
    allFiles: new Set(sources.keys()),
  };
};

const keys = (scanInput: ScanInput): string[] =>
  scanDeploymentFeatures(scanInput, createParseCache()).findings.map(
    findingKey,
  );

const FLAGGED_KEY = `flagged-capability:things.list@${ROUTE}`;

describe("route gates", () => {
  test("a gate before the route covers it", () => {
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia()${GATE_A}.get("/", list.handler);`,
          },
        }),
      ),
    ).toEqual([]);
  });

  test("a gate after the route does not", () => {
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia().get("/", list.handler)${GATE_A};`,
          },
        }),
      ),
    ).toContain(FLAGGED_KEY);
  });

  test("a gate on another flag does not", () => {
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia().use(deploymentFeatureGate(() => isDeploymentFeatureEnabled("FEATURE_B"))).get("/", list.handler);`,
          },
        }),
      ),
    ).toContain(FLAGGED_KEY);
  });

  test("a child inherits the gate of every parent it is mounted under", () => {
    const child = `${IMPORTS}export const child = new Elysia().get("/", list.handler);`;
    expect(
      keys(
        input({
          routes: {
            [CHILD]: child,
            [ROUTE]: `${IMPORTS}import { child } from "./child-routes";\nexport const r = new Elysia()${GATE_A}.use(child);`,
          },
        }),
      ),
    ).toEqual([]);
    expect(
      keys(
        input({
          routes: {
            [CHILD]: child,
            [ROUTE]: `${IMPORTS}import { child } from "./child-routes";\nexport const r = new Elysia()${GATE_A}.use(child);\nexport const open = new Elysia().use(child);`,
          },
        }),
      ),
    ).toContain(`flagged-capability:things.list@${CHILD}`);
  });

  test("a group's hook stays inside the group", () => {
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia().group("/x", (app) => app${GATE_A}).get("/", list.handler);`,
          },
        }),
      ),
    ).toContain(FLAGGED_KEY);
  });

  test("hook, guard and route-level checks count as gates", () => {
    const forms = [
      `${IMPORTS}export const r = new Elysia().onBeforeHandle(() => { if (!isDeploymentFeatureEnabled("FEATURE_A")) { throw new Error(); } }).get("/", list.handler);`,
      `${IMPORTS}import { env } from "@/api/env";\nexport const r = new Elysia().onRequest(() => (env.FEATURE_A ? undefined : 404)).get("/", list.handler);`,
      `${IMPORTS}export const r = new Elysia().guard({ beforeHandle: () => isDeploymentFeatureEnabled("FEATURE_A") }).get("/", list.handler);`,
      `${IMPORTS}export const r = new Elysia().get("/", list.handler, { beforeHandle: () => isDeploymentFeatureEnabled("FEATURE_A") });`,
    ];
    for (const route of forms) {
      expect(keys(input({ routes: { [ROUTE]: route } }))).toEqual([]);
    }
  });

  test("a flag read inside the handler is not a gate", () => {
    for (const handlerSource of [
      `export default () => ({ extra: isDeploymentFeatureEnabled("FEATURE_A") });`,
      `export default () => { if (!isDeploymentFeatureEnabled("FEATURE_A")) { throw new Error(); } };`,
    ]) {
      expect(
        keys(
          input({
            routes: {
              [ROUTE]: `${IMPORTS}export const r = new Elysia().get("/", list.handler);`,
            },
            handlerSource,
          }),
        ),
      ).toContain(FLAGGED_KEY);
    }
  });

  test("a chain derived from an instance sees only the gates registered before it", () => {
    const gate = `app${GATE_A};`;
    const derived = `export const routes = app.get("/", list.handler);`;
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}const app = new Elysia();\n${derived}\n${gate}`,
          },
        }),
      ),
    ).toContain(FLAGGED_KEY);
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}const app = new Elysia();\n${gate}\n${derived}`,
          },
        }),
      ),
    ).toEqual([]);
    // A base in another module ran every statement before it was imported.
    expect(
      keys(
        input({
          routes: {
            [CHILD]: `${IMPORTS}export const app = new Elysia();\n${gate}`,
            [ROUTE]: `${IMPORTS}import { app } from "./child-routes";\n${derived}`,
          },
        }),
      ),
    ).toEqual([]);
  });

  test("factories and statement continuations are walked", () => {
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const create = () => { return new Elysia().get("/", list.handler); };\nexport const r = new Elysia()${GATE_A}.use(create());`,
          },
        }),
      ),
    ).toEqual([]);
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia()${GATE_A};\nr.get("/", list.handler);`,
          },
        }),
      ),
    ).toEqual([]);
  });

  test("a gate on an undeclared flag fails, and so does an unwalked mount", () => {
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia().use(deploymentFeatureGate(() => isDeploymentFeatureEnabled("FEATURE_Z")))${GATE_A}.get("/", list.handler);`,
          },
        }),
      ),
    ).toEqual([`undeclared-gate-flag:FEATURE_Z:${ROUTE}`]);
    expect(
      keys(
        input({
          routes: {
            [ROUTE]: `${IMPORTS}export const r = new Elysia()${GATE_A};\nexport function mount(app) { return app.get("/", list.handler); }`,
          },
        }),
      ),
    ).toEqual([`unattributed-mount:list.handler@${ROUTE}`]);
  });

  test("a route file outside every class is reported", () => {
    const scanInput = input({
      routes: {
        [ROUTE]: `${IMPORTS}export const r = new Elysia().get("/", list.handler);`,
      },
      features: new Map([["things.list", undefined]]),
      readers: [
        {
          file: "apps/api/src/lib/a.ts",
          source: `isDeploymentFeatureEnabled("FEATURE_A"); isDeploymentFeatureEnabled("FEATURE_B");`,
        },
      ],
    });
    expect(keys(scanInput)).toEqual([`route-file:${ROUTE}`]);
    expect(
      keys({ ...scanInput, alwaysOnRouteFiles: new Map([[ROUTE, "core"]]) }),
    ).toEqual([]);
  });
});

describe("flags", () => {
  const gated = {
    [ROUTE]: `${IMPORTS}export const r = new Elysia()${GATE_A}.get("/", list.handler);`,
  };

  test("a declared flag without a reader is dead", () => {
    expect(keys(input({ routes: gated, readers: [] }))).toEqual([
      "dead-flag:FEATURE_B",
    ]);
  });

  test("tags, catalog entries and sanctioned env reads are readers", () => {
    for (const source of [
      `export const tool = { feature: "FEATURE_B" };`,
      `export const feature = { deploymentFeature: "FEATURE_B" };`,
      `import { env } from "@/api/env";\nexport const on = env.FEATURE_B;`,
      `import { env } from "@/api/env";\nconst { FEATURE_B } = env;`,
    ]) {
      expect(
        keys(
          input({
            routes: gated,
            readers: [{ file: "apps/api/src/lib/b.ts", source }],
          }),
        ),
      ).toEqual([]);
    }
    expect(
      keys(
        input({
          routes: gated,
          readers: [],
          features: new Map([
            ["things.list", "FEATURE_A"],
            ["other.list", "FEATURE_B"],
          ]),
        }),
      ),
    ).toEqual([]);
  });

  test("an undeclared read fails in every reader form", () => {
    const found = keys(
      input({
        routes: gated,
        readers: [
          {
            file: "apps/api/src/lib/b.ts",
            source: `isDeploymentFeatureEnabled("FEATURE_B"); isDeploymentFeatureEnabled("FEATURE_Y"); const t = { feature: "FEATURE_X" };`,
          },
        ],
        features: new Map([
          ["things.list", "FEATURE_A"],
          ["other.list", "FEATURE_W"],
        ]),
      }),
    );
    expect(found).toContain("undeclared-read:FEATURE_Y:apps/api/src/lib/b.ts");
    expect(found).toContain("undeclared-read:FEATURE_X:apps/api/src/lib/b.ts");
    expect(found).toContain("undeclared-read:FEATURE_W:catalog:other.list");
  });

  test("a process-env read is never a reader and always fails", () => {
    const found = keys(
      input({
        routes: gated,
        readers: [
          {
            file: "apps/api/src/lib/b.ts",
            source: `export const b = process.env.FEATURE_B; const { FEATURE_A } = globalThis.process.env;`,
          },
        ],
      }),
    );
    expect(found).toContain("dead-flag:FEATURE_B");
    expect(found).toContain("process-env-read:FEATURE_B:apps/api/src/lib/b.ts");
    expect(found).toContain("process-env-read:FEATURE_A:apps/api/src/lib/b.ts");
  });
});

describe("baseline", () => {
  const findings = scanDeploymentFeatures(
    input({
      routes: {
        [ROUTE]: `${IMPORTS}export const r = new Elysia().get("/", list.handler);`,
      },
      readers: [],
    }),
    createParseCache(),
  ).findings;
  const rows = buildBaseline(findings);

  test("rows carry the one generic reason and sort by key", () => {
    expect(rows.map(({ key }) => key)).toEqual([
      "dead-flag:FEATURE_B",
      FLAGGED_KEY,
    ]);
    expect(rows.every(({ reason }) => reason === BASELINE_REASON)).toBe(true);
  });

  test("new, stale, grown and unsorted rows fail", () => {
    expect(
      diffBaseline({ findings, baseline: rows, baseBaseline: rows }),
    ).toEqual({
      errors: [],
      unbaselined: [],
      stale: [],
      grown: [],
      malformed: false,
    });
    const [first, second] = rows;
    if (first === undefined || second === undefined) {
      throw new Error("expected two rows");
    }
    expect(
      diffBaseline({ findings, baseline: [first], baseBaseline: undefined })
        .unbaselined,
    ).toEqual([second.key]);
    expect(
      diffBaseline({
        findings: findings.slice(1),
        baseline: rows,
        baseBaseline: undefined,
      }).stale,
    ).toEqual([first.key]);
    expect(
      diffBaseline({ findings, baseline: rows, baseBaseline: [first] }).grown,
    ).toEqual([second.key]);
    expect(
      diffBaseline({
        findings,
        baseline: [second, first],
        baseBaseline: undefined,
      }).malformed,
    ).toBe(true);
  });

  test("written rows pass the order check for keys that collate differently", () => {
    const deadFlags = ["FEATURE_AIR", "FEATURE_AI_X", "FEATURE_a", "FEATURE_B"];
    const findingsByFlag = deadFlags.map((flag) => ({
      kind: "dead-flag" as const,
      flag,
    }));
    const written = buildBaseline(findingsByFlag);
    expect(written.map(({ key }) => key)).toEqual(
      ["FEATURE_AIR", "FEATURE_AI_X", "FEATURE_B", "FEATURE_a"].map(
        (flag) => `dead-flag:${flag}`,
      ),
    );
    expect(
      diffBaseline({
        findings: findingsByFlag,
        baseline: written,
        baseBaseline: undefined,
      }).malformed,
    ).toBe(false);
  });

  test("a base revision that does not resolve fails instead of skipping growth", () => {
    expect(() => readBaseBaseline("refs/heads/no-such-base-revision")).toThrow(
      "is not a commit",
    );
    expect(Array.isArray(readBaseBaseline("HEAD"))).toBe(true);
  });

  test("an empty or missing --base value fails", () => {
    const script = new URL("deployment-feature-guard.ts", import.meta.url)
      .pathname;
    for (const args of [["--base", ""], ["--base"], ["--base", "--report"]]) {
      const run = Bun.spawnSync(["bun", script, ...args], { stderr: "pipe" });
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain("--base needs a revision");
    }
  });
});

describe("real tree", () => {
  // The tree is read and parsed once, outside the test timeouts; the
  // self-test cases reparse only the files they edit.
  const real = loadRealInput();
  const cache = createParseCache();
  const scanned = scanDeploymentFeatures(real, cache);

  test("every self-test detector fires", () => {
    expect(SELF_TEST_CASES.length).toBeGreaterThan(0);
    expect(runSelfTest(real, cache)).toEqual([]);
  });

  test("the scan matches the committed baseline", async () => {
    const committed: unknown = await Bun.file(
      new URL("../deployment-feature-baseline.json", import.meta.url),
    ).json();
    expect(buildBaseline(scanned.findings)).toEqual(
      Array.isArray(committed) ? committed : [],
    );
  });
});
