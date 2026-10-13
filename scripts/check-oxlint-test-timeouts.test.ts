import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "../packages/portable-path/src/index";
import { repositoryCustomLintRunnerViolations } from "./check-custom-lint-test-runners";
import { customLintTestTimeoutViolations as checkTimeouts } from "./check-oxlint-test-timeouts.ts";

const customLintTestTimeoutViolations = (
  options: Parameters<typeof checkTimeouts>[0] = {},
) => checkTimeouts({ now: new Date("2026-10-21T00:00:00.000Z"), ...options });

const IMPORTS =
  'import { test, it, describe, setDefaultTimeout } from "bun:test";\n';
const CLEAN = `${IMPORTS}test("case", () => {});`;

for (const api of ["test", "it", "describe"]) {
  for (const alias of [
    `const check = ${api};`,
    `const { check } = { check: ${api} };`,
    `const check = ${api}.only;`,
    `const check = ${api}[key];`,
    `let check; check = ${api}.skip;`,
    `const check = (${api});`,
    `const check = ${api}.each([1]);`,
    `const check = ${api}.each\`value\n\${1}\`;`,
    `const check = (${api}.each)([1]);`,
    `const check = ${api}.bind(undefined);`,
    `${api}.bind(undefined, "case", () => {}, 60_000)();`,
    `${api}.call(undefined, "case", () => {}, 60_000);`,
    `${api}.apply(undefined, ["case", () => {}, 60_000]);`,
    `${api} = replacement;`,
    `consume(${api});`,
  ]) {
    test(`non-call ${api} references require direct calls: ${alias}`, () => {
      withFixture((directory, file) => {
        writeFileSync(file, `${IMPORTS}${alias}`);
        expect(customLintTestTimeoutViolations({ directory })).toEqual([
          "fixture.test.ts: call test APIs directly; exceptions require an allow-list reason",
        ]);
        writeFileSync(file, CLEAN);
        expect(customLintTestTimeoutViolations({ directory })).toEqual([]);
      });
    });
  }
}

test("direct test calls retain their modifiers and imported names", () => {
  withFixture((directory, file) => {
    writeFileSync(
      file,
      `${IMPORTS}
import { test as check } from "bun:test";
import * as suite from "bun:test";
test.only("case", () => {});
it.skip("case", () => {});
describe.each([1])("case", () => {});
(test.each)([1])("case", () => {});
test.each\`value\n\${1}\`("case", () => {});
check.only("case", () => {}, { retry: 2 });
suite.it.skip("case", { retry: 2 }, () => {});
suite.expect(true).toBe(true);
const record = { test: "case", it: "case", describe: "case" };
`,
    );
    expect(customLintTestTimeoutViolations({ directory })).toEqual([]);
  });
});

for (const alias of [
  "const { test: check } = suite;",
  "let check; ({ it: check } = suite);",
  "const check = suite.describe.only;",
  'const check = suite["test"].skip;',
  "const renamed = suite;",
  "const check = suite[key];",
  "suite.test = replacement;",
]) {
  test(`namespace test API references require direct calls: ${alias}`, () => {
    withFixture((directory, file) => {
      writeFileSync(file, `import * as suite from "bun:test"; ${alias}`);
      expect(customLintTestTimeoutViolations({ directory })).toEqual([
        "fixture.test.ts: call test APIs directly; exceptions require an allow-list reason",
      ]);
    });
  });
}

const withFixture = (run: (directory: string, file: string) => void) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lint-timeout-guard-"));
  const file = path.join(directory, "fixture.test.ts");
  try {
    writeFileSync(file, CLEAN);
    run(directory, file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const mutations = [
  ["default timeout", "setDefaultTimeout(60_000);"],
  ["single-line numeric third argument", 'test("case", () => {}, 60_000);'],
  [
    "named third argument",
    'const BUDGET = 60_000; test("case", () => {}, BUDGET);',
  ],
  ["timeout options", 'test("case", () => {}, { timeout: 60_000 });'],
] as const;

for (const [name, mutation] of mutations) {
  test(`the guard rejects a planted ${name} and passes after restoration`, () => {
    withFixture((directory, file) => {
      expect(customLintTestTimeoutViolations({ directory })).toEqual([]);
      writeFileSync(file, `${IMPORTS}${mutation}`);
      expect(customLintTestTimeoutViolations({ directory })).toEqual([
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ]);
      writeFileSync(file, CLEAN);
      expect(customLintTestTimeoutViolations({ directory })).toEqual([]);
    });
  });
}

for (const api of ["test", "it", "describe"]) {
  for (const variant of [
    "",
    ".only",
    ".skip",
    ".each([1, 2, 3])",
    ".only.each([1])",
    `.each\`value\n\${1}\``,
  ]) {
    for (const timeout of [
      "60_000",
      "BUDGET",
      "BUDGET * 2",
      "{ timeout: BUDGET }",
      "{ timeout }",
      '{ ["timeout"]: BUDGET }',
    ]) {
      test(`${api}${variant} requires a reason for ${timeout}`, () => {
        withFixture((directory, file) => {
          writeFileSync(
            file,
            `${IMPORTS}const BUDGET = 60_000; const timeout = BUDGET; ${api}${variant}("case", () => {}, ${timeout});`,
          );
          expect(customLintTestTimeoutViolations({ directory })).toEqual([
            "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
          ]);
        });
      });
    }
  }
}

for (const source of [
  'import { test as check } from "bun:test"; check.only("case", () => {}, budget);',
  'import { setDefaultTimeout as budget } from "bun:test"; budget(30_000);',
  'import * as suite from "bun:test"; suite.it.skip("case", () => {}, budget);',
  `${IMPORTS}const options = { timeout: budget }; test("case", options, () => {});`,
  `${IMPORTS}const options = { timeout: budget }; test("case", { ...options }, () => {});`,
]) {
  test(`resolves timeout syntax: ${source}`, () => {
    withFixture((directory, file) => {
      writeFileSync(file, source);
      expect(customLintTestTimeoutViolations({ directory })).toEqual([
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ]);
    });
  });
}

test("comments, strings, unrelated options and each data are not overrides", () => {
  withFixture((directory, file) => {
    writeFileSync(
      file,
      `${IMPORTS}
      // setDefaultTimeout(60_000);
      const text = 'test("case", () => {}, 60_000)';
      const options = { timeout: 60_000 };
      test.each([1], [2], [3])("case", () => {});
      test("case", () => { other({ timeout: 60_000 }); });
      test("case", () => {}, { retry: 2 });
    `,
    );
    expect(customLintTestTimeoutViolations({ directory })).toEqual([]);
  });
});

for (const source of [
  'test(...["case", async () => {}, 60_000]);',
  'test.only(...["case", async () => {}, 60_000]);',
  'it(...["case", async () => {}, 60_000]);',
  'test.each([1])(...["case", async () => {}, 60_000]);',
  'test("case", ...[async () => {}, 60_000]);',
  'test("case", async () => {}, ...[60_000]);',
]) {
  test(`test-call argument spreads cannot hide timeout overrides: ${source}`, () => {
    withFixture((directory, file) => {
      writeFileSync(file, `${IMPORTS}${source}`);
      expect(customLintTestTimeoutViolations({ directory })).toEqual([
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ]);
    });
  });
}

test("an override requires a nonempty measured allow-list reason", () => {
  withFixture((directory, file) => {
    writeFileSync(file, `${IMPORTS}setDefaultTimeout(60_000);`);
    expect(
      customLintTestTimeoutViolations({
        directory,
        allowlist: { "fixture.test.ts": "  " },
      }),
    ).toEqual([
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ]);
    expect(
      customLintTestTimeoutViolations({
        directory,
        allowlist: {
          "fixture.test.ts": "Measured 42 s for the repository census",
        },
      }),
    ).toEqual([]);
  });
});

for (const [name, source, expected] of [
  [
    "named retry-only options",
    'const options = { retry: 2 }; test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
  [
    "named timeout options",
    'const options = { timeout: 60_000 }; test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
  [
    "imported options",
    'import { options } from "./options"; test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
  [
    "computed options",
    'const options = { [key]: 2 }; test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
  [
    "call-result options",
    'const options = getOptions(); test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
  [
    "mutable options",
    'let options = { retry: 2 }; test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
  [
    "unresolved spread options",
    'const options = { ...getOptions() }; test("case", () => {}, options);',
    [
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ],
  ],
] as const) {
  test(`${name} are classified before applying the timeout policy`, () => {
    withFixture((directory, file) => {
      writeFileSync(file, `${IMPORTS}${source}`);
      expect(customLintTestTimeoutViolations({ directory })).toEqual([
        ...expected,
      ]);
    });
  });
}

for (const signature of ["options-first", "callback-first"]) {
  for (const [name, setup, options, expected] of [
    ["inline retry", "", "{ retry: 2 }", []],
    [
      "mutated named options",
      "const options = { retry: 2 }; options.timeout = 60_000;",
      "options",
      [
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ],
    ],
    [
      "inline spread",
      "",
      "{ ...{ retry: 2 } }",
      [
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ],
    ],
    [
      "inline timeout",
      "",
      "{ timeout: 60_000 }",
      [
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ],
    ],
    [
      "named retry",
      "const options = { retry: 2 };",
      "options",
      [
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ],
    ],
    [
      "named timeout",
      "const options = { timeout: 60_000 };",
      "options",
      [
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ],
    ],
    [
      "imported options",
      'import { options } from "./options";',
      "options",
      [
        "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
      ],
    ],
  ] as const) {
    for (const callback of ["() => {}", "function () {}", "callback"]) {
      test(`${signature} classifies ${name} with ${callback}`, () => {
        withFixture((directory, file) => {
          const argumentsSource =
            signature === "options-first"
              ? `${options}, ${callback}`
              : `${callback}, ${options}`;
          writeFileSync(
            file,
            `${IMPORTS}const callback = () => {}; ${setup}test("case", ${argumentsSource});`,
          );
          expect(customLintTestTimeoutViolations({ directory })).toEqual([
            ...expected,
          ]);
        });
      });
    }
  }
}

test("shared test helpers cannot change the central budget", () => {
  withFixture((directory) => {
    writeFileSync(
      path.join(directory, "helper.ts"),
      `${IMPORTS}setDefaultTimeout(60_000);`,
    );
    expect(customLintTestTimeoutViolations({ directory })).toEqual([
      "helper.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ]);
  });
});

test("custom lint test timeout overrides require a measured allow-list reason", () => {
  expect(checkTimeouts()).toEqual([]);
  expect(repositoryCustomLintRunnerViolations()).toEqual([]);
});

const rolloutFixture = (directory: string, lines: readonly number[]) =>
  new Map([
    [
      repoRelativePath(
        path.resolve(import.meta.dirname, ".."),
        path.join(directory, "fixture.test.ts"),
      ),
      new Set(lines),
    ],
  ]);

test("the first week ignores an unchanged timeout and rejects a changed one", () => {
  withFixture((directory, file) => {
    writeFileSync(
      file,
      `${IMPORTS}test("legacy", () => {}, 60_000);\ntest("new", () => {}, 60_000);\n`,
    );
    const now = new Date("2026-10-14T00:00:00.000Z");
    expect(
      checkTimeouts({
        directory,
        now,
        changedLines: rolloutFixture(directory, []),
      }),
    ).toEqual([]);
    expect(
      checkTimeouts({
        directory,
        now,
        changedLines: rolloutFixture(directory, [3]),
      }),
    ).toEqual([
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ]);
  });
});

test("the rollout expires into full timeout enforcement", () => {
  withFixture((directory, file) => {
    writeFileSync(file, `${IMPORTS}test("legacy", () => {}, 60_000);\n`);
    expect(
      checkTimeouts({
        directory,
        now: new Date("2026-10-21T00:00:00.000Z"),
        changedLines: rolloutFixture(directory, []),
      }),
    ).toEqual([
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ]);
  });
});

test("the changed timeout option is enforced inside a multiline call", () => {
  withFixture((directory, file) => {
    writeFileSync(
      file,
      `${IMPORTS}test(\n  "case",\n  () => {},\n  { timeout: 60_000 },\n);\n`,
    );
    expect(
      checkTimeouts({
        directory,
        now: new Date("2026-10-14T00:00:00.000Z"),
        changedLines: rolloutFixture(directory, [5]),
      }),
    ).toEqual([
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ]);
  });
});

test("full enforcement can be requested during rollout", () => {
  withFixture((directory, file) => {
    writeFileSync(file, `${IMPORTS}test("legacy", () => {}, 60_000);\n`);
    expect(
      checkTimeouts({
        directory,
        scope: "all",
        now: new Date("2026-10-14T00:00:00.000Z"),
        changedLines: rolloutFixture(directory, []),
      }),
    ).toEqual([
      "fixture.test.ts: pass test options inline without timeout keys or spreads; exceptions require an allow-list reason",
    ]);
  });
});
