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
  checkTestRetries,
  findTestRetryViolations,
  playwrightDevices,
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

test("parses JSX in .jsx test files before finding describe retries", () => {
  const findings = findTestRetryViolations(
    new Map([
      [
        "apps/example/tests/example.spec.jsx",
        // A backtick in JSX text opens a template literal under the TS
        // grammar, which would swallow the call that follows.
        "const view = <div>\n  `\n</div>;\ndescribe.configure({ retries: 1 });",
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

test("reads every tracked Playwright config, even one that spawns nothing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-retries-"));
  try {
    const git = (...args: string[]) =>
      expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
    git("init", "-q");
    mkdirSync(path.join(root, "apps/example"), { recursive: true });
    writeFileSync(
      path.join(root, "apps/example/playwright.config.ts"),
      'import { defineConfig } from "@playwright/test";\n\nexport default defineConfig({ retries: 2 });\n',
    );
    writeFileSync(
      path.join(root, "apps/example/helper.ts"),
      "export const retries = 2;\n",
    );
    git("add", ".");
    expect(checkTestRetries(root)).toEqual([
      {
        file: "apps/example/playwright.config.ts",
        message:
          "Playwright config must explicitly set top-level retries: 0 as its effective value",
      },
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

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
          "   # bash scripts/retry.sh bun test",
          "",
          "\t# bun test --rerun-each=2",
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

test.each([
  "projects: [...devices.map(d => ({ retries: 2 }))]",
  "projects: [...[getProject()]]",
  "projects: [...projects]",
  "projects: [{ ...getProject() }]",
  "projects: [{ use: { ...getUse() } }]",
  "use: { ...getUse() }",
  "projects: [{ ...defaults }]",
])("fails closed on unresolved project/use spreads: %s", (settings) => {
  expect(
    config(`export default defineConfig({ retries: 0, ${settings} });`).some(
      ({ message }) =>
        message ===
        "Playwright project/use configuration is not statically inspectable",
    ),
  ).toBe(true);
});

test("resolves literal array/object spreads and inspects their retry policies", () => {
  const source = `
    const use = { viewport: { width: 100, height: 100 } };
    const project = { name: "chromium", retries: 0, use: { ...use } };
    const projects = [project];
    export default defineConfig({ retries: 0, projects: [...projects, ...[{ ...project }]] });
  `;
  expect(config(source)).toEqual([]);
  expect(
    config(
      source.replace(
        'name: "chromium", retries: 0',
        'name: "chromium", retries: 2',
      ),
    ).some(
      ({ message }) =>
        message ===
        "Playwright project/use retries must be statically set to 0",
    ),
  ).toBe(true);
});

const NOT_INSPECTABLE =
  "Playwright project/use configuration is not statically inspectable";

test("reads device presets from the @playwright/test devices export", () => {
  const withPreset = (name: string) => `
    import { defineConfig, devices } from "@playwright/test";
    export default defineConfig({
      retries: 0,
      projects: [{ name: "browser", use: { ...devices[${JSON.stringify(name)}] } }],
    });
  `;
  expect(config(withPreset("Desktop Chrome"))).toEqual([]);
  expect(config(withPreset("No Such Device"))).toEqual([
    { file: "apps/example/playwright.config.ts", message: NOT_INSPECTABLE },
  ]);
});

test("every device preset a tracked config names exists in @playwright/test", () => {
  const root = path.resolve(import.meta.dir, "..");
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
    .stdout.toString()
    .split("\0")
    .filter(
      (file) =>
        /(?:^|\/)playwright[^/]*\.config\.[cm]?[jt]s$/u.test(file) ||
        file.startsWith("packages/playwright-tools/src/"),
    );
  const presets = new Map<string, string>();
  for (const file of tracked) {
    const source = readFileSync(path.join(root, file), "utf-8");
    for (const match of source.matchAll(/devices\[\s*(["'])(.+?)\1\s*\]/gu)) {
      presets.set(match[2] ?? "", file);
    }
  }
  expect(presets.size).toBeGreaterThan(0);
  for (const [preset, file] of presets) {
    const known = playwrightDevices({ file, root })?.[preset] !== undefined;
    expect({ file, preset, known }).toEqual({ file, preset, known: true });
  }
});

test("reads a config built by a repository helper from what the helper returns", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-retries-helper-"));
  try {
    mkdirSync(path.join(root, "apps/example"), { recursive: true });
    const helper = (retries: number) =>
      writeFileSync(
        path.join(root, "apps/example/shared-config.ts"),
        `import { defineConfig } from "@playwright/test";
        export const sharedConfig = ({ app }: { app: string }) =>
          defineConfig({
            retries: ${String(retries)},
            projects: [
              ...(app === "web"
                ? [{ name: "web", use: { baseURL: "http://localhost:3000" } }]
                : [{ name: "landing", retries: 0 }]),
            ],
          });
        export function blockConfig() {
          const testDir = ".";
          return defineConfig({ testDir, retries: ${String(retries)} });
        }
        export const notAConfig = 1;
        `,
      );
    const scan = (source: string) =>
      findTestRetryViolations(
        new Map([["apps/example/playwright.config.ts", source]]),
        root,
      );
    const arrow = `import { sharedConfig } from "./shared-config";\nexport default sharedConfig({ app: "web" });`;
    const block = `import { blockConfig as build } from "./shared-config.ts";\nexport default build();`;
    helper(0);
    expect(scan(arrow)).toEqual([]);
    expect(scan(block)).toEqual([]);
    helper(2);
    const effective = {
      file: "apps/example/playwright.config.ts",
      message:
        "Playwright config must explicitly set top-level retries: 0 as its effective value",
    };
    expect(scan(arrow)).toEqual([effective]);
    expect(scan(block)).toEqual([effective]);
    // A helper the reader cannot follow fails closed, whatever its arguments say.
    const unread = {
      file: "apps/example/playwright.config.ts",
      message: "Playwright config must explicitly set top-level retries: 0",
    };
    expect(
      scan(
        `import { notAConfig } from "./shared-config";\nexport default notAConfig({ retries: 0 });`,
      ),
    ).toEqual([unread]);
    expect(
      scan(
        `import { gone } from "./gone";\nexport default gone({ retries: 0 });`,
      ),
    ).toEqual([unread]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
