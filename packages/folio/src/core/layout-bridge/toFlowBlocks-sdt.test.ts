/**
 * Tests for SDT group tagging in toFlowBlocks.
 *
 * A blockSdt PM node flattens into its child flow blocks, but each child
 * carries an `sdtGroups` projection (outer→inner) so the painter can stamp
 * `data-sdt-*` attributes and the widget layer can find the group.
 */

import { describe, expect, test } from "bun:test";

import { schema } from "../prosemirror/schema";
import { toFlowBlocks } from "./toFlowBlocks";

describe("toFlowBlocks — blockSdt grouping", () => {
  test("flattens block SDT children and tags each with the enclosing SdtGroup", () => {
    const inner = schema.node("paragraph", {}, [schema.text("inside the SDT")]);
    const blockSdt = schema.node(
      "blockSdt",
      {
        sdtType: "richText",
        tag: "effective-date",
        alias: "Effective Date",
      },
      [inner],
    );
    const tail = schema.node("paragraph", {}, [schema.text("after")]);
    const doc = schema.node("doc", null, [blockSdt, tail]);

    const blocks = toFlowBlocks(doc);
    // Two paragraph blocks (the SDT's inner paragraph, then the tail).
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    expect(paragraphs).toHaveLength(2);

    const [first, second] = paragraphs;
    expect(first?.sdtGroups).toBeTruthy();
    expect(first?.sdtGroups?.[0]?.tag).toBe("effective-date");
    expect(first?.sdtGroups?.[0]?.alias).toBe("Effective Date");
    expect(second?.sdtGroups).toBeUndefined();
  });

  test("assigns first/middle/last positions across the SDT's child blocks", () => {
    // Multi-block SDTs should paint chrome as a continuous outline; the
    // innermost SdtGroup on each block carries the position so the painter
    // / CSS can stitch the dashed border across consecutive blocks.
    const sdt = schema.node("blockSdt", { sdtType: "richText", tag: "x" }, [
      schema.node("paragraph", {}, [schema.text("a")]),
      schema.node("paragraph", {}, [schema.text("b")]),
      schema.node("paragraph", {}, [schema.text("c")]),
    ]);
    const blocks = toFlowBlocks(schema.node("doc", null, [sdt]));
    const positions = blocks
      .filter((b) => b.kind === "paragraph")
      .map((b) => b.sdtGroups?.at(-1)?.position);
    expect(positions).toEqual(["first", "middle", "last"]);
  });

  test("a single-block SDT marks the only block as `only`", () => {
    const sdt = schema.node("blockSdt", { sdtType: "richText", tag: "y" }, [
      schema.node("paragraph", {}, [schema.text("solo")]),
    ]);
    const blocks = toFlowBlocks(schema.node("doc", null, [sdt]));
    const innermost = blocks
      .filter((b) => b.kind === "paragraph")
      .map((b) => b.sdtGroups?.at(-1)?.position);
    expect(innermost).toEqual(["only"]);
  });

  test("outer SDT does not overwrite inner SDT's first/middle/last", () => {
    // Outer SDT has `[pre, inner SDT containing two paragraphs, post]`.
    // The outer's position-stamping pass must update ITS own group
    // entry, not the innermost (which is the inner SDT for the two
    // inner-SDT blocks). The inner SDT's paragraphs should keep their
    // first/last; the outer entry on those same blocks should report
    // their position within the outer sequence (middle).
    const inner = schema.node("blockSdt", { sdtType: "richText", tag: "in" }, [
      schema.node("paragraph", {}, [schema.text("inner first")]),
      schema.node("paragraph", {}, [schema.text("inner last")]),
    ]);
    const outer = schema.node("blockSdt", { sdtType: "richText", tag: "out" }, [
      schema.node("paragraph", {}, [schema.text("pre")]),
      inner,
      schema.node("paragraph", {}, [schema.text("post")]),
    ]);
    const doc = schema.node("doc", null, [outer]);
    const blocks = toFlowBlocks(doc);
    const paragraphs = blocks.filter((b) => b.kind === "paragraph");
    // Block order: pre, inner-first, inner-last, post (4 paragraphs).
    expect(paragraphs).toHaveLength(4);

    // For the inner-first / inner-last blocks:
    // - sdtGroups = [outer, inner]
    // - The OUTER entry's position should be "middle" (those blocks
    //   sit between `pre` and `post` in the outer sequence)
    // - The INNER entry's position should be "first" / "last"
    const innerFirst = paragraphs[1];
    const innerLast = paragraphs[2];
    expect(innerFirst?.sdtGroups?.[0]?.tag).toBe("out");
    expect(innerFirst?.sdtGroups?.[0]?.position).toBe("middle");
    expect(innerFirst?.sdtGroups?.[1]?.tag).toBe("in");
    expect(innerFirst?.sdtGroups?.[1]?.position).toBe("first");
    expect(innerLast?.sdtGroups?.[0]?.position).toBe("middle");
    expect(innerLast?.sdtGroups?.[1]?.position).toBe("last");
  });

  test("nested block SDTs produce an outer→inner stack on the inner paragraph", () => {
    const innerPara = schema.node("paragraph", {}, [schema.text("nested")]);
    const innerSdt = schema.node("blockSdt", { tag: "inner" }, [innerPara]);
    const outerSdt = schema.node("blockSdt", { tag: "outer" }, [innerSdt]);
    const doc = schema.node("doc", null, [outerSdt]);

    const blocks = toFlowBlocks(doc);
    const paragraph = blocks.find((b) => b.kind === "paragraph");
    expect(paragraph?.sdtGroups?.map((g) => g.tag)).toEqual(["outer", "inner"]);
  });
});
