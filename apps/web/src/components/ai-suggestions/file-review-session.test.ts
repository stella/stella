import { describe, expect, test } from "bun:test";

import { resolveFileReviewSessionId } from "@/components/ai-suggestions/file-review-session";

describe("file review session identity", () => {
  test("owns persisted-file suggestions by entity", () => {
    expect(
      resolveFileReviewSessionId({ type: "file", entityId: "entity-1" }),
    ).toBe("entity-1");
  });

  test("owns unsaved-draft suggestions by tool call", () => {
    expect(
      resolveFileReviewSessionId({ type: "draft", toolCallId: "tool-1" }),
    ).toBe("draft:tool-1");
  });

  test("has no review session without an editable document", () => {
    expect(resolveFileReviewSessionId({ type: "none" })).toBeUndefined();
  });
});
