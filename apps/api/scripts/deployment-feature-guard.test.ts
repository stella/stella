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
import type { MountedRoute, ScanInput } from "./lib/deployment-feature-scan";
import {
  createParseCache,
  findingKey,
  scanDeploymentFeatures,
} from "./lib/deployment-feature-scan";

const OWNER = `const LOCAL_DEV_ACCESS_BY_FLAG = {
  FEATURE_A: LOCAL_DEV_ACCESS.open,
  FEATURE_B: LOCAL_DEV_ACCESS.followsFlag,
} as const satisfies Record<DeploymentFeatureFlag, LocalDevAccess>;`;

const ROUTE = "GET /v1/things";

const mounted = (overrides: Partial<MountedRoute> = {}): MountedRoute => ({
  method: "GET",
  path: "/v1/things",
  gateFlags: ["FEATURE_A"],
  localDevelopment: false,
  capability: "things.list",
  ...overrides,
});

const input = ({
  routes = [mounted()],
  readers = [
    {
      file: "apps/api/src/lib/b.ts",
      source: `export const b = () => isDeploymentFeatureEnabled("FEATURE_B");`,
    },
  ],
  features = new Map([["things.list", "FEATURE_A"]]),
  alwaysOn = new Map(),
}: {
  routes?: MountedRoute[];
  readers?: { file: string; source: string }[];
  features?: Map<string, string | undefined>;
  alwaysOn?: Map<string, string>;
}): ScanInput => ({
  ownerSource: OWNER,
  readerFiles: readers,
  processEnvFiles: [],
  routes,
  catalogFeatures: features,
  alwaysOnRoutePrefixes: alwaysOn,
});

const keys = (scanInput: ScanInput): string[] =>
  scanDeploymentFeatures(scanInput, createParseCache()).findings.map(
    findingKey,
  );

const FLAGGED_KEY = `flagged-capability:things.list@${ROUTE}`;

describe("route gates", () => {
  test("a gate on the capability's flag covers its route", () => {
    expect(keys(input({}))).toEqual([]);
  });

  test("an ungated route serving a flagged capability is reported", () => {
    expect(keys(input({ routes: [mounted({ gateFlags: [] })] }))).toEqual([
      FLAGGED_KEY,
    ]);
  });

  test("a gate on another flag does not cover it", () => {
    expect(
      keys(input({ routes: [mounted({ gateFlags: ["FEATURE_B"] })] })),
    ).toEqual([FLAGGED_KEY]);
  });

  test("every mount of a flagged capability needs the gate", () => {
    expect(
      keys(
        input({
          routes: [
            mounted(),
            mounted({ path: "/v1/other-things", gateFlags: [] }),
          ],
        }),
      ),
    ).toEqual(["flagged-capability:things.list@GET /v1/other-things"]);
  });

  test("a flag read inside the handler is not a gate", () => {
    expect(
      keys(
        input({
          routes: [mounted({ gateFlags: [] })],
          readers: [
            {
              file: "apps/api/src/handlers/things/list.ts",
              source: `export default () => isDeploymentFeatureEnabled("FEATURE_A") && isDeploymentFeatureEnabled("FEATURE_B");`,
            },
          ],
        }),
      ),
    ).toEqual([FLAGGED_KEY]);
  });

  test("a gate on an undeclared flag fails and never counts as a reader of it", () => {
    expect(
      keys(
        input({ routes: [mounted({ gateFlags: ["FEATURE_A", "FEATURE_Z"] })] }),
      ),
    ).toEqual([`undeclared-gate-flag:FEATURE_Z@${ROUTE}`]);
  });

  test("a route outside every class is reported", () => {
    const unflagged = input({
      routes: [mounted({ gateFlags: [], capability: undefined })],
      readers: [
        {
          file: "apps/api/src/lib/a.ts",
          source: `isDeploymentFeatureEnabled("FEATURE_A"); isDeploymentFeatureEnabled("FEATURE_B");`,
        },
      ],
    });
    expect(keys(unflagged)).toEqual([`unclassified-route:${ROUTE}`]);
    expect(
      keys({ ...unflagged, alwaysOnRoutePrefixes: new Map([["/v1", "core"]]) }),
    ).toEqual([]);
    // A prefix covers whole segments only.
    expect(
      keys({
        ...unflagged,
        alwaysOnRoutePrefixes: new Map([
          ["/v1/thing", "core"],
          ["/v1/things", "core"],
        ]),
      }),
    ).toEqual(["stale-always-on:/v1/thing"]);
    expect(
      keys({
        ...unflagged,
        routes: [
          mounted({
            gateFlags: [],
            capability: undefined,
            localDevelopment: true,
          }),
        ],
      }),
    ).toEqual([]);
  });

  test("a capability without a flag is classified by its gate or prefix", () => {
    expect(
      keys(
        input({
          routes: [mounted({ gateFlags: [] })],
          features: new Map([["things.list", undefined]]),
          readers: [
            {
              file: "apps/api/src/lib/a.ts",
              source: `isDeploymentFeatureEnabled("FEATURE_A"); isDeploymentFeatureEnabled("FEATURE_B");`,
            },
          ],
        }),
      ),
    ).toEqual([`unclassified-route:${ROUTE}`]);
  });
});

describe("flags", () => {
  test("a declared flag without a reader is dead", () => {
    expect(keys(input({ readers: [] }))).toEqual(["dead-flag:FEATURE_B"]);
  });

  test("tags, catalog entries, sanctioned env reads and route gates are readers", () => {
    for (const source of [
      `export const tool = { feature: "FEATURE_B" };`,
      `export const feature = { deploymentFeature: "FEATURE_B" };`,
      `import { env } from "@/api/env";\nexport const on = env.FEATURE_B;`,
      `import { env } from "@/api/env";\nconst { FEATURE_B } = env;`,
    ]) {
      expect(
        keys(input({ readers: [{ file: "apps/api/src/lib/b.ts", source }] })),
      ).toEqual([]);
    }
    expect(
      keys(
        input({
          readers: [],
          features: new Map([
            ["things.list", "FEATURE_A"],
            ["other.list", "FEATURE_B"],
          ]),
        }),
      ),
    ).toEqual([]);
    expect(
      keys(
        input({
          readers: [],
          routes: [
            mounted(),
            mounted({
              path: "/v1/gated",
              gateFlags: ["FEATURE_B"],
              capability: undefined,
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("an undeclared read fails in every reader form", () => {
    const found = keys(
      input({
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
    input({ routes: [mounted({ gateFlags: [] })], readers: [] }),
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

  test("findings that are never baselined fail even when listed", () => {
    const undeclared = scanDeploymentFeatures(
      input({
        routes: [mounted({ gateFlags: ["FEATURE_A", "FEATURE_Z"] })],
        alwaysOn: new Map([["/v1/nothing", "self-test"]]),
      }),
      createParseCache(),
    ).findings;
    expect(
      diffBaseline({
        findings: undeclared,
        baseline: [],
        baseBaseline: undefined,
      }).errors,
    ).toEqual([
      "stale-always-on:/v1/nothing",
      `undeclared-gate-flag:FEATURE_Z@${ROUTE}`,
    ]);
    expect(() => buildBaseline(undeclared)).not.toThrow();
    expect(buildBaseline(undeclared)).toEqual([]);
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
    const base = readBaseBaseline("HEAD");
    expect(base === undefined || Array.isArray(base)).toBe(true);
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

// The tree is read once, outside the test timeouts: handler discovery and the
// route table import the API module graph. The self-test cases reparse only
// the files they edit.
const real = await loadRealInput();
const cache = createParseCache();
const scanned = scanDeploymentFeatures(real, cache);

describe("real tree", () => {
  test("every self-test detector fires", () => {
    expect(SELF_TEST_CASES.length).toBeGreaterThan(0);
    expect(runSelfTest(real, cache)).toEqual([]);
  });

  test("the scan matches the committed baseline", async () => {
    const committed: unknown = await Bun.file(
      new URL("../deployment-feature-routes-baseline.json", import.meta.url),
    ).json();
    expect(buildBaseline(scanned.findings)).toEqual(
      Array.isArray(committed) ? committed : [],
    );
  });

  test("list routes and task admission read the same deployment owner", () => {
    // The lists routes read the flag through their mounted gate, which reads
    // the owner per request; task admission calls the owner itself.
    const listRoutes = real.routes.filter((route) =>
      route.path.startsWith("/v1/lists/"),
    );
    expect(listRoutes.length).toBeGreaterThan(0);
    for (const route of listRoutes) {
      expect(route.gateFlags).toContain("FEATURE_LEGAL_LISTS");
    }
    const file = "apps/api/src/lib/tasks/deployment-features.ts";
    const ownerReaders = (source: ScanInput) =>
      scanDeploymentFeatures(source, createParseCache())
        .reads.filter(
          (read) =>
            read.flag === "FEATURE_LEGAL_LISTS" && read.form === "owner-call",
        )
        .map((read) => read.file);
    expect(ownerReaders(real)).toContain(file);
    const divergent = {
      ...real,
      readerFiles: real.readerFiles.map((record) =>
        record.file === file
          ? {
              ...record,
              source: record.source.replaceAll(
                /isDeploymentFeatureEnabled\(\s*"FEATURE_LEGAL_LISTS",?\s*\)/gu,
                "env.FEATURE_LEGAL_LISTS",
              ),
            }
          : record,
      ),
    };
    expect(ownerReaders(divergent)).not.toContain(file);
  });
});
