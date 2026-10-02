import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const RULE_NAME = "no-provision-brand-outside-owner";
const SOURCE = [
  'import * as v from "valibot";',
  'export const key = v.brand("ProvisionKey");',
  'export const ref = v.brand("ProvisionRef");',
].join("\n");

describe.serial("provision brands have one minting owner", () => {
  test.each([
    "packages/api-contract/src/provision-key.ts",
    "apps/web/src/provision.ts",
    "packages/legal-atlas-other/src/provision.ts",
  ])("rejects both brands outside their owner: %s", async (sourcePath) => {
    expect(await lintSingleRule(RULE_NAME, SOURCE, { sourcePath })).toEqual([
      2, 3,
    ]);
  });

  test("allows minting within legal-atlas", async () => {
    expect(
      await lintSingleRule(RULE_NAME, SOURCE, {
        sourcePath: "packages/legal-atlas/src/provision-key.ts",
      }),
    ).toEqual([]);
  });

  test("follows named, namespace and local aliases", async () => {
    expect(
      await lintSingleRule(
        RULE_NAME,
        [
          'import { brand as mint } from "valibot";',
          'import * as schema from "valibot";',
          "const { brand: local } = schema;",
          "const alias = mint;",
          'export const named = mint("ProvisionKey");',
          'export const member = schema["brand"]("ProvisionRef");',
          "export const destructured = local(`ProvisionKey`);",
          'export const aliased = alias("ProvisionRef" as const);',
        ].join("\n"),
      ),
    ).toEqual([5, 6, 7, 8]);
  });

  test("allows other brands, unrelated callees and shadowed bindings", async () => {
    expect(
      await lintSingleRule(
        RULE_NAME,
        [
          'import * as v from "valibot";',
          'import { brand } from "other-library";',
          'export const otherBrand = v.brand("DocumentId");',
          'export const otherLibrary = brand("ProvisionKey");',
          'export const local = (v: { brand: (name: string) => string }) => v.brand("ProvisionRef");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
