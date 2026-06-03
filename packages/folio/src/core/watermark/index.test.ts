import { describe, expect, test } from "bun:test";

import type { Document, HeaderFooter, Watermark } from "../types/document";
import { getDocumentWatermark, setDocumentWatermark } from "./index";

function makeDoc(headers: Record<string, HeaderFooter>): Document {
  return {
    package: {
      document: { content: [] },
      headers: new Map(Object.entries(headers)),
    },
  };
}

function emptyHeader(): HeaderFooter {
  return { type: "header", hdrFtrType: "default", content: [] };
}

describe("getDocumentWatermark", () => {
  test("returns the first header's watermark", () => {
    const watermark: Watermark = { kind: "text", text: "CONFIDENTIAL" };
    const doc = makeDoc({
      rId1: { ...emptyHeader(), watermark },
      rId2: emptyHeader(),
    });
    expect(getDocumentWatermark(doc)).toEqual(watermark);
  });

  test("returns undefined when no header has a watermark", () => {
    const doc = makeDoc({ rId1: emptyHeader(), rId2: emptyHeader() });
    expect(getDocumentWatermark(doc)).toBeUndefined();
  });

  test("returns undefined when the document has no headers", () => {
    const doc: Document = { package: { document: { content: [] } } };
    expect(getDocumentWatermark(doc)).toBeUndefined();
  });
});

describe("setDocumentWatermark", () => {
  test("writes the watermark to every header part", () => {
    const doc = makeDoc({
      rId1: emptyHeader(),
      rId2: emptyHeader(),
      rId3: emptyHeader(),
    });
    const next = setDocumentWatermark(doc, { kind: "text", text: "DRAFT" });
    expect(next.package.headers?.get("rId1")?.watermark?.kind).toBe("text");
    expect(next.package.headers?.get("rId2")?.watermark?.kind).toBe("text");
    expect(next.package.headers?.get("rId3")?.watermark?.kind).toBe("text");
  });

  test("clears captured raw VML so the new watermark takes effect on serialize", () => {
    // A header with a parsed-then-captured raw VML payload should drop
    // it when the model watermark is replaced — otherwise the saved DOCX
    // would replay the original VML instead of the caller's update.
    const doc = makeDoc({
      rId1: {
        ...emptyHeader(),
        watermark: { kind: "text", text: "OLD" },
        rawWatermarkXml: "<w:p><w:r><w:pict>OLD VML</w:pict></w:r></w:p>",
      },
    });
    const next = setDocumentWatermark(doc, { kind: "text", text: "NEW" });
    const header = next.package.headers?.get("rId1");
    expect(header?.watermark?.kind === "text" && header.watermark.text).toBe(
      "NEW",
    );
    expect(header?.rawWatermarkXml).toBeUndefined();
  });

  test("passing undefined removes the watermark from every header", () => {
    const doc = makeDoc({
      rId1: { ...emptyHeader(), watermark: { kind: "text", text: "x" } },
      rId2: { ...emptyHeader(), watermark: { kind: "text", text: "y" } },
    });
    const next = setDocumentWatermark(doc, undefined);
    expect(next.package.headers?.get("rId1")?.watermark).toBeUndefined();
    expect(next.package.headers?.get("rId2")?.watermark).toBeUndefined();
  });

  test("throws when the document has no header parts", () => {
    const doc: Document = { package: { document: { content: [] } } };
    expect(() =>
      setDocumentWatermark(doc, { kind: "text", text: "x" }),
    ).toThrow(TypeError);
  });

  test("does not mutate the input document", () => {
    const original = makeDoc({ rId1: emptyHeader() });
    const before = original.package.headers?.get("rId1")?.watermark;
    setDocumentWatermark(original, { kind: "text", text: "x" });
    expect(original.package.headers?.get("rId1")?.watermark).toBe(before);
  });
});
