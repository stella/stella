import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { readDockedChatHosts } from "../apps/web/e2e/helpers/docked-chat-hosts";
import { E2E_SHARD_COUNT } from "./e2e-spec-shards-core";

const root = path.resolve(import.meta.dirname, "..");
type ListedSuite = {
  title: string;
  file: string;
  suites: ListedSuite[];
  specs: { title: string }[];
};
type ListedSuiteInput = Omit<ListedSuite, "suites" | "specs"> & {
  suites?: ListedSuiteInput[] | undefined;
  specs?: ListedSuite["specs"] | undefined;
};
const suiteSchema = v.object({
  title: v.string(),
  file: v.string(),
  suites: v.optional(
    v.array(
      v.lazy((): v.GenericSchema<ListedSuiteInput, ListedSuite> => suiteSchema),
    ),
    [],
  ),
  specs: v.optional(v.array(v.object({ title: v.string() })), []),
});
const reportSchema = v.object({
  suites: v.array(suiteSchema),
  errors: v.array(v.unknown()),
});

const listGeometry = (args: string[]) => {
  const reportFileEnv = new Set([
    "PLAYWRIGHT_JSON_OUTPUT_FILE",
    "PLAYWRIGHT_JSON_OUTPUT_NAME",
    "PLAYWRIGHT_JSON_OUTPUT_DIR",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !reportFileEnv.has(name)),
  );
  const result = Bun.spawnSync(
    [
      "node",
      path.join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      "--config=apps/web/e2e/playwright.config.ts",
      "--list",
      "--reporter=json",
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...env,
        CI: "true",
        E2E_EXECUTION_PROFILE: "ci-production-parallel",
      },
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const json: unknown = JSON.parse(result.stdout.toString());
  const report = v.parse(reportSchema, json);
  expect(report.errors).toEqual([]);
  const cases: string[] = [];
  const collect = (suites: ListedSuite[], ancestors: string[]) => {
    for (const suite of suites) {
      const titles = [...ancestors, suite.title];
      if (suite.file.endsWith("docked-chat-geometry.spec.ts")) {
        cases.push(
          ...suite.specs.map(({ title }) => [...titles, title].join(" > ")),
        );
      }
      collect(suite.suites, titles);
    }
  };
  collect(report.suites, []);
  return cases;
};

const productionShardRun = () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        "e2e-production-shard": v.object({
          steps: v.array(
            v.object({ name: v.string(), run: v.optional(v.string()) }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  const run = workflow.jobs["e2e-production-shard"].steps.find(
    ({ name }) => name === "Run Playwright shard",
  )?.run;
  if (run === undefined) {
    return panic("Production shard step is missing its run command");
  }
  return run;
};

// Measured p95 is 36.8 s; this test must enumerate the production Playwright suite.
test("production shards split every geometry viewport evenly without losing hosts", () => {
  const run = productionShardRun();
  const generalProjects =
    /args=\(([^\n]+)\)/u
      .exec(run)?.[1]
      ?.split(" ")
      .filter((arg) => arg.startsWith("--project=")) ?? [];
  expect(generalProjects.length).toBeGreaterThan(0);
  // Exercise the workflow's project selection rather than a hand-written mirror.
  expect(listGeometry(generalProjects)).toEqual([]);
  expect(run).toContain(
    `--project=docked-chat-geometry --shard=\${{ matrix.shard }}/\${{ steps.e2e-shards.outputs.count }}`,
  );
  const project = ["--project=docked-chat-geometry"];
  const allCases = listGeometry(project);
  const shards = Array.from({ length: E2E_SHARD_COUNT }, (_, index) =>
    listGeometry([...project, `--shard=${index + 1}/${E2E_SHARD_COUNT}`]),
  );
  const combined = shards.flat();
  expect(combined.toSorted()).toEqual(allCases.toSorted());
  expect(new Set(combined).size).toBe(combined.length);
  const lawCounts = shards.map(
    (cases) => cases.filter((name) => name.includes(" > /law")).length,
  );
  expect(Math.max(...lawCounts) - Math.min(...lawCounts)).toBeLessThanOrEqual(
    2,
  );
  const { hosts } = readDockedChatHosts();
  expect(allCases).toHaveLength(hosts.length * 2);
  for (const host of hosts) {
    expect(
      allCases.filter((name) =>
        name.endsWith(
          ` > ${host.template} keeps the thread inside its composer column`,
        ),
      ),
    ).toHaveLength(2);
  }
  const viewports = new Set(
    allCases.map((name) => /docked chat geometry (\d+x\d+)/u.exec(name)?.[1]),
  );
  expect(viewports.size).toBe(2);
  for (const viewport of viewports) {
    if (viewport === undefined) {
      panic("Geometry case is missing its viewport");
    }
    const counts = shards.map(
      (cases) =>
        cases.filter((name) =>
          name.includes(`docked chat geometry ${viewport} >`),
        ).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  }
}, 75_000);

test.each([
  { generalStatus: 0, geometryStatus: 0, expectedStatus: 0 },
  { generalStatus: 1, geometryStatus: 0, expectedStatus: 1 },
  { generalStatus: 0, geometryStatus: 2, expectedStatus: 2 },
  { generalStatus: 1, geometryStatus: 2, expectedStatus: 2 },
])(
  "geometry runs and retains reports with phase statuses $generalStatus/$geometryStatus",
  ({ generalStatus, geometryStatus, expectedStatus }) => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "geometry-shard-phases-"),
    );
    try {
      symlinkSync(
        path.join(root, "scripts"),
        path.join(workspace, "scripts"),
        "dir",
      );
      const runner = path.join(
        workspace,
        ".github/actions/setup-playwright/run-in-image.sh",
      );
      mkdirSync(path.dirname(runner), { recursive: true });
      writeFileSync(
        runner,
        `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *--project=docked-chat-geometry*)
    echo geometry >> phases.log
    mkdir -p apps/web/e2e/test-results/geometry/blob-report
    echo geometry > apps/web/e2e/test-results/geometry/blob-report/report-geometry.zip
    exit "$GEOMETRY_STATUS"
    ;;
  *)
    echo general >> phases.log
    mkdir -p apps/web/e2e/test-results/blob-report
    echo general > apps/web/e2e/test-results/blob-report/report-general.zip
    exit "$GENERAL_STATUS"
    ;;
esac
`,
      );
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          productionShardRun()
            .replaceAll(`\${{ matrix.shard }}`, "1")
            .replaceAll(`\${{ steps.e2e-shards.outputs.count }}`, () =>
              String(E2E_SHARD_COUNT),
            ),
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            E2E_MODE: "full",
            GENERAL_STATUS: String(generalStatus),
            GEOMETRY_STATUS: String(geometryStatus),
          },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(expectedStatus);
      expect(readFileSync(path.join(workspace, "phases.log"), "utf-8")).toBe(
        "general\ngeometry\n",
      );
      for (const phase of ["general", "geometry"]) {
        expect(
          readFileSync(
            path.join(
              workspace,
              `apps/web/e2e/test-results/blob-report/report-${phase}.zip`,
            ),
            "utf-8",
          ),
        ).toBe(`${phase}\n`);
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test("geometry defaults belong to the exported fixture in every importing spec", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "geometry-defaults-"));
  try {
    symlinkSync(
      path.join(root, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    const helper = path.join(root, "apps/web/e2e/helpers/stable-geometry.ts");
    const spec = `
import { expect, test } from ${JSON.stringify(helper)};
test("defaults", async ({ viewport, deviceScaleFactor, reducedMotion }) => {
  expect(viewport).toEqual({ width: 1440, height: 900 });
  expect(deviceScaleFactor).toBe(1);
  expect(reducedMotion).toBe("reduce");
});
`;
    writeFileSync(path.join(directory, "first.spec.ts"), spec);
    writeFileSync(
      path.join(directory, "second.spec.ts"),
      `${spec}
test.describe("explicit suite overrides", () => {
  test.use({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2, reducedMotion: "no-preference" });
  test("overrides", async ({ viewport, deviceScaleFactor, reducedMotion }) => {
    expect(viewport).toEqual({ width: 800, height: 600 });
    expect(deviceScaleFactor).toBe(2);
    expect(reducedMotion).toBe("no-preference");
  });
});
`,
    );
    const config = path.join(directory, "playwright.config.ts");
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        testDir: directory,
        workers: 1,
        retries: 0,
        use: {
          viewport: { width: 640, height: 480 },
          deviceScaleFactor: 3,
          reducedMotion: "no-preference",
        },
      })};`,
    );
    // These cases request only option fixtures: no browser or app is needed.
    const result = Bun.spawnSync(
      [
        "node",
        path.join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        `--config=${config}`,
        "--reporter=line",
      ],
      { cwd: directory, env: { ...process.env, CI: "true" } },
    );
    expect(
      result.exitCode,
      result.stdout.toString() + result.stderr.toString(),
    ).toBe(0);
    expect(result.stdout.toString()).toContain("3 passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
