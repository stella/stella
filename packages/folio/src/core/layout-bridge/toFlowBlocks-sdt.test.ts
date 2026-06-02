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
