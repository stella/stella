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
});
