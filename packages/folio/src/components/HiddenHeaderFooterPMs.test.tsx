import { describe, expect, test } from "bun:test";

import type { Document, HeaderFooter } from "../core/types/document";
import { enumerateHfSlots } from "./HiddenHeaderFooterPMs";

function hf(kind: "header" | "footer" = "header"): HeaderFooter {
  return {
    type: kind,
    hdrFtrType: "default",
    content: [],
  };
}

function makeDocument(
  headers: Map<string, HeaderFooter> | undefined,
  footers: Map<string, HeaderFooter> | undefined,
): Document {
  return {
    package: {
      document: { content: [], sections: [] },
      ...(headers ? { headers } : {}),
      ...(footers ? { footers } : {}),
    },
  } as unknown as Document;
}

describe("enumerateHfSlots", () => {
  test("returns [] for null document", () => {
    expect(enumerateHfSlots(null)).toEqual([]);
  });

  test("returns [] for document with no headers or footers", () => {
    const doc = makeDocument(undefined, undefined);
    expect(enumerateHfSlots(doc)).toEqual([]);
  });

  test("enumerates each header rId once", () => {
    const headers = new Map<string, HeaderFooter>([
      ["rId1", hf("header")],
      ["rId2", hf("header")],
    ]);
    const slots = enumerateHfSlots(makeDocument(headers, undefined));
    expect(slots).toEqual([
      { rId: "rId1", kind: "header" },
      { rId: "rId2", kind: "header" },
    ]);
  });

  test("enumerates headers and footers together", () => {
    const headers = new Map([["rIdH", hf("header")]]);
    const footers = new Map([["rIdF", hf("footer")]]);
    const slots = enumerateHfSlots(makeDocument(headers, footers));
    expect(slots).toEqual([
      { rId: "rIdH", kind: "header" },
      { rId: "rIdF", kind: "footer" },
    ]);
  });

  test("two sections sharing one header rId share one slot", () => {
    // The package-level Map is the storage. The "shared by rId" pattern
    // (ECMA-376 §17.10.1) means two sections both reference rIdH; the bag
    // still has one entry. Slot enumeration must reflect that.
    const headers = new Map([["rIdH", hf("header")]]);
    const slots = enumerateHfSlots(makeDocument(headers, undefined));
    expect(slots.length).toBe(1);
    expect(slots[0]).toEqual({ rId: "rIdH", kind: "header" });
  });

  test("defensively dedupes an rId that appears in both bags", () => {
    // The OOXML schema keeps header/footer rIds disjoint, but if both bags
    // accidentally registered the same rId we should emit one slot, not two.
    const headers = new Map([["rIdShared", hf("header")]]);
    const footers = new Map([["rIdShared", hf("footer")]]);
    const slots = enumerateHfSlots(makeDocument(headers, footers));
    expect(slots).toEqual([{ rId: "rIdShared", kind: "header" }]);
  });
});
