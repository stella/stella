import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-raw-resource-uri", [...lines, ""].join("\n"));

describe.serial("no-raw-resource-uri", () => {
  test("reports a skill-ref link prefix spelled outside its owner", async () => {
    expect(
      await lint([
        "declare const slug: string;",
        'export const prefix = "#stella-skill-ref=";',
        `export const href = \`#stella-skill-ref=\${slug}\`;`,
        'export const guidance = "Use [label](#stella-skill-ref=slug) links.";',
      ]),
    ).toEqual([2, 3, 4]);
  });

  test("accepts a skill-ref link built from the shared prefix", async () => {
    expect(
      await lint([
        'import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";',
        "declare const slug: string;",
        `export const href = \`\${SKILL_REF_HREF_PREFIX}\${slug}\`;`,
        `export const guidance = \`Use [label](\${SKILL_REF_HREF_PREFIX}slug).\`;`,
      ]),
    ).toEqual([]);
  });

  test("still reports resource link prefixes", async () => {
    expect(
      await lint([
        "declare const id: string;",
        `export const href = \`#stella-entity=\${id}\`;`,
      ]),
    ).toEqual([2]);
  });

  test("recognizes literal resource prefixes amid Unicode punctuation", async () => {
    expect(
      await lint([
        'export const href = "⚖️ «#stella-decision=abc»";',
        'export const resource = "⟦stella://resource/entity/abc⟧";',
      ]),
    ).toEqual([1, 2]);
  });

  test("checks every resource prefix when a skill-ref prefix shares the literal", async () => {
    expect(
      await lint([
        'export const href = "#stella-skill-ref=slug #stella-workspace=abc";',
      ]),
    ).toEqual([1]);
  });

  test("accepts case variants, empty strings, and owned serializers", async () => {
    expect(
      await lint([
        'import { toResourceName } from "@stll/api-contract/resource-ref";',
        'import { toChatResourceHref } from "@stll/api-contract/resource-link";',
        "declare const resource: Parameters<typeof toResourceName>[0];",
        "export const name = toResourceName(resource);",
        "export const href = toChatResourceHref(resource);",
        'export const text = "";',
        'export const prose = "#STELLA-DECISION=abc";',
      ]),
    ).toEqual([]);
  });
});
