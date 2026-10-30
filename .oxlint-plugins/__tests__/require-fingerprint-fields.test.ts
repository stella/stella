import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const imports =
  'import { TaggedError as Tagged } from "better-result"; import { declareFingerprintFields as declare } from "@stll/errors";';

test("new tagged error dimensions require static registration of every field", async () => {
  expect(
    await lintSingleRule(
      "require-fingerprint-fields",
      [
        imports,
        'class Missing extends Tagged("Missing")<{ message: string; reason: "read" }> {}',
        'class Partial extends Tagged("Partial")<{ message: string; reason: Reason; stage: "read" }> { static { declare(this, ["reason"]); } }',
        'class Dynamic extends Tagged("Dynamic")<{ message: string; phase: "read" }> { static { declare(this, fields); } }',
        'class Runtime extends Tagged("Runtime")<{ message: string; reason: "read" }> { constructor() { super(); declare(this, ["reason"]); } }',
        'class Shadow extends Tagged("Shadow")<{ message: string; reason: Reason }> { static { declare(Other, ["reason.kind"]); } }',
        'class WrongRoot extends Tagged("WrongRoot")<{ message: string; reason: Reason }> { static { declare(this, ["reasonDetail.kind"]); } }',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 5, 6, 7]);
});

test("registered dimensions and errors without finite local dimensions remain clean", async () => {
  expect(
    await lintSingleRule(
      "require-fingerprint-fields",
      [
        imports,
        'class Registered extends Tagged("Registered")<{ message: string; reason: "read"; phase: Phase; stage?: "write" }> { static { declare(this, ["reason", "phase", "stage"]); } }',
        'class Structured extends Tagged("Structured")<{ message: string; reason: { kind: "read" | "write"; detail: string } }> { static { declare(this, ["reason.kind"]); } }',
        'class FreeText extends Tagged("FreeText")<{ message: string; reason: string }> {}',
        'class Named extends Tagged("Named")<Props> {}',
        'class NoDimensions extends Tagged("None")<{ message: string }> {}',
        "class Ordinary extends Error {}",
      ].join("\n"),
    ),
  ).toEqual([]);
});
