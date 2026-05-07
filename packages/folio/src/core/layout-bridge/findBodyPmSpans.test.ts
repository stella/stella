import { describe, expect, test } from "bun:test";

import {
  findBodyEmptyRuns,
  findBodyPmAnchor,
  findBodyPmAnchors,
  findBodyPmSpans,
} from "./findBodyPmSpans";

const bodyParagraph = { dataset: { pmStart: "1", pmEnd: "8" } };
const bodySpan = { dataset: { pmStart: "2", pmEnd: "5" }, textContent: "body" };
const bodyEmptyRun = { dataset: { pmStart: "7", pmEnd: "7" } };
const bodyImage = { dataset: { pmStart: "9", pmEnd: "10" } };

const createContainer = (): ParentNode =>
  ({
    querySelectorAll(selector: string) {
      switch (selector) {
        case ".layout-page-content span[data-pm-start][data-pm-end]":
          return [bodySpan];
        case ".layout-page-content .layout-empty-run":
          return [bodyEmptyRun];
        case ".layout-page-content [data-pm-start]":
          return [bodyParagraph, bodySpan, bodyEmptyRun, bodyImage];
        default:
          return [];
      }
    },
    querySelector(selector: string) {
      if (selector === '.layout-page-content [data-pm-start="2"]') {
        return bodySpan;
      }
      return null;
    },
  }) as unknown as ParentNode;

describe("body-scoped PM DOM lookups", () => {
  test("finds only body run spans", () => {
    const spans = findBodyPmSpans(createContainer());

    expect(spans.map((span) => span.textContent?.trim())).toEqual(["body"]);
  });

  test("finds body anchors without matching overlapping header/footer positions", () => {
    const anchors = findBodyPmAnchors(createContainer());

    expect(anchors.map((anchor) => anchor.dataset["pmStart"])).toEqual([
      "1",
      "2",
      "7",
      "9",
    ]);
    expect(findBodyPmAnchor(createContainer(), 2)?.textContent?.trim()).toBe(
      "body",
    );
  });

  test("finds only body empty runs", () => {
    const emptyRuns = findBodyEmptyRuns(createContainer());

    expect(emptyRuns).toHaveLength(1);
    expect(emptyRuns[0]?.dataset["pmStart"]).toBe("7");
  });
});
