import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-shared-checkout-mutation";
const lint = async (source: string) =>
  lintSingleRule(RULE, source, { sourcePath: "source.test.ts" });

describe(RULE, () => {
  test("rejects removal and writes derived from the checkout", async () => {
    expect(
      await lint(
        'import { rm, writeFileSync } from "node:fs";\nimport path from "node:path";\nconst root = new URL("..", import.meta.url);\nawait rm(new URL("fixture.json", root));\nconst checkout = path.join(import.meta.dir, "../../..");\nwriteFileSync(path.join(checkout, "baseline.json"), "changed");',
      ),
    ).toEqual([4, 6]);
  });

  test("allows temporary and unrelated relative paths", async () => {
    expect(
      await lint(
        'import { mkdtemp, rm, writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(tmpdir(), "rule-"));\nawait writeFile(path.join(scratch, "fixture"), "changed");\nawait rm("relative-output");',
      ),
    ).toEqual([]);
  });

  test("allows copying checkout inputs into temporary destinations", async () => {
    expect(
      await lint(
        'import { copyFile, mkdtemp } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport path from "node:path";\nconst scratch = await mkdtemp(path.join(tmpdir(), "rule-"));\nawait copyFile(path.join(import.meta.dir, "fixture"), path.join(scratch, "copy"));',
      ),
    ).toEqual([]);
  });

  test("allows writes through the audited regeneration helper", async () => {
    expect(
      await lint(
        'import { writeRegeneratedFile } from "@stll/test-kit";\nawait writeRegeneratedFile(new URL("baseline.json", import.meta.url), "changed");',
      ),
    ).toEqual([]);
  });
});
