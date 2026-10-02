import { describe, expect, test } from "bun:test";

import config from "../../oxlint.config.ts";
import {
  readScopes,
  scopeMatches,
} from "../../scripts/oxlint-config-scopes.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-test-swallowed-error";
const PLUGIN = "no-swallowed-item-error";
const REASON =
  "drains an already-observed failed reader before releasing its lock";
const HANDLERS = [
  ...["undefined", "null", "[]", "{}", "false", "0", '""', "void 0"].flatMap(
    (value) => [
      `request().catch(() => (${value}));`,
      `request().catch(() => { return ${value}; });`,
    ],
  ),
  "request().catch(() => {});",
  "request().catch(() => { /* no handling */ });",
  "try { request(); } catch {}",
  "try { request(); } catch (error) {}",
  "try { request(); } catch { /* no handling */ }",
];

describe.serial("test failures remain observable", () => {
  test("rejects each empty or constant handler and accepts each with a visible reason", async () => {
    const source = HANDLERS.flatMap((handler) => [
      handler,
      `// swallow-ok: ${REASON}`,
      handler,
      `${handler} // swallow-ok: ${REASON}`,
    ]);
    expect(
      await lintSingleRule(RULE, source.join("\n"), { plugin: PLUGIN }),
    ).toEqual(HANDLERS.map((_, index) => index * 4 + 1));
  });

  test("requires a specific reason adjacent to the catch token", async () => {
    const cases = [
      "// swallow-ok: cleanup\nrequest().catch(() => undefined);",
      "// swallow-ok: TODO explain this intentional request failure\nrequest().catch(() => undefined);",
      "// swallow-ok: placeholder reason\nrequest().catch(() => undefined);",
      `const unrelated = true; // swallow-ok: ${REASON}\nrequest().catch(() => undefined);`,
      `// swallow-ok: ${REASON}\n\nrequest().catch(() => undefined);`,
      `const unrelated = '// swallow-ok: ${REASON}';\nrequest().catch(() => undefined);`,
      `/* swallow-ok: ${REASON} */\nrequest().catch(() => undefined);`,
      `// swallow-ok: ${REASON}\nrequest()\n  .catch(() => undefined);`,
      `request()\n  // swallow-ok: ${REASON}\n  .catch(() => undefined);`,
      `try { request(); }\n// swallow-ok: ${REASON}\ncatch { /* optional cleanup */ }`,
      "request().catch((error) => { throw error; });",
      'request().catch((error) => { expect(error.message).toBe("cancelled"); });',
    ];
    for (const [index, source] of cases.entries()) {
      const diagnostics = await lintSingleRule(RULE, source, {
        plugin: PLUGIN,
      });
      expect(diagnostics.length, source).toBe(index < 8 ? 1 : 0);
    }
  });

  test("covers every application, package and script test/support shape", () => {
    const scopes = readScopes(config);
    const effectiveRule = (file: string) =>
      scopes.findLast(
        (scope) =>
          scopeMatches(scope, file) && `${PLUGIN}/${RULE}` in scope.rules,
      )?.rules[`${PLUGIN}/${RULE}`];
    for (const root of ["apps/api", "apps/web", "packages/cli", "scripts"]) {
      for (const extension of [
        "ts",
        "tsx",
        "js",
        "jsx",
        "mts",
        "cts",
        "mjs",
        "cjs",
      ]) {
        for (const shape of [
          "src/check.test",
          "e2e/check.spec",
          "tests/helpers/check",
          "src/__tests__/check",
        ]) {
          expect(effectiveRule(`${root}/${shape}.${extension}`)).toBe("error");
        }
      }
      expect(effectiveRule(`${root}/src/check.ts`)).toBeUndefined();
    }
    expect(
      effectiveRule(
        ".oxlint-plugins/__fixtures__/no-swallowed-item-error.fixture.test.ts",
      ),
    ).toBe("error");
  });
});
