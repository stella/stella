import { describe, expect, test } from "bun:test";

import type {
  FieldRun,
  FlowBlock,
  PageMargins,
  ParagraphBlock,
  ParagraphFragment,
  Page,
} from "../layout-engine/types";
import {
  buildHeaderFooterFieldValues,
  resolveFieldValues,
} from "./resolveFieldValues";
import type { SharedFieldInputs } from "./resolveFieldValues";

const MARGINS: PageMargins = { top: 96, right: 96, bottom: 96, left: 96 };

const field = (pmStart: number, instruction: string): FieldRun => ({
  kind: "field",
  fieldType: "OTHER",
  instruction,
  pmStart,
  fallback: "?",
});

const para = (id: string, fields: FieldRun[]): ParagraphBlock => ({
  kind: "paragraph",
  id,
  runs: fields,
});

const fragment = (blockId: string): ParagraphFragment => ({
  kind: "paragraph",
  blockId,
  x: 0,
  y: 0,
  width: 600,
  height: 20,
  fromLine: 0,
  toLine: 1,
});

const page = (number: number, blockIds: string[]): Page => ({
  number,
  fragments: blockIds.map(fragment),
  margins: MARGINS,
  size: { w: 816, h: 1056 },
});

const shared = (over: Partial<SharedFieldInputs> = {}): SharedFieldInputs => ({
  totalPages: 4,
  bookmarkPages: new Map(),
  bookmarkText: new Map(),
  seqValues: new Map(),
  sectionPageCounts: new Map(),
  now: new Date(2026, 0, 1),
  ...over,
});

describe("resolveFieldValues", () => {
  test("evaluates each field for the page its block lands on", () => {
    const blocks: FlowBlock[] = [
      para("a", [field(10, "PAGE")]),
      para("b", [field(20, "PAGE"), field(30, "NUMPAGES")]),
    ];
    const pages = [page(1, ["a"]), page(3, ["b"])];

    const { values } = resolveFieldValues(blocks, pages, shared());

    expect(values.get(10)).toBe("1"); // block a on page 1
    expect(values.get(20)).toBe("3"); // block b on page 3
    expect(values.get(30)).toBe("4"); // NUMPAGES = totalPages
  });

  test("resolves PAGEREF and SEQ from the shared inputs", () => {
    const blocks: FlowBlock[] = [
      para("a", [field(10, "PAGEREF _Ref1 \\h"), field(20, "SEQ Figure")]),
    ];
    const pages = [page(1, ["a"])];

    const { values } = resolveFieldValues(
      blocks,
      pages,
      shared({
        bookmarkPages: new Map([["_Ref1", 7]]),
        seqValues: new Map([[20, 3]]),
      }),
    );

    expect(values.get(10)).toBe("7");
    expect(values.get(20)).toBe("3");
  });

  test("a field with no fragment for its block falls back to page 1", () => {
    const blocks: FlowBlock[] = [para("orphan", [field(10, "PAGE")])];
    const { values } = resolveFieldValues(blocks, [], shared());
    expect(values.get(10)).toBe("1");
  });

  test("changed flags whether a resolved value differs from its fallback", () => {
    // fallback "?" (from the helper) != resolved page -> changed.
    const onPage2 = resolveFieldValues(
      [para("a", [field(10, "PAGE")])],
      [page(2, ["a"])],
      shared(),
    );
    expect(onPage2.changed).toBe(true);

    // A field whose fallback already equals the resolved value -> unchanged.
    const matching: FieldRun = {
      kind: "field",
      fieldType: "OTHER",
      instruction: "PAGE",
      pmStart: 10,
      fallback: "2",
    };
    const stable = resolveFieldValues(
      [para("a", [matching])],
      [page(2, ["a"])],
      shared(),
    );
    expect(stable.changed).toBe(false);
  });
});

describe("buildHeaderFooterFieldValues", () => {
  const now = new Date(2026, 0, 1);

  test("reserves page-number fields at the widest page width", () => {
    const blocks: FlowBlock[] = [
      para("p", [
        field(10, "PAGE"),
        field(20, "NUMPAGES"),
        field(30, "SECTIONPAGES"),
      ]),
    ];

    const values = buildHeaderFooterFieldValues(blocks, 42, now);

    // All three reserve the largest page count's width.
    expect(values.get(10)).toBe("42");
    expect(values.get(20)).toBe("42");
    expect(values.get(30)).toBe("42");
  });

  test("applies format switches and ignores non-page-number fields", () => {
    const blocks: FlowBlock[] = [
      para("p", [field(10, "PAGE \\* ROMAN"), field(20, "PAGEREF _x \\h")]),
    ];

    const values = buildHeaderFooterFieldValues(blocks, 4, now);

    expect(values.get(10)).toBe("IV"); // roman of the widest page
    expect(values.has(20)).toBe(false); // PAGEREF resolves per-page at paint
  });
});
