import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import oxlintConfig from "../../oxlint.config.ts";
import { DERIVED_ATTRIBUTES } from "../../scripts/derived-attributes.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const RULE_ID = "no-literal-derived-attribute/no-literal-derived-attribute";

const DETECTOR = "apps/api/src/lib/files/detect-file-encryption.ts";
const ruleOptions = {
  attributes: [
    { name: "encrypted", detector: DETECTOR, within: ["apps/api/src/"] },
  ],
};

const lint = async (
  lines: readonly string[],
  sourcePath = "apps/api/src/handlers/entities/example.ts",
) =>
  await lintSingleRule(
    "no-literal-derived-attribute",
    [...lines, ""].join("\n"),
    {
      ruleOptions,
      sourcePath,
    },
  );

describe.serial("no-literal-derived-attribute", () => {
  test("reports a literal handed to a writer", async () => {
    expect(
      await lint([
        "declare const write: (input: { encrypted: boolean }) => void;",
        "write({ encrypted: false });",
        "write({ encrypted: true as const });",
      ]),
    ).toEqual([2, 3]);
  });

  test("reports locals, assignments, defaults, and class fields", async () => {
    expect(
      await lint([
        "let encrypted = false;",
        "encrypted = true;",
        "declare const row: { encrypted: boolean };",
        "row.encrypted = false;",
        "export const a = ({ encrypted = false }: { encrypted?: boolean }) => encrypted;",
        "export const b = ({ encrypted: e = true }: { encrypted?: boolean }) => e;",
        "export class C { encrypted = false; }",
      ]),
    ).toEqual([1, 2, 4, 5, 6, 7]);
  });

  test("accepts values that come from data", async () => {
    expect(
      await lint([
        "declare const encryption: { encrypted: boolean };",
        "declare const write: (input: { encrypted: boolean }) => void;",
        "write({ encrypted: encryption.encrypted });",
        "export const messages = { encrypted: 'This PDF is encrypted.' };",
        "export type Shape = { encrypted: false };",
        "export const other = { scanned: false };",
      ]),
    ).toEqual([]);
  });

  test("leaves the detector itself free to state the value", async () => {
    expect(
      await lint(["export const unsure = { encrypted: false };"], DETECTOR),
    ).toEqual([]);
  });

  test("does not reach outside the attribute's trees", async () => {
    expect(
      await lint(
        ["export const row = { encrypted: false };"],
        "apps/web/src/example.ts",
      ),
    ).toEqual([]);
  });

  test("every registered attribute has its detector and writer test in place", () => {
    for (const attribute of DERIVED_ATTRIBUTES) {
      expect(
        attribute.within.some((tree) => attribute.detector.startsWith(tree)),
      ).toBe(true);
      const detector = readFileSync(
        path.join(REPOSITORY_ROOT, attribute.detector),
        "utf-8",
      );
      expect(detector).toContain(`export const ${attribute.detectorExport} =`);
      expect(
        existsSync(path.join(REPOSITORY_ROOT, attribute.writersTest)),
      ).toBe(true);
    }
  });

  test("the production override carries every registered attribute", () => {
    const configured = oxlintConfig.overrides.flatMap((override) => {
      const rule: unknown = override.rules?.[RULE_ID];
      return Array.isArray(rule) && rule.at(0) === "error" ? [rule.at(1)] : [];
    });
    expect(configured).toContainEqual({
      attributes: DERIVED_ATTRIBUTES.map(({ detector, name, within }) => ({
        name,
        detector,
        within,
      })),
    });
  });
});
