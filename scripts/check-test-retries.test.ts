import { expect, test } from "bun:test";

import {
  checkTestRetries,
  findTestRetryViolations,
} from "./check-test-retries.ts";

const config = (source: string) =>
  findTestRetryViolations(
    new Map([["apps/example/playwright.config.ts", source]]),
  );

test("requires retries: 0 as the effective top-level Playwright setting", () => {
  expect(
    config(`
      export default defineConfig({
        testDir: "./tests",
        retries: 0,
      });
    `),
  ).toEqual([]);

  expect(
    config("export default defineConfig({ testDir: './tests' });"),
  ).toHaveLength(1);
  expect(config("export default defineConfig({ retries: 2 });")).toHaveLength(
    1,
  );
});

test("follows literal config spreads and rejects a later override", () => {
  expect(
    config(`
      const base = { retries: 2 };
      export default defineConfig({
        ...base,
        retries: 0,
      });
    `),
  ).toEqual([]);

  expect(
    config(`
      const override = { retries: 2 };
      export default defineConfig({
        retries: 0,
        ...override,
      });
    `),
  ).toHaveLength(1);
});

test("rejects retries overrides inside Playwright projects and use options", () => {
  expect(
    config(`
      export default defineConfig({
        retries: 0,
        projects: [
          { name: "chromium", retries: 1 },
          { name: "webkit", use: { retries: getRetryCount() } },
        ],
      });
    `),
  ).toHaveLength(2);
});

test("resolves named projects and checks computed retry properties", () => {
  expect(
    config(`
      const projects = [{ name: "chromium", retries: 2 }];
      export default defineConfig({ retries: 0, projects });
    `),
  ).toHaveLength(1);

  expect(
    config(`export default defineConfig({ retries: 0, ["retries"]: 2 });`),
  ).toHaveLength(1);

  expect(
    config(`
      export default defineConfig({
        retries: 0,
        [getConfigKey()]: "dynamic override",
      });
    `),
  ).toHaveLength(1);
});

test("rejects positive describe configuration retries", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        "apps/example/tests/example.spec.ts",
        `const defaults = { retries: 0 };\ndescribe.configure({\n  ...defaults,\n  retries: 1,\n});`,
      ],
    ]),
  );
  expect(findings.map(({ message }) => message)).toEqual([
    "test.describe.configure has dynamic or nonzero retry settings",
  ]);
});

test("resolves named describe options and rejects dynamic override spreads", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        "apps/example/tests/example.spec.ts",
        `
          const options = { retries: 0 };
          describe.configure(options);
          const dynamic = { retries: getRetryCount() };
          test.describe.configure(dynamic);
          test.describe.configure({ retries: 0, ...unknownOptions });
        `,
      ],
    ]),
  );
  expect(findings).toHaveLength(2);
});

test("finds retry flags in any package command that runs tests", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        "apps/example/package.json",
        JSON.stringify({
          scripts: {
            test: "playwright test --retries=0",
            "test:unit": "bun test \"src\" --retry '3'",
            ci: "bun --filter @stll/api test --rerun-each=$RETRY_COUNT",
          },
        }),
      ],
    ]),
  );
  expect(findings).toHaveLength(3);
  expect(
    findings.every(({ message }) => message.includes("test retry option")),
  ).toBe(true);
});

test("finds retry flags passed through actual TS process invocations", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        "apps/example/scripts/run-tests.ts",
        `
          const args = ["bun", "test", "--retry", "2"] as const;
          Bun.spawn(args);
          spawn("bun", ["test", "--retries", getRetryCount()]);
          Bun.spawn(["curl", "--retry", "2"]);
        `,
      ],
    ]),
  );
  expect(findings).toHaveLength(2);
  expect(
    findings.every(({ message }) => message.includes("process invocation")),
  ).toBe(true);
});

test("finds retry wrappers and retry actions around workflow tests", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        ".github/workflows/test.yml",
        `jobs:\n  check:\n    steps:\n      - name: Retry tests\n        run: |\n          bash scripts/retry.sh bun --filter @stll/web test\n      - uses: nick-fields/retry@v3\n        with:\n          command: bun run test:unit\n`,
      ],
    ]),
  );
  expect(findings.map(({ message }) => message)).toEqual([
    "workflow/action step wraps a test command in scripts/retry.sh",
    "workflow/action retry step wraps a test command",
  ]);
});

test("leaves network retry flags alone when the command is not a test", () => {
  expect(
    findTestRetryViolations(
      new Map([
        [
          ".github/actions/download/action.yml",
          `runs:\n  using: composite\n  steps:\n    - run: curl --retry 5 https://example.test/file`,
        ],
      ]),
    ),
  ).toEqual([]);
});

test("rejects malformed workflow YAML and a missing workflow shape", () => {
  expect(
    findTestRetryViolations(
      new Map([
        [".github/workflows/bad.yml", "jobs: ["],
        [".github/workflows/not-a-workflow.yml", "steps: []"],
      ]),
    ),
  ).toHaveLength(2);
});

test("uses parsed YAML commands and rejects retry flags with any value", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        ".github/workflows/test.yml",
        `jobs:\n  check:\n    steps:\n      - run: |\n          bun test --retries=0\n      - run: |\n          bun test \\\n            --rerun-each=$RETRY_COUNT\n`,
      ],
    ]),
  );
  expect(findings).toHaveLength(2);
});

test("the tracked repository has no automated test retries", () => {
  expect(checkTestRetries()).toEqual([]);
}, 15_000);

test.each(["2", "0", "getRetryCount()"])(
  "rejects shorthand retry settings in projects: %s",
  (initializer) => {
    expect(
      config(`
      const retries = ${initializer};
      export default defineConfig({ retries: 0, projects: [{ retries }] });
    `),
    ).toHaveLength(1);
  },
);

test.each(["2", "0", "getRetryCount()"])(
  "rejects shorthand retry settings in describe options: %s",
  (initializer) => {
    expect(
      findTestRetryViolations(
        new Map([
          [
            "apps/example/tests/example.spec.ts",
            `const retries = ${initializer}; test.describe.configure({ retries });`,
          ],
        ]),
      ),
    ).toHaveLength(1);
  },
);

test("scans shell launchers while allowing install and download retries", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        "scripts/example.sh",
        [
          "#!/usr/bin/env bash",
          "bash scripts/retry.sh bun test",
          "bun test --retries=2",
          "bun test \\\n        --rerun-each=2",
          "bash scripts/retry.sh bun ci --ignore-scripts",
          "bash scripts/retry.sh bun install --frozen-lockfile",
          "bash scripts/retry.sh curl --retry 5 https://example.test/file",
          "# bun test --retries=2",
        ].join("\n"),
      ],
    ]),
  );
  expect(findings.map(({ message }) => message)).toEqual([
    "shell launcher wraps a test command in scripts/retry.sh",
    "shell launcher passes a test retry option",
    "shell launcher passes a test retry option",
  ]);
});
