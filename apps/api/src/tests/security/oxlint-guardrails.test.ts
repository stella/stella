import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readRootFixture = (relativePath: string) =>
  readFileSync(join(import.meta.dir, "../../../../..", relativePath), "utf-8");

describe("custom oxlint guardrails", () => {
  test("process.env rule treats only static computed keys as known names", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/forbid-process-env-outside-env-ts.ts",
    );

    expect(pluginSource).toContain("const staticMemberPropertyName");
    expect(pluginSource).toContain("isStringLiteral(node.property)");
    expect(pluginSource).toContain('return "process.env[...]"');
  });

  test("JSX literal rule remains scoped to files using translation markers", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/no-untranslated-jsx-literal.ts",
    );

    expect(pluginSource).toContain("options.requireTranslationUsage === true");
    expect(pluginSource).toContain("sourceText.includes(marker)");
    expect(pluginSource).toContain("useTranslations");
    expect(pluginSource).toContain("TranslationKey");
  });

  test("require-contained-handler excludes onBlur and resolves non-identifier refs", () => {
    const pluginSource = readRootFixture(
      ".oxlint-plugins/require-contained-handler.ts",
    );

    // `onBlur` would silently mis-fire because blur's target is the
    // element losing focus, not the new destination — must stay out
    // of the watched set.
    expect(pluginSource).not.toContain('"onBlur"');
    expect(pluginSource).toContain('"onMouseDown"');
    expect(pluginSource).toContain('"onFocus"');

    // Non-identifier ref expressions (MemberExpression, callback refs)
    // must still enforce the rule rather than silently skipping the
    // element — see the `findRefDisplayName` fallback branches.
    expect(pluginSource).toContain("memberExpressionPath");
    expect(pluginSource).toContain('return "ref"');

    // Void / leaf form elements cannot have a React subtree, so the
    // portal scenario cannot apply. They are excluded by name so a
    // `<input ref={…} onMouseDown={…} />` autofocus pattern is left
    // alone instead of acquiring a redundant wrap.
    expect(pluginSource).toContain("LEAF_ELEMENTS");
    expect(pluginSource).toContain('"input"');
    expect(pluginSource).toContain('"textarea"');
  });

  test("containedHandler helper uses Node, not Element, for containment", () => {
    const helperSource = readRootFixture(
      "packages/ui/src/hooks/use-contained-handler.ts",
    );

    // `Node.contains` accepts any Node; narrowing the target to
    // `Element` previously let Text-node click targets bypass the
    // containment filter.
    expect(helperSource).toContain("instanceof Node");
    expect(helperSource).not.toContain("instanceof Element");
  });
});
