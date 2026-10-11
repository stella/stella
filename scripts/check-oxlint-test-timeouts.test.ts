import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { customLintTestTimeoutViolations } from "./check-oxlint-test-timeouts.ts";

const IMPORTS =
  'import { test, it, describe, setDefaultTimeout } from "bun:test";\n';
const CLEAN = `${IMPORTS}test("case", () => {});`;

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
        "fixture.test.ts: timeout override is not allow-listed",
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
            "fixture.test.ts: timeout override is not allow-listed",
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
        "fixture.test.ts: timeout override is not allow-listed",
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

test("an override requires a nonempty measured allow-list reason", () => {
  withFixture((directory, file) => {
    writeFileSync(file, `${IMPORTS}setDefaultTimeout(60_000);`);
    expect(
      customLintTestTimeoutViolations({
        directory,
        allowlist: { "fixture.test.ts": "  " },
      }),
    ).toEqual(["fixture.test.ts: timeout override is not allow-listed"]);
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

test("shared test helpers cannot change the central budget", () => {
  withFixture((directory) => {
    writeFileSync(
      path.join(directory, "helper.ts"),
      `${IMPORTS}setDefaultTimeout(60_000);`,
    );
    expect(customLintTestTimeoutViolations({ directory })).toEqual([
      "helper.ts: timeout override is not allow-listed",
    ]);
  });
});

test("custom lint test timeout overrides require a measured allow-list reason", () => {
  expect(customLintTestTimeoutViolations()).toEqual([]);
});
