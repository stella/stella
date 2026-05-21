import { describe, expect, test } from "bun:test";
// Issue #406 (eigenpal): headers and footers go through a separate
// ProseMirror document whose positions also start at 1, so an HF run can
// carry the same `data-pm-start` as a body run. Pre-PR, the DOM-based
// selection painter and caret resolver in clickToPositionDom queried every
// span on the page, matched both trees, and painted phantom selection rects
// on header/footer text. Scope must be `.layout-page-content`.
//
// We can't easily exercise the full DOM-range path under bun:test (no DOM,
// no Range), so this test asserts the *call site* is scoped — the failure
// mode is a regression that drops the prefix and re-introduces the HF
// bleed at the page-container or page-element level.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dirname, "clickToPositionDom.ts"),
  "utf-8",
);

describe("clickToPositionDom selector scope (issue #406)", () => {
  test("page-container span queries are scoped to body content", () => {
    // The two functions whose queries traverse the WHOLE pages container
    // (getSelectionRectsFromDom and getCaretPositionFromDom) must use the
    // body scope. Search for the bare selector with `container.` as the
    // receiver — that's the dangerous form that hits HF spans.
    const dangerous = SOURCE.match(
      /container\.querySelectorAll\([^)]*"span\[data-pm-start\]\[data-pm-end\]"/gu,
    );

    expect(dangerous).toBeNull();
  });

  test("page-element span queries are scoped to body content", () => {
    // findNearestSpan walks `pageEl.querySelectorAll(...)`. `pageEl` is the
    // whole `.layout-page` and contains header/footer subtrees, so the
    // bare selector form is also dangerous here.
    const dangerous = SOURCE.match(
      /pageEl\.querySelectorAll\([^)]*"span\[data-pm-start\]\[data-pm-end\]"/gu,
    );

    expect(dangerous).toBeNull();
  });

  test("page-container .layout-line query is scoped to body content", () => {
    // `pageEl.querySelectorAll('.layout-line')` would also match HF lines
    // and lead the click resolver to an HF position; scope it.
    const dangerous = SOURCE.match(
      /pageEl\.querySelectorAll\(\s*"\.layout-line"/gu,
    );

    expect(dangerous).toBeNull();
  });
});
