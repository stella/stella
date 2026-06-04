import { describe, expect, test } from "bun:test";

import type { Document, HeaderFooter, Watermark } from "../types/document";
import {
  ensureWatermarkHeaderCoverage,
  getDocumentWatermark,
  setDocumentWatermark,
} from "./index";

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

  test("creates a default header carrying the watermark when the document has none", () => {
    const doc: Document = { package: { document: { content: [] } } };
    const next = setDocumentWatermark(doc, { kind: "text", text: "DRAFT" });
    const headers = [...(next.package.headers?.values() ?? [])];
    expect(headers).toHaveLength(1);
    expect(headers[0]?.watermark?.kind).toBe("text");
    // The final section references the created default header.
    expect(
      next.package.document.finalSectionProperties?.headerReferences,
    ).toContainEqual({ type: "default", rId: expect.any(String) });
  });

  test("applies a picture watermark to every header as a distinct object", () => {
    // imageRId is scoped to word/_rels/header*.xml.rels. The setter clones
    // the watermark per header; the save-time rebind pass (rezip) then gives
    // each header a relationship to the shared media in its own rels.
    const doc = makeDoc({
      rId1: emptyHeader(),
      rId2: emptyHeader(),
    });
    const next = setDocumentWatermark(doc, {
      kind: "picture",
      imageRId: "rId99",
    });
    const first = next.package.headers?.get("rId1")?.watermark;
    const second = next.package.headers?.get("rId2")?.watermark;
    expect(first?.kind).toBe("picture");
    expect(second?.kind).toBe("picture");
    expect(first).not.toBe(second);
  });

  test("allows a picture watermark on a single-header document", () => {
    const doc = makeDoc({ rId1: emptyHeader() });
    const next = setDocumentWatermark(doc, {
      kind: "picture",
      imageRId: "rId99",
    });
    expect(next.package.headers?.get("rId1")?.watermark?.kind).toBe("picture");
  });

  test("does not mutate the input document", () => {
    const original = makeDoc({ rId1: emptyHeader() });
    const before = original.package.headers?.get("rId1")?.watermark;
    setDocumentWatermark(original, { kind: "text", text: "x" });
    expect(original.package.headers?.get("rId1")?.watermark).toBe(before);
  });
});

describe("ensureWatermarkHeaderCoverage", () => {
  const watermark: Watermark = { kind: "text", text: "CONFIDENTIAL" };

  test("creates a first-page header for a titlePg section that lacks one", () => {
    const doc: Document = {
      package: {
        document: {
          content: [],
          finalSectionProperties: {
            titlePg: true,
            headerReferences: [{ type: "default", rId: "rId1" }],
          },
        },
        headers: new Map([["rId1", { ...emptyHeader(), watermark }]]),
      },
    };

    const next = ensureWatermarkHeaderCoverage(doc, watermark);
    const firstRef =
      next.package.document.finalSectionProperties?.headerReferences?.find(
        (ref) => ref.type === "first",
      );
    expect(firstRef).toBeDefined();
    const firstHeader = firstRef && next.package.headers?.get(firstRef.rId);
    expect(firstHeader?.hdrFtrType).toBe("first");
    expect(firstHeader?.watermark?.kind).toBe("text");
  });

  test("creates an even header when evenAndOddHeaders is set in settings", () => {
    const doc: Document = {
      package: {
        settings: { defaultTabStop: 720, evenAndOddHeaders: true },
        document: {
          content: [],
          finalSectionProperties: {
            headerReferences: [{ type: "default", rId: "rId1" }],
          },
        },
        headers: new Map([["rId1", { ...emptyHeader(), watermark }]]),
      },
    };

    const next = ensureWatermarkHeaderCoverage(doc, watermark);
    const evenRef =
      next.package.document.finalSectionProperties?.headerReferences?.find(
        (ref) => ref.type === "even",
      );
    expect(evenRef).toBeDefined();
    expect(
      evenRef && next.package.headers?.get(evenRef.rId)?.watermark?.kind,
    ).toBe("text");
  });

  test("preserves inheritance: does not create a type that already exists", () => {
    const doc: Document = {
      package: {
        document: {
          content: [],
          finalSectionProperties: {
            titlePg: true,
            headerReferences: [
              { type: "default", rId: "rId1" },
              { type: "first", rId: "rId2" },
            ],
          },
        },
        headers: new Map([
          ["rId1", emptyHeader()],
          ["rId2", { type: "header", hdrFtrType: "first", content: [] }],
        ]),
      },
    };

    const next = ensureWatermarkHeaderCoverage(doc, watermark);
    expect(next).toBe(doc);
    expect(next.package.headers?.size).toBe(2);
  });
});
