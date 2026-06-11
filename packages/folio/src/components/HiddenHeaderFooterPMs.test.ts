import { describe, expect, test } from "bun:test";

import type { HeaderFooter } from "../core/types/document";
import { enumerateHfSlotsFromParts } from "./HiddenHeaderFooterPMs";

const headerFooter = (type: HeaderFooter["type"]): HeaderFooter => ({
  type,
  hdrFtrType: "default",
  content: [],
});

describe("enumerateHfSlotsFromParts", () => {
  test("enumerates header slots before footer slots", () => {
    const headers = new Map<string, HeaderFooter>([
      ["rIdHeader", headerFooter("header")],
    ]);
    const footers = new Map<string, HeaderFooter>([
      ["rIdFooter", headerFooter("footer")],
    ]);

    expect(enumerateHfSlotsFromParts({ headers, footers })).toEqual([
      { rId: "rIdHeader", kind: "header" },
      { rId: "rIdFooter", kind: "footer" },
    ]);
  });

  test("dedupes an invalid rId that appears as both header and footer", () => {
    const headers = new Map<string, HeaderFooter>([
      ["rIdShared", headerFooter("header")],
    ]);
    const footers = new Map<string, HeaderFooter>([
      ["rIdShared", headerFooter("footer")],
    ]);

    expect(enumerateHfSlotsFromParts({ headers, footers })).toEqual([
      { rId: "rIdShared", kind: "header" },
    ]);
  });

  test("returns no slots when both maps are absent", () => {
    expect(
      enumerateHfSlotsFromParts({ headers: undefined, footers: undefined }),
    ).toEqual([]);
  });
});
