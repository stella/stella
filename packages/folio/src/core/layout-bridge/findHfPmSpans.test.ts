import { describe, expect, test } from "bun:test";

import {
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
