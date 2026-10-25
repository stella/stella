import { describe, expect, test } from "bun:test";

import {
  NON_PLUGIN_MODULES,
  redeclaredSharedHelpers,
  ruleNamesFromSource,
} from "./check-oxlint-plugin-registry.ts";

describe("plugin rule census", () => {
  test("keeps shared rule data modules out of the plugin census", () => {
    expect(
      NON_PLUGIN_MODULES.has("public-law-decision-surface-modules.ts"),
    ).toBe(true);
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
