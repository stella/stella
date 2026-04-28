import { describe, expect, it } from "bun:test";

import type { AnalysisHeading } from "./types";
import { buildSectionMap } from "./types";

const heading = ({
  annotations = [],
  end = "p4",
  id,
  start = "p0",
}: {
  annotations?: AnalysisHeading["annotations"];
  end?: string;
  id: string;
  start?: string;
}): AnalysisHeading => ({
  id,
  label: id,
  category: "reasoning",
  startAnchorId: start,
  endAnchorId: end,
  annotations,
  children: [],
});

const anchors = Array.from({ length: 8 }, (_, i) => `p${i}`);

describe("buildSectionMap", () => {
  it("does not highlight heading ranges that have no annotation", () => {
    const map = buildSectionMap([heading({ id: "empty" })], anchors);

    expect(map.size).toBe(0);
  });

  it("highlights only annotated ranges", () => {
    const map = buildSectionMap(
      [
        heading({
          id: "reasoning",
          start: "p0",
          end: "p7",
          annotations: [
            {
              id: "annotation-1",
              summary: "Soud posoudil odpovědnost státu.",
              startAnchorId: "p2",
              endAnchorId: "p3",
              textSnippet: "odpovědnost státu",
            },
          ],
        }),
      ],
      anchors,
    );

    expect(map.has("p0")).toBe(false);
    expect(map.get("p2")?.headingId).toBe("annotation-1");
    expect(map.get("p3")?.headingId).toBe("annotation-1");
    expect(map.has("p4")).toBe(false);
  });
});
