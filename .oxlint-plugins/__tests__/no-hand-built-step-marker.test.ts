import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-hand-built-step-marker";
const lint = async (source: string) =>
  await lintSingleRule(RULE, source, { sourcePath: "numbered-content.tsx" });

describe.serial(RULE, () => {
  test("rejects literal, padded, and manual numbered markers", async () => {
    expect(
      await lint(
        'const a = <span>01</span>;\nconst b = <b>{String(index + 1).padStart(2, "0")}</b>;\nconst c = <p>{i + 1}. Item</p>;',
      ),
    ).toEqual([1, 2, 3]);
  });

  test("reports a padded marker followed by punctuation once", async () => {
    expect(
      await lint(
        'const marker = <p>{String(i + 1).padStart(2, "0")}. Item</p>;',
      ),
    ).toEqual([1]);
  });

  test("accepts list-owned numbering inside Steps", async () => {
    expect(
      await lint(
        'const ordered = <Steps><Step>First</Step><Step>{String(index + 1).padStart(2, "0")}</Step></Steps>;',
      ),
    ).toEqual([]);
  });

  test("ignores numbers that are data rather than rendered markers", async () => {
    expect(
      await lint('const date = "2026-01-20"; const page = index + 1;'),
    ).toEqual([]);
  });
});
