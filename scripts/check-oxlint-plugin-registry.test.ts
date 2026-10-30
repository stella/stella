import { describe, expect, test } from "bun:test";

import {
  newGuardRolloutErrors,
  NON_PLUGIN_MODULES,
  redeclaredSharedHelpers,
  ruleNamesFromSource,
} from "./check-oxlint-plugin-registry.ts";

test("a new rule must ship a registered repair or dated changed-lines scope", () => {
  const rule = "no-raw-path-relative/no-raw-path-relative";
  const options = { rules: [rule], now: new Date("2026-10-13T00:00:00.000Z") };
  expect(newGuardRolloutErrors({ ...options, rollouts: [] })).toHaveLength(1);
  expect(
    newGuardRolloutErrors({
      ...options,
      rollouts: [
        {
          id: "fixture",
          rules: [rule],
          type: "changed-lines",
          expiresAt: "2026-10-20T00:00:00.000Z",
          check: [],
        },
      ],
    }),
  ).toEqual([]);
  expect(
    newGuardRolloutErrors({
      ...options,
      rollouts: [{ id: "path", rules: [rule], type: "full", check: [] }],
    }),
  ).toHaveLength(1);
  expect(
    newGuardRolloutErrors({
      ...options,
      rollouts: [
        {
          id: "path",
          rules: [rule],
          type: "autofix",
          generator: "unknown",
          check: [],
        },
      ],
    }),
  ).toHaveLength(1);
  expect(
    newGuardRolloutErrors({
      ...options,
      rollouts: [
        {
          id: "path",
          rules: [rule],
          type: "autofix",
          generator: "cloud-setup",
          check: [],
        },
      ],
    }),
  ).toEqual([]);
  for (const expiresAt of [
    "invalid",
    "2026-10-13T00:00:00.000Z",
    "2026-10-20T00:00:00.001Z",
  ]) {
    expect(
      newGuardRolloutErrors({
        ...options,
        rollouts: [
          {
            id: "path",
            rules: [rule],
            type: "changed-lines",
            expiresAt,
            check: [],
          },
        ],
      }),
    ).toHaveLength(1);
  }
});

describe("plugin rule census", () => {
  test("keeps shared rule data and detector helpers out of the plugin census", () => {
    expect(
      NON_PLUGIN_MODULES.has("public-law-decision-surface-modules.ts"),
    ).toBe(true);
    expect(NON_PLUGIN_MODULES.has("network-call.ts")).toBe(true);
  });

  test("derives literal and computed rule names independently of formatting or factory nesting", () => {
    for (const indentation of ["", "  ", "    ", "      ", "\t"]) {
      const rules = `rules: {\n${indentation}"literal-rule": {},\n${indentation}[RULE_NAME]: {}\n}`;
      for (const source of [
        `const RULE_NAME = "computed-rule"; export default { ${rules} };`,
        `export const RULE_NAME = "computed-rule"; export default { ${rules} };`,
        `const RULE_NAME = "computed-rule"; const createPlugin = () => ({ ${rules} }); export default createPlugin();`,
      ]) {
        expect(ruleNamesFromSource(source)).toEqual([
          "literal-rule",
          "computed-rule",
        ]);
      }
    }
  });

  test("does not derive rules from comments, strings, other objects or unresolved keys", () => {
    expect(
      ruleNamesFromSource(`
      // rules: { "comment-rule": {} }
      const text = 'rules: { "string-rule": {} }';
      const messages = { "message-rule": {} };
      export default { rules: { [UNKNOWN]: {} } };
    `),
    ).toEqual([]);
  });
});

describe("shared helper redeclarations", () => {
  const helpers = ["AstNode", "isAstNode", "resolveVariable"];

  test("reports local declarations of shared helper names", () => {
    const source = [
      "type AstNode = { type: string };",
      "const isAstNode = (node: unknown) => true;",
      "function resolveVariable(identifier) {}",
    ].join("\n");
    expect(redeclaredSharedHelpers(source, helpers)).toEqual(helpers);
  });

  test("accepts imports of shared helper names", () => {
    const source =
      'import { type AstNode, isAstNode } from "./utils.ts";\nisAstNode(x);';
    expect(redeclaredSharedHelpers(source, helpers)).toEqual([]);
  });
});
