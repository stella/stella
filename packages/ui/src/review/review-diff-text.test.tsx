import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { ReviewDiffSegment } from "./review-diff-text";
import { ReviewDiffText, reviewDiffSegmentKeys } from "./review-diff-text";

describe("reviewDiffSegmentKeys", () => {
  test("distinguishes repeated segments by occurrence", () => {
    const segments: ReviewDiffSegment[] = [
      { type: "delete", text: "the" },
      { type: "equal", text: " party " },
      { type: "delete", text: "the" },
    ];

    expect(reviewDiffSegmentKeys(segments)).toEqual([
      "delete-the-0",
      "equal- party -0",
      "delete-the-1",
    ]);
  });

  test("keys are unique for every segment of a diff", () => {
    const segments: ReviewDiffSegment[] = Array.from({ length: 6 }, () => ({
      type: "equal" as const,
      text: "x",
    }));

    expect(new Set(reviewDiffSegmentKeys(segments)).size).toBe(6);
  });

  test("an empty diff has no keys", () => {
    expect(reviewDiffSegmentKeys([])).toEqual([]);
  });
});

describe("ReviewDiffText", () => {
  test("renders insertions as <ins> and deletions as <del>", () => {
    const markup = renderToStaticMarkup(
      <ReviewDiffText
        segments={[
          { type: "equal", text: "Notice within " },
          { type: "delete", text: "ten" },
          { type: "insert", text: "thirty" },
          { type: "equal", text: " days." },
        ]}
      />,
    );

    expect(markup).toContain("<del");
    expect(markup).toContain(">ten</del>");
    expect(markup).toContain("<ins");
    expect(markup).toContain(">thirty</ins>");
    // Unchanged text stays unmarked so a screen reader reads one sentence.
    expect(markup).toContain("<span>Notice within </span>");
  });

  test("carries the shared track-changes styling, not per-surface classes", () => {
    const markup = renderToStaticMarkup(
      <ReviewDiffText segments={[{ type: "insert", text: "added" }]} />,
    );

    expect(markup).toContain("var(--success)");
  });

  test("renders nothing for an empty diff", () => {
    const markup = renderToStaticMarkup(<ReviewDiffText segments={[]} />);

    expect(markup).not.toContain("<ins");
    expect(markup).not.toContain("<del");
  });
});
