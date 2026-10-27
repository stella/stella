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

import { isDevicePresetName } from "../packages/playwright-tools/src/devices";
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
    config(`import { defineConfig } from "@playwright/test";

      export default defineConfig({
        testDir: "./tests",
        retries: 0,
      });
    `),
  ).toEqual([]);

  expect(
    config(
      "import { defineConfig } from \"@playwright/test\";\nexport default defineConfig({ testDir: './tests' });",
    ),
  ).toHaveLength(1);
  expect(
    config(
      'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ retries: 2 });',
    ),
  ).toHaveLength(1);
});

test("all root factory arguments contribute to the effective retry policy", () => {
  expect(
    config(`import { defineConfig } from "@playwright/test";

      const overrides = { retries: 2 };
      export default defineConfig({ retries: 0 }, overrides);
    `),
  ).toEqual([
    {
      file: "apps/example/playwright.config.ts",
      message:
        "Playwright config must explicitly set top-level retries: 0 as its effective value",
    },
  ]);
  expect(
    config(`import { defineConfig } from "@playwright/test";

      const overrides = { retries: 0 };
      export default defineConfig({ retries: 2 }, overrides);
    `),
  ).toEqual([]);
  expect(
    config(`import { defineConfig } from "@playwright/test";

      const projects = () => ({ projects: [{ name: "browser", retries: 2 }] });
      export default defineConfig(projects(), { retries: 0 });
    `),
  ).toEqual([
    {
      file: "apps/example/playwright.config.ts",
      message: "Playwright config must explicitly set top-level retries: 0",
    },
  ]);
});

test("imported configuration arguments are verified before composition", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-retries-import-"));
  const file = "apps/example/playwright.config.ts";
  const source = `import { defineConfig } from "@playwright/test";
    import base from "./base-config";
    export default defineConfig(base, { retries: 0 });`;
  try {
    mkdirSync(path.join(root, "apps/example"), { recursive: true });
    writeFileSync(path.join(root, file), source);
    const base = (configuration: string) =>
      writeFileSync(
        path.join(root, "apps/example/base-config.ts"),
        configuration,
      );
    const scan = () => findTestRetryViolations(new Map([[file, source]]), root);
    base(
      'export default { retries: 0, projects: [{ name: "browser", retries: 0 }] };',
    );
    expect(scan()).toEqual([]);
    base("export default { retries: 2 };");
    expect(scan()).toEqual([UNREADABLE_CONFIG]);
    base(
      'export default { retries: 0, projects: [{ name: "browser", retries: 2 }] };',
    );
    expect(scan()).toEqual([UNREADABLE_CONFIG]);
    base(
      'import { defineConfig } from "@playwright/test"; import original from "./playwright.config"; export default defineConfig(original, { retries: 0 });',
    );
    expect(scan()).toEqual([UNREADABLE_CONFIG]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("device presets remain read-only configuration inputs", () => {
  expect(
    config(`import { defineConfig, devices } from "@playwright/test";
      Object.assign(devices["Desktop Chrome"], { retries: 2 });
      export default defineConfig({
        retries: 0,
        projects: [{ ...devices["Desktop Chrome"], name: "browser" }],
      });`),
  ).toContainEqual({
    file: "apps/example/playwright.config.ts",
    message:
      "Playwright project/use configuration is not statically inspectable",
  });
});

test("local configuration arguments require static construction", () => {
  expect(
    config(`import { defineConfig } from "@playwright/test";
      const settings = { retries: 0 };
      settings.retries = 2;
      export default defineConfig(settings);`),
  ).toEqual([UNREADABLE_CONFIG]);
});

test("imported configuration composition requires static module construction", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-retries-construction-"));
  const file = "apps/example/playwright.config.ts";
  const caller = `import { defineConfig } from "@playwright/test";
    import base from "./base-config";
    export default defineConfig(base, { retries: 0 });`;
  const declaration = `import { defineConfig } from "@playwright/test";
    const projects = [{ name: "browser", retries: 0 }];`;
  const exported = "export default defineConfig({ retries: 0, projects });";
  try {
    mkdirSync(path.join(root, "apps/example"), { recursive: true });
    const baseFile = path.join(root, "apps/example/base-config.ts");
    writeFileSync(baseFile, `${declaration} ${exported}`);
    const scan = (source = caller) =>
      findTestRetryViolations(new Map([[file, source]]), root);
    expect(scan()).toEqual([]);

    for (const construction of [
      "projects[0].retries = 2;",
      "projects[0].retries++;",
      "Object.assign(projects[0], { retries: 2 });",
      "const changed = projects.push({ name: 'other', retries: 2 });",
    ]) {
      writeFileSync(baseFile, `${declaration} ${construction} ${exported}`);
      expect(scan()).toEqual([UNREADABLE_CONFIG]);
    }

    writeFileSync(baseFile, `${declaration} ${exported}`);
    expect(
      scan(
        caller.replace(
          "export default",
          "base.projects[0].retries = 2; export default",
        ),
      ),
    ).toEqual([UNREADABLE_CONFIG]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("configuration composition excludes other modules that reach its bases", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-retries-import-graph-"));
  const file = "apps/example/playwright.config.ts";
  const caller = `import { defineConfig } from "@playwright/test";
    import base from "./base-config";
    export default defineConfig(base, { retries: 0 });`;
  const base =
    'export default { retries: 0, projects: [{ name: "browser", retries: 0 }] };';
  try {
    mkdirSync(path.join(root, "apps/example"), { recursive: true });
    const baseFile = path.join(root, "apps/example/base-config.ts");
    writeFileSync(baseFile, base);
    writeFileSync(
      path.join(root, "apps/example/extra.ts"),
      `
      import base from "./base-config";
      base.projects[0].retries = 2;
      export const label = "browser";
    `,
    );
    writeFileSync(
      path.join(root, "apps/example/forward.ts"),
      'export * from "./extra";',
    );
    const scan = (source: string) =>
      findTestRetryViolations(new Map([[file, source]]), root);
    expect(scan(caller)).toEqual([]);
    for (const imported of [
      'import "./extra";',
      'import { label } from "./extra";',
      'import "./forward";',
    ]) {
      expect(scan(`${imported} ${caller}`), imported).toEqual([
        UNREADABLE_CONFIG,
      ]);
    }
    writeFileSync(baseFile, `import "./extra"; ${base}`);
    expect(scan(caller)).toEqual([UNREADABLE_CONFIG]);
    writeFileSync(baseFile, base);
    expect(scan(`import type { Unused } from "./absent"; ${caller}`)).toEqual(
      [],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("follows literal config spreads and rejects a later override", () => {
  expect(
    config(`import { defineConfig } from "@playwright/test";

      const base = { retries: 2 };
      export default defineConfig({
        ...base,
        retries: 0,
      });
    `),
  ).toEqual([]);

  expect(
    config(`import { defineConfig } from "@playwright/test";

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
    config(`import { defineConfig } from "@playwright/test";

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
    config(`import { defineConfig } from "@playwright/test";

      const projects = [{ name: "chromium", retries: 2 }];
      export default defineConfig({ retries: 0, projects });
    `),
  ).toHaveLength(1);

  expect(
    config(`import { defineConfig } from "@playwright/test";
export default defineConfig({ retries: 0, ["retries"]: 2 });`),
  ).toHaveLength(1);

  expect(
    config(`import { defineConfig } from "@playwright/test";

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
      config(`import { defineConfig } from "@playwright/test";

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
    config(`import { defineConfig } from "@playwright/test";
export default defineConfig({ retries: 0, ${settings} });`).some(
      ({ message }) =>
        message ===
        "Playwright project/use configuration is not statically inspectable",
    ),
  ).toBe(true);
});

test("resolves literal array/object spreads and inspects their retry policies", () => {
  const source = `import { defineConfig } from "@playwright/test";
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

const inspectHelper = (source: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "test-retries-helper-"));
  try {
    mkdirSync(path.join(root, "apps/example"), { recursive: true });
    writeFileSync(path.join(root, "apps/example/shared-config.ts"), source);
    return findTestRetryViolations(
      new Map([
        [
          "apps/example/playwright.config.ts",
          'import { sharedConfig } from "./shared-config"; export default sharedConfig();',
        ],
      ]),
      root,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const UNREADABLE_CONFIG = {
  file: "apps/example/playwright.config.ts",
  message: "Playwright config must explicitly set top-level retries: 0",
};

test.each([
  ["plain object", "export default { retries: 0 };"],
  [
    "named alias",
    'import { defineConfig as build } from "@playwright/test"; export default build({ retries: 0 });',
  ],
  [
    "namespace",
    'import * as playwright from "@playwright/test"; export default playwright.defineConfig({ retries: 0 });',
  ],
  [
    "computed namespace",
    'import * as playwright from "@playwright/test"; export default playwright["defineConfig"]({ retries: 0 });',
  ],
  [
    "ordered arguments",
    'import { defineConfig } from "@playwright/test"; export default defineConfig({ retries: 2 }, { retries: 0 });',
  ],
  [
    "named argument",
    'import { defineConfig } from "@playwright/test"; const overrides = { retries: 0 }; export default defineConfig({ retries: 2 }, overrides);',
  ],
])(
  "static configuration factories retain supported forms: %s",
  (_name, source) => {
    expect(
      findTestRetryViolations(
        new Map([["apps/example/playwright.config.ts", source]]),
      ),
    ).toEqual([]);
  },
);

test.each([
  'export default defineConfig({ retries: 0, get projects() { return [{ name: "browser", retries: 2 }]; } });',
  'const base = { get projects() { return [{ name: "browser", retries: 2 }]; } }; export default defineConfig({ ...base, retries: 0 });',
])("configuration policy objects do not execute accessors: %s", (source) => {
  expect(
    findTestRetryViolations(
      new Map([
        [
          "apps/example/playwright.config.ts",
          `import { defineConfig } from "@playwright/test"; ${source}`,
        ],
      ]),
    ),
  ).toContainEqual({
    file: "apps/example/playwright.config.ts",
    message: NOT_INSPECTABLE,
  });
});

test.each([
  `const settings = { retries: 0 }; const trigger = { get value() { settings.retries = 2; return 0; } };
   function sharedConfig() { return defineConfig({ retries: 0, ignored: trigger.value, ...settings }); }
   export default sharedConfig();`,
  `const settings = { retries: 0 }; function sharedConfig() { return defineConfig(settings); }
   export default sharedConfig(settings.retries = 2);`,
])(
  "function construction effects cannot supply configuration data: %s",
  (source) => {
    expect(
      findTestRetryViolations(
        new Map([
          [
            "apps/example/playwright.config.ts",
            `import { defineConfig } from "@playwright/test"; ${source}`,
          ],
        ]),
      ),
    ).toEqual([UNREADABLE_CONFIG]);
  },
);

test.each([
  "if (alternate) { return defineConfig({ retries: 2 }); }",
  'switch (mode) { case "alternate": return defineConfig({ retries: 2 }); }',
  "for (const mode of modes) { return defineConfig({ retries: 2 }); }",
  "try { if (alternate) { return defineConfig({ retries: 2 }); } } finally {}",
])("config helpers must have one return path: %s", (branch) => {
  expect(
    inspectHelper(`import { defineConfig } from "@playwright/test";
      export function sharedConfig() {
        ${branch}
        return defineConfig({ retries: 0 });
      }`),
  ).toEqual([UNREADABLE_CONFIG]);
});

const RETRY_WRAPPER =
  "const enableRetries = config => ({ ...config, retries: 2 });";

test.each([
  ["argument parameter", "overrides = { retries: 2 }", "", "overrides"],
  [
    "local argument",
    "",
    "const overrides = { retries: 2 };",
    "{ retries: 0 }, overrides",
  ],
  [
    "destructured argument",
    "{ settings: overrides } = { settings: { retries: 2 } }",
    "",
    "overrides",
  ],
  [
    "local spread",
    "",
    "const overrides = { retries: 2 };",
    "{ retries: 0, ...overrides }",
  ],
  [
    "project parameter",
    'projects = [{ name: "browser", retries: 2 }]',
    "",
    "{ retries: 0, projects }",
  ],
  ["local use", "", "const use = { retries: 2 };", "{ retries: 0, use }"],
  [
    "device parameter",
    'devices = { "Desktop Chrome": { retries: 2 } }',
    "",
    '{ retries: 0, projects: [{ use: { ...devices["Desktop Chrome"] } }] }',
  ],
])(
  "helper-local bindings never resolve to module values: %s",
  (_name, parameters, declarations, argumentsSource) => {
    expect(
      config(`
        import { defineConfig } from "@playwright/test"; import { devices } from "@stll/playwright-tools/devices";
        const overrides = { retries: 0 };
        const projects = [];
        const use = {};
        function sharedConfig(${parameters}) {
          ${declarations}
          return defineConfig(${argumentsSource});
        }
        export default sharedConfig();
      `),
    ).toEqual([UNREADABLE_CONFIG]);
  },
);

test("function roots fail closed even with unshadowed module values", () => {
  expect(
    config(`
      import { defineConfig } from "@playwright/test";
      const overrides = { retries: 0 };
      function sharedConfig({ overrides: unused } = { overrides: { retries: 2 } }) {
        function nested() { const overrides = { retries: 2 }; return overrides; }
        return defineConfig(overrides);
      }
      export default sharedConfig();
    `),
  ).toEqual([UNREADABLE_CONFIG]);
});

test.each([
  ["assignment", "", "settings.retries = 2;"],
  ["update", "", "settings.retries++;"],
  ["object mutation", "", "Object.assign(settings, { retries: 2 });"],
  ["opaque call", "", "enableRetries(settings);"],
  ["initializer call", "", "const ignored = enableRetries(settings);"],
  ["parameter call", "ignored = enableRetries(settings)", ""],
  ["inline function mutation", "", "(() => { settings.retries = 2; })();"],
])(
  "helper effects cannot change an inspected policy: %s",
  (_name, parameters, body) => {
    expect(
      config(`
      import { defineConfig } from "@playwright/test";
      const settings = { retries: 0 };
      const enableRetries = value => { value.retries = 2; };
      function sharedConfig(${parameters}) {
        ${body}
        return defineConfig(settings);
      }
      export default sharedConfig();
    `),
    ).toEqual([UNREADABLE_CONFIG]);
  },
);

test("function roots fail closed even with unused nested functions", () => {
  expect(
    config(`
      import { defineConfig } from "@playwright/test";
      const settings = { retries: 0 };
      function sharedConfig() {
        function unused() { settings.retries = 2; }
        return defineConfig(settings);
      }
      export default sharedConfig();
    `),
  ).toEqual([UNREADABLE_CONFIG]);
});

test.each([
  [
    "transforming wrapper",
    `${RETRY_WRAPPER}
     export function sharedConfig() { return enableRetries({ retries: 0 }); }`,
  ],
  [
    "shadowed named parameter",
    `import { defineConfig } from "@playwright/test";
     ${RETRY_WRAPPER}
     export function sharedConfig(defineConfig = enableRetries) {
       return defineConfig({ retries: 0 });
     }`,
  ],
  [
    "shadowed local binding",
    `import { defineConfig } from "@playwright/test";
     ${RETRY_WRAPPER}
     export function sharedConfig() {
       const defineConfig = enableRetries;
       return defineConfig({ retries: 0 });
     }`,
  ],
  [
    "shadowed namespace parameter",
    `import * as playwright from "@playwright/test";
     ${RETRY_WRAPPER}
     export function sharedConfig(playwright = { defineConfig: enableRetries }) {
       return playwright.defineConfig({ retries: 0 });
     }`,
  ],
  [
    "later local argument",
    `import { defineConfig } from "@playwright/test";
     export function sharedConfig() {
       const overrides = { retries: 2 };
       return defineConfig({ retries: 0 }, overrides);
     }`,
  ],
  [
    "unreadable earlier argument",
    `import { defineConfig } from "@playwright/test";
     const projects = () => ({ projects: [{ name: "browser", retries: 2 }] });
     export function sharedConfig() {
       return defineConfig(projects(), { retries: 0 });
     }`,
  ],
])("config helper factories must be verified: %s", (_name, source) => {
  expect(inspectHelper(source)).toEqual([UNREADABLE_CONFIG]);
});

test("resolved values do not make a function configuration root readable", () => {
  expect(
    inspectHelper(`import { defineConfig } from "@playwright/test";
      const overrides = { retries: 2 };
      export function sharedConfig() {
        return defineConfig({ retries: 0 }, overrides);
      }`),
  ).toEqual([UNREADABLE_CONFIG]);
});

test.each([
  ["plain object", "export function sharedConfig() { return { retries: 0 }; }"],
  [
    "named alias",
    `import { defineConfig as build } from "@playwright/test";
     export function sharedConfig() { return build({ retries: 0 }); }`,
  ],
  [
    "namespace",
    `import * as playwright from "@playwright/test";
     export function sharedConfig() { return playwright.defineConfig({ retries: 0 }); }`,
  ],
  [
    "computed namespace member",
    `import * as playwright from "@playwright/test";
     export function sharedConfig() { return playwright["defineConfig"]({ retries: 0 }); }`,
  ],
  [
    "ordered literal arguments",
    `import { defineConfig } from "@playwright/test";
     export function sharedConfig() {
       return defineConfig({ retries: 2 }, { retries: 0 });
     }`,
  ],
  [
    "later named zero argument",
    `import { defineConfig } from "@playwright/test";
     const overrides = { retries: 0 };
     export function sharedConfig() {
       return defineConfig({ retries: 2 }, overrides);
     }`,
  ],
])(
  "function configuration roots fail closed for every factory form: %s",
  (_name, source) => {
    expect(inspectHelper(source)).toEqual([UNREADABLE_CONFIG]);
  },
);

test("reads device presets from the immutable shared owner", () => {
  const withPreset = (name: string) => `
    import { defineConfig } from "@playwright/test"; import { devices } from "@stll/playwright-tools/devices";
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

test("every device preset a tracked config names exists in the shared owner", () => {
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
    const known = isDevicePresetName(preset);
    expect({ file, preset, known }).toEqual({ file, preset, known: true });
  }
});

test("repository function configuration roots fail closed", () => {
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
          const testDir = (() => { return "."; })();
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
    expect(scan(arrow)).toEqual([UNREADABLE_CONFIG]);
    expect(scan(block)).toEqual([UNREADABLE_CONFIG]);
    helper(2);
    expect(scan(arrow)).toEqual([UNREADABLE_CONFIG]);
    expect(scan(block)).toEqual([UNREADABLE_CONFIG]);
    // Supplying a literal policy does not make an arbitrary factory readable.
    expect(
      scan(
        `import { notAConfig } from "./shared-config";\nexport default notAConfig({ retries: 0 });`,
      ),
    ).toEqual([UNREADABLE_CONFIG]);
    expect(
      scan(
        `import { gone } from "./gone";\nexport default gone({ retries: 0 });`,
      ),
    ).toEqual([UNREADABLE_CONFIG]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
