import { describe, expect, test } from "bun:test";

import {
  decodeScannedPages,
  dropIndex,
  encodeScannedPages,
  movePage,
  pdfName,
  removePage,
  reviewPages,
  rotatePage,
  rowShift,
  sizeInUnits,
  totalSize,
} from "./scan-pages";

const scanned = (name: string, size = 1000) => ({
  size,
  thumbnailUri: `file:///tmp/document-scans/${name}-thumbnail.jpg`,
  uri: `file:///tmp/document-scans/${name}.jpg`,
});

const PAGES = reviewPages([scanned("a"), scanned("b"), scanned("c")]);
const order = (pages: readonly { key: string }[]) =>
  pages.map((page) => page.key.replace(/^.*\/(\w)\.jpg$/u, "$1")).join("");

describe("the pages a scan hands to its review", () => {
  test("survive the route parameter", () => {
    const pages = [scanned("a", 1200), scanned("b", 800)];
    expect(decodeScannedPages(encodeScannedPages(pages))).toEqual(pages);
  });

  test("read as none when the parameter is missing or not pages", () => {
    expect(decodeScannedPages(undefined)).toEqual([]);
    expect(decodeScannedPages("not json")).toEqual([]);
    expect(decodeScannedPages("[]")).toEqual([]);
    expect(
      decodeScannedPages(
        JSON.stringify([{ ...scanned("a"), uri: "https://example.com/a.jpg" }]),
      ),
    ).toEqual([]);
  });

  test("start upright", () => {
    expect(PAGES.map((page) => page.rotation)).toEqual([0, 0, 0]);
  });
});

describe("reviewing pages", () => {
  test("moves a page down and up", () => {
    expect(order(movePage(PAGES, 0, 2))).toBe("bca");
    expect(order(movePage(PAGES, 2, 0))).toBe("cab");
    expect(order(movePage(PAGES, 1, 1))).toBe("abc");
  });

  test("ignores a move outside the list", () => {
    expect(movePage(PAGES, 3, 0)).toBe(PAGES);
    expect(movePage(PAGES, 0, 3)).toBe(PAGES);
  });

  test("turns one page a quarter clockwise, back round to upright", () => {
    const key = PAGES[1]?.key ?? "";
    let pages = PAGES;
    const seen: number[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      pages = rotatePage(pages, key);
      seen.push(pages[1]?.rotation ?? -1);
    }
    expect(seen).toEqual([90, 180, 270, 0]);
    expect(rotatePage(PAGES, key)[0]?.rotation).toBe(0);
  });

  test("removes a page and adds up the rest", () => {
    const pages = removePage(PAGES, PAGES[0]?.key ?? "");
    expect(order(pages)).toBe("bc");
    expect(totalSize(pages)).toBe(2000);
  });
});

describe("a scan's file name", () => {
  test("is the document's name as a PDF", () => {
    expect(pdfName(" Lease ", "Scan")).toBe("Lease.pdf");
    expect(pdfName("Lease.PDF", "Scan")).toBe("Lease.PDF");
  });

  test("falls back when the name is blank", () => {
    expect(pdfName("  ", "Scan 29 Oct 2026")).toBe("Scan 29 Oct 2026.pdf");
  });
});

describe("a scan's size", () => {
  test("reads in kilobytes under a megabyte, then in megabytes", () => {
    expect(sizeInUnits(0)).toEqual({ unit: "kilobytes", value: 1 });
    expect(sizeInUnits(420_400)).toEqual({ unit: "kilobytes", value: 420 });
    expect(sizeInUnits(1_000_000)).toEqual({ unit: "megabytes", value: 1 });
    expect(sizeInUnits(2_460_000)).toEqual({ unit: "megabytes", value: 2.5 });
  });
});

describe("dragging a page", () => {
  test("lands by whole rows, within the list", () => {
    const at = (dy: number) =>
      dropIndex({ count: 3, dy, from: 1, rowHeight: 100 });
    expect([at(-400), at(-60), at(-40), at(40), at(60), at(400)]).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);
  });

  test("moves the rows it crosses towards where it started", () => {
    const shifts = (drag: { from: number; to: number } | null) =>
      [0, 1, 2, 3].map((index) => rowShift({ drag, index, rowHeight: 100 }));
    expect(shifts(null)).toEqual([0, 0, 0, 0]);
    expect(shifts({ from: 0, to: 2 })).toEqual([0, -100, -100, 0]);
    expect(shifts({ from: 3, to: 1 })).toEqual([0, 100, 100, 0]);
    expect(shifts({ from: 2, to: 2 })).toEqual([0, 0, 0, 0]);
  });
});
