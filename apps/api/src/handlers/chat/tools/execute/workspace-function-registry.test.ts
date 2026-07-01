import { describe, expect, test } from "bun:test";

import { findHitsInText } from "./workspace-function-registry";

const OPTIONS = { caseSensitive: false, limit: 5, wholeWord: false };

describe("findHitsInText", () => {
  test("matches Arabic orthographic variants (teh marbuta)", () => {
    const result = findHitsInText("عقد خدمة موقع", "خدمه", OPTIONS);
    expect(result.totalHits).toBe(1);
  });

  test("folds Arabic-Indic digits but slices snippet from original text", () => {
    const result = findHitsInText("القيمة ٢٠٢٤ مهمة", "2024", OPTIONS);
    expect(result.totalHits).toBe(1);
    // The snippet preserves the original digits, not the folded "2024".
    expect(result.hits.at(0)?.snippet).toContain("٢٠٢٤");
  });

  test("bounds snippets by the matched source characters", () => {
    const result = findHitsInText(`م${"ـ".repeat(300)}نهاية`, "م", {
      ...OPTIONS,
      limit: 1,
    });

    expect(result.totalHits).toBe(1);
    expect(result.hits.at(0)?.snippet.length).toBeLessThan(250);
  });

  test("matches decomposed Arabic hamza forms", () => {
    const result = findHitsInText("أحمد", "احمد", OPTIONS);
    expect(result.totalHits).toBe(1);
    expect(result.hits.at(0)?.snippet).toBe("أحمد");
  });

  test("returns no hits when the query folds to empty", () => {
    const result = findHitsInText("نص عربي", "ـ", OPTIONS);
    expect(result.totalHits).toBe(0);
    expect(result.hits).toHaveLength(0);
  });

  test("caps compatibility-character expansion before scanning", () => {
    const result = findHitsInText("ﷺ".repeat(30_000), "missing", OPTIONS);

    expect(result.totalHits).toBe(0);
    expect(result.totalHitsCapped).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test("still matches plain ASCII content", () => {
    const result = findHitsInText("hello world", "WORLD", OPTIONS);
    expect(result.totalHits).toBe(1);
    expect(result.hits.at(0)?.snippet).toContain("world");
  });
});
