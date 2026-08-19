import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import type { AnchorScrollContainer } from "@/components/legal-reader/reader-outline";
import {
  filterOutlineItems,
  findProvisionAnchorId,
  headingCase,
  jumpToAnchor,
  outlineFromHeadings,
  parseOutlineJump,
  parseProvisionDesignation,
  resolveAnchorPct,
  withProvisionRanges,
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

  test("leads with the designation and annotates with the title, in sentence case", () => {
    const [part] = outlineFromHeadings(blocks);

    expect(part?.label).toBe("Část první");
    expect(part?.title).toBe("Obecná část");
  });

  test("a single-line heading carries no title", () => {
    const section = outlineFromHeadings(blocks).find(
      (item) => item.id === "paragraf-47",
    );

    expect(section?.label).toBe("§ 47");
    expect(section?.title).toBeUndefined();
  });

  test("sentence case keeps Roman numerals and mixed-case headings", () => {
    expect(headingCase("HLAVA II")).toBe("Hlava II");
    expect(headingCase("OBECNÁ ČÁST")).toBe("Obecná část");
    expect(headingCase("Díl 4")).toBe("Díl 4");
    expect(headingCase("§ 47")).toBe("§ 47");
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

const outlineItem = ({
  id,
  label,
  level,
  meta,
  title,
}: {
  id: string;
  label: string;
  level: number;
  meta?: string;
  title?: string;
}) => ({
  id,
  label,
  level,
  ...(meta === undefined ? {} : { meta }),
  ...(title === undefined ? {} : { title }),
});

describe("parseProvisionDesignation", () => {
  test("reads the designation a publisher prints, spacing and all", () => {
    expect(parseProvisionDesignation("§ 265b")).toEqual({
      marker: "§",
      number: "265b",
      unit: "section",
    });
    expect(parseProvisionDesignation("§265")).toEqual({
      marker: "§",
      number: "265",
      unit: "section",
    });
  });

  test("an article is its own unit, however it is spelled", () => {
    expect(parseProvisionDesignation("Čl. 10")?.unit).toBe("article");
    expect(parseProvisionDesignation("cl. 10")?.unit).toBe("article");
    expect(parseProvisionDesignation("Art. 5a")?.unit).toBe("article");
  });

  test("`par.` is the section sign spelled out, not an article", () => {
    expect(parseProvisionDesignation("par. 3")?.unit).toBe("section");
  });

  test("keeps the marker as printed, so a range reads back in its own act", () => {
    expect(parseProvisionDesignation("Čl. 10")?.marker).toBe("Čl.");
  });

  test("a container heading is not a provision", () => {
    expect(parseProvisionDesignation("ČÁST PRVNÍ")).toBeNull();
    expect(parseProvisionDesignation("HLAVA I")).toBeNull();
    expect(
      parseProvisionDesignation("Zastoupení členem domácnosti"),
    ).toBeNull();
    // A designation with no number addresses nothing.
    expect(parseProvisionDesignation("§")).toBeNull();
  });
});

describe("withProvisionRanges", () => {
  const items = [
    outlineItem({ id: "cast-1", label: "ČÁST PRVNÍ", level: 0 }),
    outlineItem({ id: "hlava-1", label: "HLAVA I", level: 1 }),
    outlineItem({ id: "p-976", label: "§ 976", level: 2 }),
    outlineItem({ id: "p-977", label: "§ 977", level: 2 }),
    outlineItem({ id: "p-978", label: "§ 978", level: 2 }),
    outlineItem({ id: "hlava-2", label: "HLAVA II", level: 1 }),
    outlineItem({ id: "p-979", label: "§ 979", level: 2 }),
  ];

  test("states the span of provisions a container holds", () => {
    const [, hlava] = withProvisionRanges(items);

    expect(hlava?.label).toBe("HLAVA I");
    expect(hlava?.meta).toBe("§ 976–978");
  });

  test("a container reaches past its own children to the last provision under it", () => {
    const [cast] = withProvisionRanges(items);

    expect(cast?.label).toBe("ČÁST PRVNÍ");
    expect(cast?.meta).toBe("§ 976–979");
  });

  test("a container holding one provision states it once, not as a range", () => {
    expect(withProvisionRanges(items).at(-2)?.meta).toBe("§ 979");
  });

  test("orders by the act, not by the number, so a suffix stays in place", () => {
    const suffixed = withProvisionRanges([
      outlineItem({ id: "hlava", label: "HLAVA I", level: 0 }),
      outlineItem({ id: "a", label: "§ 265", level: 1 }),
      outlineItem({ id: "b", label: "§ 265a", level: 1 }),
      outlineItem({ id: "c", label: "§ 265b", level: 1 }),
    ]);

    expect(suffixed.at(0)?.meta).toBe("§ 265–265b");
  });

  test("a provision is not a range of itself", () => {
    expect(withProvisionRanges(items).at(2)?.label).toBe("§ 976");
  });

  test("a container numbering both units states the marker at both ends", () => {
    const mixed = withProvisionRanges([
      outlineItem({ id: "hlava", label: "HLAVA I", level: 0 }),
      outlineItem({ id: "p-1", label: "§ 1", level: 1 }),
      outlineItem({ id: "cl-2", label: "Čl. 2", level: 1 }),
    ]);

    // `§ 1–2` would state the article as a section, which it is not.
    expect(mixed.at(0)?.meta).toBe("§ 1–Čl. 2");
  });

  test("a container with no provisions under it is left as the act states it", () => {
    const ranged = withProvisionRanges([
      outlineItem({ id: "cast", label: "ČÁST PRVNÍ", level: 0 }),
      outlineItem({ id: "hlava", label: "HLAVA I", level: 1 }),
    ]);

    expect(ranged.map((item) => item.label)).toEqual(["ČÁST PRVNÍ", "HLAVA I"]);
  });

  test("carries the title through and states the range beside it", () => {
    const [cast] = withProvisionRanges([
      outlineItem({
        id: "cast",
        label: "Část první",
        level: 0,
        title: "Obecná část",
      }),
      outlineItem({ id: "p", label: "§ 1", level: 1 }),
    ]);

    expect(cast?.title).toBe("Obecná část");
    expect(cast?.meta).toBe("§ 1");
  });
});

describe("parseOutlineJump", () => {
  test("an empty field is its own state, not an empty filter", () => {
    expect(parseOutlineJump("   ")).toEqual({ type: "empty" });
  });

  test("a designation is a jump", () => {
    expect(parseOutlineJump("§10")).toEqual({
      number: "10",
      type: "provision",
      unit: "section",
    });
    expect(parseOutlineJump("čl. 10")).toEqual({
      number: "10",
      type: "provision",
      unit: "article",
    });
  });

  test("anything else narrows the outline", () => {
    expect(parseOutlineJump("zastoupení")).toEqual({
      text: "zastoupení",
      type: "filter",
    });
    // A bare number addresses no unit, so it reads as text.
    expect(parseOutlineJump("10")).toEqual({ text: "10", type: "filter" });
  });
});

describe("findProvisionAnchorId", () => {
  const items = [
    outlineItem({ id: "hlava", label: "HLAVA I", level: 0 }),
    outlineItem({ id: "cl-10", label: "Čl. 10", level: 1 }),
    outlineItem({ id: "par-10", label: "§ 10", level: 1 }),
  ];

  test("a section and an article numbered alike are different provisions", () => {
    expect(findProvisionAnchorId(items, parseOutlineJump("§ 10"))).toBe(
      "par-10",
    );
    expect(findProvisionAnchorId(items, parseOutlineJump("čl. 10"))).toBe(
      "cl-10",
    );
  });

  test("an act that has no such provision addresses nothing", () => {
    expect(findProvisionAnchorId(items, parseOutlineJump("§ 99"))).toBeNull();
  });

  test("free text is not an address", () => {
    expect(findProvisionAnchorId(items, parseOutlineJump("hlava"))).toBeNull();
  });
});

describe("filterOutlineItems", () => {
  const items = [
    outlineItem({ id: "cast", label: "ČÁST PRVNÍ", level: 0 }),
    outlineItem({ id: "hlava", label: "HLAVA I", level: 1 }),
    outlineItem({
      id: "zastoupeni",
      label: "Zastoupení členem domácnosti",
      level: 2,
    }),
    outlineItem({ id: "p-47", label: "§ 47", level: 3 }),
    outlineItem({ id: "hlava-2", label: "HLAVA II", level: 1 }),
  ];

  test("an empty field leaves the outline whole", () => {
    expect(filterOutlineItems(items, parseOutlineJump("")).length).toBe(
      items.length,
    );
  });

  test("keeps the chain down to a match, so the tree still nests", () => {
    expect(
      filterOutlineItems(items, parseOutlineJump("domácnosti")).map(
        (item) => item.id,
      ),
    ).toEqual(["cast", "hlava", "zastoupeni"]);
  });

  test("matches across the diacritics a reader may not type", () => {
    // The fixture is accented and the query is not: without the fold this
    // search finds nothing.
    expect(items.some((item) => item.label.includes("Zastoupení"))).toBe(true);
    expect(
      filterOutlineItems(items, parseOutlineJump("zastoupeni")).map(
        (item) => item.id,
      ),
    ).toContain("zastoupeni");
  });

  test("narrows to a designation as well, so the jump target is visible", () => {
    expect(
      filterOutlineItems(items, parseOutlineJump("§ 47")).map(
        (item) => item.id,
      ),
    ).toEqual(["cast", "hlava", "zastoupeni", "p-47"]);
  });

  test("searches the annotation as well as the designation", () => {
    const annotated = [
      outlineItem({
        id: "cast",
        label: "ČÁST PRVNÍ",
        level: 0,
        meta: "OBECNÁ ČÁST",
      }),
    ];

    expect(
      filterOutlineItems(annotated, parseOutlineJump("obecná")).map(
        (item) => item.id,
      ),
    ).toEqual(["cast"]);
  });

  test("a query the act does not state leaves nothing", () => {
    expect(filterOutlineItems(items, parseOutlineJump("zzz"))).toEqual([]);
  });
});
