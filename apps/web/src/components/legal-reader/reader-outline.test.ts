import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import type { AnchorScrollContainer } from "@/components/legal-reader/reader-outline";
import {
  jumpToAnchor,
  outlineFromHeadings,
  resolveAnchorPct,
} from "@/components/legal-reader/reader-outline";

const inlineText = (text: string) => [{ type: "text" as const, text }];

const heading = ({
  anchorId,
  level,
  lines,
}: {
  anchorId: string;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  lines: string[];
}): Block => ({
  type: "heading",
  id: anchorId,
  anchorId,
  level,
  inlines: lines.flatMap((line, index) =>
    index === 0
      ? inlineText(line)
      : [{ type: "line-break" as const }, ...inlineText(line)],
  ),
  plainText: lines.join("\n"),
});

const paragraph = (anchorId: string): Block => ({
  type: "paragraph",
  id: anchorId,
  anchorId,
  inlines: inlineText("Body text."),
  plainText: "Body text.",
});

// The AST skips levels 3 and 5 on purpose: a real act uses whichever
// containers it has, and the outline has to read as the tiers it actually
// states, not as the six the schema allows.
const blocks: Block[] = [
  heading({
    anchorId: "cast-prvni",
    level: 1,
    lines: ["ČÁST PRVNÍ", "OBECNÁ ČÁST"],
  }),
  heading({ anchorId: "hlava-i", level: 2, lines: ["HLAVA I"] }),
  heading({
    anchorId: "zastoupeni",
    level: 4,
    lines: ["Zastoupení členem domácnosti"],
  }),
  heading({ anchorId: "paragraf-47", level: 6, lines: ["§ 47"] }),
  paragraph("p-1"),
  heading({ anchorId: "paragraf-48", level: 6, lines: ["§ 48"] }),
  heading({ anchorId: "hlava-ii", level: 2, lines: ["HLAVA II"] }),
];

describe("outlineFromHeadings", () => {
  test("includes headings only, keyed by the anchor a jump uses", () => {
    const outline = outlineFromHeadings(blocks);

    expect(outline.map((item) => item.id)).toEqual([
      "cast-prvni",
      "hlava-i",
      "zastoupeni",
      "paragraf-47",
      "paragraf-48",
      "hlava-ii",
    ]);
  });

  test("nests by the tiers the document states, not by the schema's levels", () => {
    const outline = outlineFromHeadings(blocks);

    // Four levels are used (1, 2, 4, 6), so the outline has four tiers and
    // the deepest sits three indents in — not five.
    expect(outline.map((item) => item.level)).toEqual([0, 1, 2, 3, 3, 1]);
  });

  test("leads with the designation and annotates with the title", () => {
    const [part] = outlineFromHeadings(blocks);

    expect(part?.label).toBe("ČÁST PRVNÍ");
    expect(part?.meta).toBe("OBECNÁ ČÁST");
  });

  test("a single-line heading carries no annotation", () => {
    const section = outlineFromHeadings(blocks).find(
      (item) => item.id === "paragraf-47",
    );

    expect(section?.label).toBe("§ 47");
    expect(section?.meta).toBeUndefined();
  });

  test("a document with no headings yields no outline", () => {
    expect(outlineFromHeadings([paragraph("p-1")])).toEqual([]);
  });
});

const rect = (top: number) => ({ top });

const createContainer = (
  tops: Record<string, number>,
): AnchorScrollContainer & { scrolledTo: number | null } => ({
  scrolledTo: null,
  scrollTop: 100,
  scrollHeight: 2000,
  getBoundingClientRect: () => rect(50),
  querySelector: (selector: string) => {
    const top = tops[selector];
    return top === undefined
      ? null
      : { getBoundingClientRect: () => rect(top) };
  },
  scrollTo({ top }) {
    this.scrolledTo = top;
  },
});

describe("anchor jump", () => {
  const stubbed: { name: "window" | "CSS"; descriptor?: PropertyDescriptor }[] =
    [];

  const stub = (name: "window" | "CSS", value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    stubbed.push({ name, ...(descriptor === undefined ? {} : { descriptor }) });
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  };

  beforeEach(() => {
    stub("window", { location: { hash: "" } });
    // Ids in this fixture need no escaping; the identity stub stands in for
    // the browser's `CSS.escape`, which the test runtime does not provide.
    stub("CSS", { escape: (value: string) => value });
  });

  afterEach(() => {
    for (const { name, descriptor } of stubbed.splice(0).toReversed()) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
        continue;
      }
      Object.defineProperty(globalThis, name, descriptor);
    }
  });

  test("puts the anchor in the URL so the jump is a citable address", () => {
    const container = createContainer({ "#paragraf-47": 450 });

    jumpToAnchor("paragraf-47", container);

    expect(window.location.hash).toBe("paragraf-47");
  });

  test("scrolls the container to the block, not to the viewport", () => {
    const container = createContainer({ "#paragraf-47": 450 });

    jumpToAnchor("paragraf-47", container);

    // 450 (block) - 50 (container) + 100 (already scrolled).
    expect(container.scrolledTo).toBe(500);
  });

  test("does nothing when the anchor is not on the page", () => {
    const container = createContainer({});

    jumpToAnchor("paragraf-99", container);

    expect(container.scrolledTo).toBeNull();
    expect(window.location.hash).toBe("");
  });

  test("places a tick at the block's share of the scroll height", () => {
    const container = createContainer({ "#paragraf-47": 450 });

    expect(resolveAnchorPct("paragraf-47", container)).toBe(25);
  });

  test("keeps a tick inside the rail at both ends", () => {
    const container = createContainer({ "#top": -80, "#bottom": 4000 });

    expect(resolveAnchorPct("top", container)).toBe(1);
    expect(resolveAnchorPct("bottom", container)).toBe(99);
  });
});
