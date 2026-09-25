import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[]) =>
  await lintSingleRule("no-raw-resource-uri", [...lines, ""].join("\n"));

describe.serial("no-raw-resource-uri", () => {
  test("reports a skill-ref link prefix spelled outside its owner", async () => {
    expect(
      await lint([
        "declare const slug: string;",
        'export const prefix = "#stella-skill-ref=";',
        "export const href = `#stella-skill-ref=${slug}`;",
        'export const guidance = "Use [label](#stella-skill-ref=slug) links.";',
      ]),
    ).toEqual([2, 3, 4]);
  });

  test("accepts a skill-ref link built from the shared prefix", async () => {
    expect(
      await lint([
        'import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";',
        "declare const slug: string;",
        "export const href = `${SKILL_REF_HREF_PREFIX}${slug}`;",
        "export const guidance = `Use [label](${SKILL_REF_HREF_PREFIX}slug).`;",
      ]),
    ).toEqual([]);
  });

  test("still reports resource link prefixes", async () => {
    expect(
      await lint([
        "declare const id: string;",
        "export const href = `#stella-entity=${id}`;",
      ]),
    ).toEqual([2]);
  });
});
