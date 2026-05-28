import { describe, expect, test } from "bun:test";

import {
  findHfCaretSpan,
  findHfPmAnchor,
  findHfPmAnchors,
  findHfPmSpans,
  findHfSlotForTarget,
} from "./findHfPmSpans";

const headerSpan = {
  dataset: { pmStart: "3", pmEnd: "6" },
  textContent: "header",
};
const headerAnchor = { dataset: { pmStart: "1", pmEnd: "8" } };
const footerSpan = {
  dataset: { pmStart: "11", pmEnd: "14" },
  textContent: "footer",
};

const createContainer = (): ParentNode =>
  ({
    querySelectorAll(selector: string) {
      switch (selector) {
        case '.layout-page-header[data-rid="rIdH1"] span[data-pm-start][data-pm-end]':
          return [headerSpan];
        case '.layout-page-footer[data-rid="rIdF1"] span[data-pm-start][data-pm-end]':
          return [footerSpan];
        case '.layout-page-header[data-rid="rIdH1"] [data-pm-start]':
          return [headerAnchor, headerSpan];
        default:
          return [];
      }
    },
    querySelector(selector: string) {
      if (
        selector === '.layout-page-header[data-rid="rIdH1"] [data-pm-start="3"]'
      ) {
        return headerSpan;
      }
      return null;
    },
  }) as unknown as ParentNode;

describe("HF slot-scoped PM DOM lookups", () => {
  test("findHfPmSpans returns only the requested header slot's run spans", () => {
    const spans = findHfPmSpans(createContainer(), "header", "rIdH1");
    expect(spans.map((s) => s.textContent.trim())).toEqual(["header"]);
  });

  test("findHfPmSpans returns the requested footer slot's run spans", () => {
    const spans = findHfPmSpans(createContainer(), "footer", "rIdF1");
    expect(spans.map((s) => s.textContent.trim())).toEqual(["footer"]);
  });

  test("findHfPmSpans returns nothing for an unknown rId", () => {
    expect(findHfPmSpans(createContainer(), "header", "missing")).toEqual([]);
  });

  test("findHfPmAnchors enumerates every anchor inside the slot", () => {
    const anchors = findHfPmAnchors(createContainer(), "header", "rIdH1");
    expect(anchors.map((a) => a.dataset["pmStart"])).toEqual(["1", "3"]);
  });

  test("findHfPmAnchor resolves a known pm-start inside the slot", () => {
    const anchor = findHfPmAnchor(createContainer(), "header", "rIdH1", 3);
    expect(anchor?.textContent.trim()).toBe("header");
  });

  test("findHfPmAnchor rejects non-finite positions", () => {
    expect(
      findHfPmAnchor(createContainer(), "header", "rIdH1", Number.NaN),
    ).toBeNull();
  });
});

describe("findHfCaretSpan", () => {
  // The HF caret overlay needs to handle the case where the collapsed
  // selection sits at the end of a run / paragraph (selection.from ==
  // span's data-pm-end). An exact data-pm-start lookup misses it, so
  // findHfCaretSpan walks the slot's spans and reports which edge to
  // hug. (Codex #487 P2 — bot review 20:32.)
  const startSpan = {
    dataset: { pmStart: "3", pmEnd: "6" },
    textContent: "header",
  };
  const endSpan = {
    dataset: { pmStart: "6", pmEnd: "9" },
    textContent: "tail",
  };

  const caretContainer = (): ParentNode =>
    ({
      querySelector(selector: string) {
        if (
          selector ===
          '.layout-page-header[data-rid="rIdH1"] [data-pm-start="3"]'
        ) {
          return startSpan;
        }
        return null;
      },
      querySelectorAll(selector: string) {
        if (
          selector ===
          '.layout-page-header[data-rid="rIdH1"] span[data-pm-start][data-pm-end]'
        ) {
          return [startSpan, endSpan];
        }
        return [];
      },
    }) as unknown as ParentNode;

  test("exact pmStart match hugs the left edge", () => {
    const hit = findHfCaretSpan(caretContainer(), "header", "rIdH1", 3);
    expect(hit?.edge).toBe("left");
    expect(hit?.element).toBe(startSpan as unknown as HTMLElement);
  });

  test("caret at end-of-span (pos == pmEnd) hugs the right edge", () => {
    // pos = 9 — matches endSpan's pmEnd. Exact pmStart lookup returns
    // null (mocked), so we fall back to the range scan.
    const hit = findHfCaretSpan(caretContainer(), "header", "rIdH1", 9);
    expect(hit?.edge).toBe("right");
    expect(hit?.element).toBe(endSpan as unknown as HTMLElement);
  });

  test("range scan falls back to a pmEnd match when exact pmStart misses", () => {
    // pos = 6 — startSpan's pmEnd. Mock the exact lookup to return null
    // so we exercise the range scan; the visible result hugs startSpan's
    // right edge (which is geometrically the same point as endSpan's
    // left edge when the two runs are contiguous).
    const boundaryContainer = (): ParentNode =>
      ({
        querySelector() {
          return null;
        },
        querySelectorAll(selector: string) {
          if (
            selector ===
            '.layout-page-header[data-rid="rIdH1"] span[data-pm-start][data-pm-end]'
          ) {
            return [startSpan, endSpan];
          }
          return [];
        },
      }) as unknown as ParentNode;
    const hit = findHfCaretSpan(boundaryContainer(), "header", "rIdH1", 6);
    expect(hit?.edge).toBe("right");
    expect(hit?.element).toBe(startSpan as unknown as HTMLElement);
  });

  test("returns null when no span covers the position", () => {
    const hit = findHfCaretSpan(caretContainer(), "header", "rIdH1", 99);
    expect(hit).toBeNull();
  });

  test("rejects non-finite positions", () => {
    expect(
      findHfCaretSpan(caretContainer(), "header", "rIdH1", Number.NaN),
    ).toBeNull();
  });
});

describe("findHfSlotForTarget", () => {
  test("returns null for a null target", () => {
    expect(findHfSlotForTarget(null)).toBeNull();
  });

  test("resolves a header target to its rId + kind", () => {
    const headerEl = {
      dataset: { rid: "rIdShared" },
    } as unknown as HTMLElement;
    const target = {
      closest(selector: string) {
        if (selector === ".layout-page-header[data-rid]") {
          return headerEl;
        }
        return null;
      },
    } as unknown as Element;
    const slot = findHfSlotForTarget(target);
    expect(slot).toEqual({
      kind: "header",
      rId: "rIdShared",
      element: headerEl,
    });
  });

  test("resolves a footer target to its rId + kind when no header ancestor", () => {
    const footerEl = {
      dataset: { rid: "rIdFooter" },
    } as unknown as HTMLElement;
    const target = {
      closest(selector: string) {
        if (selector === ".layout-page-footer[data-rid]") {
          return footerEl;
        }
        return null;
      },
    } as unknown as Element;
    const slot = findHfSlotForTarget(target);
    expect(slot).toEqual({
      kind: "footer",
      rId: "rIdFooter",
      element: footerEl,
    });
  });

  test("returns null when the target is outside both HF slots (body click)", () => {
    const target = {
      closest() {
        return null;
      },
    } as unknown as Element;
    expect(findHfSlotForTarget(target)).toBeNull();
  });
});
