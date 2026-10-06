import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ciPlaywrightConfigs,
  missingJsonReporters,
} from "../../../scripts/e2e-timing-reporters";
import {
  formatE2eTimings,
  summarizeE2eTimings,
} from "../../../scripts/e2e-timings-summary";

const spec = (title: string, durations: readonly number[]) => ({
  title,
  file: "one.spec.ts",
  line: 2,
  column: 1,
  tests: [
    {
      projectName: "chromium",
      results: durations.map((duration) => ({ duration, status: "passed" })),
    },
  ],
});
const fixture = {
  config: { rootDir: "/fixtures/specs" },
  suites: [
    {
      title: "one.spec.ts",
      specs: [],
      suites: [
        {
          title: "nested",
          specs: [
            spec("slow", [1000, 2000]),
            spec("fast", [500]),
            spec("skipped", []),
          ],
        },
      ],
    },
  ],
};

test("file totals conserve every attempt across nested suites, projects and reports", () => {
  const second = {
    config: fixture.config,
    suites: [
      {
        title: "two",
        specs: [
          {
            ...spec("other project", [4000]),
            file: "two.spec.ts",
            tests: [{ projectName: "webkit", results: [{ duration: 4000 }] }],
          },
        ],
      },
    ],
  };
  const result = summarizeE2eTimings([fixture, second]);
  expect(result.files).toEqual([
    { file: "/fixtures/specs/two.spec.ts", milliseconds: 4000 },
    { file: "/fixtures/specs/one.spec.ts", milliseconds: 3500 },
  ]);
  expect(
    result.tests.map(({ milliseconds, attempts }) => [milliseconds, attempts]),
  ).toEqual([
    [4000, 1],
    [3000, 2],
    [500, 1],
    [0, 0],
  ]);
  expect(result.files.reduce((sum, file) => sum + file.milliseconds, 0)).toBe(
    result.tests.reduce((sum, timing) => sum + timing.milliseconds, 0),
  );
  expect(summarizeE2eTimings([second, fixture])).toEqual(result);
  expect(
    summarizeE2eTimings([fixture, fixture]).files.at(0)?.milliseconds,
  ).toBe(7000);
  expect(formatE2eTimings(result)).toContain(
    "3.000\t/fixtures/specs/one.spec.ts\t[chromium] one.spec.ts › nested › slow\t2 attempts",
  );
  expect(summarizeE2eTimings([{ config: fixture.config, suites: [] }])).toEqual(
    { files: [], tests: [] },
  );
});

test("malformed nested timings fail rather than becoming missing or zero time", () => {
  for (const duration of [-1, Infinity, "1000"]) {
    expect(() =>
      summarizeE2eTimings([
        {
          config: fixture.config,
          suites: [
            {
              title: "one",
              specs: [
                {
                  ...spec("bad", []),
                  tests: [{ projectName: "chromium", results: [{ duration }] }],
                },
              ],
            },
          ],
        },
      ]),
    ).toThrow("Invalid");
  }
  expect(() => summarizeE2eTimings([{}])).toThrow("Invalid");
});

test("workflow enumeration follows package scripts and inherited config reporters; a missing reporter fails", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-reporters-"));
  try {
    const directory = path.join(root, "apps/fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "@stll/fixture",
        scripts: { "test:e2e": "playwright test --config child.ts" },
      }),
    );
    writeFileSync(
      path.join(directory, "base.ts"),
      'export default { reporter: process.env.CI ? [["dot"], ["json", { outputFile: "timings.json" }]] : [["list"]] };',
    );
    writeFileSync(
      path.join(directory, "child.ts"),
      'import config from "./base.ts"; export default { ...config, workers: 1 };',
    );
    writeFileSync(
      path.join(directory, "missing.ts"),
      'export default { reporter: [["dot"]] };',
    );
    const workflow = {
      jobs: {
        fixture: {
          steps: [
            { run: "bun --filter @stll/fixture test:e2e" },
            { run: "\n\n\tcd apps/fixture\nbun test:e2e" },
            {
              run: "playwright test --config missing.ts",
              "working-directory": "apps/fixture",
            },
          ],
        },
      },
    };
    const configs = ciPlaywrightConfigs(root, workflow);
    expect(configs).toEqual([
      "apps/fixture/child.ts",
      "apps/fixture/missing.ts",
    ]);
    expect(await missingJsonReporters(root, configs)).toEqual([
      "apps/fixture/missing.ts: missing JSON reporter in CI",
    ]);
    expect(await missingJsonReporters(root, ["apps/fixture/child.ts"])).toEqual(
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every Playwright configuration selected by CI keeps a JSON reporter", async () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
  );
  const configs = ciPlaywrightConfigs(root, workflow);
  expect(configs.length).toBeGreaterThan(0);
  expect(await missingJsonReporters(root, configs)).toEqual([]);
});
