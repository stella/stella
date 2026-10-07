import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-untranslated-jsx-literal", () => {
  test("reports visible raw text and static expression strings", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        'const page = <><Button>Save matter</Button><p>{"Matter created"}</p><p>{`Unable to load`}</p></>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1, 1, 1]);
  });
  test("reports text with non Latin letters", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        "const page = <p>Ulo\u017eit z\u00e1le\u017eitost</p>;",
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1]);
  });
  test("accepts translations and technical or symbolic text", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        'const page = <><Button>{t("common.save")}</Button><code><span>workspaceId</span></code><span>\u2022</span><span>PDF</span></>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("accepts explicitly configured terminology and elements", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        "const page = <><span>stella</span><ProductCode>legal_code</ProductCode><span>v12</span></>;",
        {
          sourcePath: "source.tsx",
          ruleOptions: {
            allowedText: ["stella"],
            ignoredElementNames: ["ProductCode"],
            allowedTextPatterns: ["^v[0-9]+$"],
          },
        },
      ),
    ).toEqual([]);
  });
  test("only gates translation scoped files when configured", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        "const page = <Button>Save matter</Button>;",
        {
          sourcePath: "source.tsx",
          ruleOptions: { requireTranslationUsage: true },
        },
      ),
    ).toEqual([]);
  });
  test("reports untranslated text when translation scoped analysis is active", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        "const t = useTranslations();\nconst page = <Button>Save matter</Button>;",
        {
          sourcePath: "source.tsx",
          ruleOptions: { requireTranslationUsage: true },
        },
      ),
    ).toEqual([2]);
  });
  test("honors a configured translation marker", async () => {
    expect(
      await lintSingleRule(
        "no-untranslated-jsx-literal",
        "const translate = localTranslations();\nconst page = <Button>Save matter</Button>;",
        {
          sourcePath: "source.tsx",
          ruleOptions: {
            requireTranslationUsage: true,
            translationMarkers: ["localTranslations"],
          },
        },
      ),
    ).toEqual([2]);
  });
});
