/**
 * Schema-level tests for the blockSdt PM node.
 */

import { describe, expect, test } from "bun:test";

import { schema } from "../../schema";

describe("blockSdt PM node", () => {
  test("is registered in the schema with isolating + defining semantics", () => {
    const nodeType = schema.nodes["blockSdt"];
    if (!nodeType) {
      throw new Error("blockSdt node not registered");
    }
    expect(nodeType.spec.isolating).toBe(true);
    expect(nodeType.spec.defining).toBe(true);
    expect(nodeType.spec.group).toBe("block");
  });

  test("doc accepts a blockSdt child", () => {
    const para = schema.node("paragraph", {}, [
      schema.text("inside the control"),
    ]);
    const blockSdt = schema.node(
      "blockSdt",
      { tag: "effective-date", sdtType: "richText" },
      [para],
    );
    const doc = schema.node("doc", null, [blockSdt]);
    expect(doc.firstChild?.type.name).toBe("blockSdt");
    expect(doc.firstChild?.firstChild?.type.name).toBe("paragraph");
    expect(doc.firstChild?.attrs["tag"]).toBe("effective-date");
  });

  test("blockSdt can nest another blockSdt", () => {
    const inner = schema.node("blockSdt", { tag: "inner" }, [
      schema.node("paragraph", {}, []),
    ]);
    const outer = schema.node("blockSdt", { tag: "outer" }, [inner]);
    expect(outer.firstChild?.type.name).toBe("blockSdt");
    expect(outer.firstChild?.attrs["tag"]).toBe("inner");
  });

  test("rawPropertiesXml and rawEndPropertiesXml round-trip via attrs", () => {
    const raw = '<w:sdtPr><w:tag w:val="x"/></w:sdtPr>';
    const rawEnd = "<w:sdtEndPr><w:rPr><w:b/></w:rPr></w:sdtEndPr>";
    const blockSdt = schema.node(
      "blockSdt",
      { rawPropertiesXml: raw, rawEndPropertiesXml: rawEnd },
      [schema.node("paragraph", {}, [])],
    );
    expect(blockSdt.attrs["rawPropertiesXml"]).toBe(raw);
    expect(blockSdt.attrs["rawEndPropertiesXml"]).toBe(rawEnd);
  });
});
