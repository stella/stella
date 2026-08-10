import { describe, expect, test } from "bun:test";

import {
  timeEntryActionLabel,
  timeEntryNarrativeExcerpt,
} from "./time-entry-copy.logic";

describe("time entry action copy", () => {
  test("bounds long narratives without splitting Unicode code points", () => {
    const excerpt = timeEntryNarrativeExcerpt("⚖️".repeat(100));

    expect(Array.from(excerpt)).toHaveLength(121);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.includes("�")).toBe(false);
  });

  test("identifies the entry in repeated action labels", () => {
    expect(timeEntryActionLabel("Edit", "Review disclosure schedule")).toBe(
      "Edit: Review disclosure schedule",
    );
  });
});
