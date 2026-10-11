import { describe, expect, test } from "bun:test";

import { isAiResourcePath } from "./ai-resource-path";

describe("AI resource path", () => {
  test("accepts flat and nested Markdown under the editable roots", () => {
    for (const path of [
      "references/checklist.md",
      "references/cz/act-110.md",
      "references/case-law/supreme.md",
      "assets/01-foundations.md",
      "scripts/review.md",
    ]) {
      expect(isAiResourcePath(path)).toBe(true);
    }
  });

  test("rejects bad roots, traversal, and non-Markdown", () => {
    for (const path of [
      "assets/logo.png",
      "scripts/run.sh",
      "secret.md",
      "knowledge/01-foundations.md",
      "prompts/review.prompt.md",
      "reference/citations.md",
      "templates/draft.md",
      "references/../etc/passwd.md",
      "references/notes.txt",
      "references/.md",
      "/references/x.md",
    ]) {
      expect(isAiResourcePath(path)).toBe(false);
    }
  });
});
