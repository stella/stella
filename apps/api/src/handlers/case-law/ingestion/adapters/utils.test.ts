import { describe, expect, test } from "bun:test";

import {
  hashContent,
  parseCeDate,
  stripHtml,
} from "@/api/handlers/case-law/ingestion/adapters/utils";

describe("hashContent", () => {
  test("produces consistent SHA-256 hex", () => {
    const hash = hashContent("hello");
    expect(hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("different input produces different hash", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });
});

describe("stripHtml", () => {
  test("removes simple tags", () => {
    expect(stripHtml("<p>hello</p>")).toBe("hello");
  });

  test("converts <br> to newline", () => {
    expect(stripHtml("a<br>b")).toBe("a\nb");
    expect(stripHtml("a<br/>b")).toBe("a\nb");
    expect(stripHtml("a<br />b")).toBe("a\nb");
  });

  test("decodes HTML entities", () => {
    expect(stripHtml("&amp; &lt; &gt; &nbsp;")).toBe("& < >");
  });

  test("collapses excessive newlines", () => {
    expect(stripHtml("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("handles nested tags", () => {
    expect(stripHtml("<div><span>inner</span> text</div>")).toBe("inner text");
  });
});

describe("parseCeDate", () => {
  test("parses CZ format with spaces", () => {
    expect(parseCeDate("1. 3. 2026")).toBe("2026-03-01");
  });

  test("parses compact format DD.MM.YYYY", () => {
    expect(parseCeDate("01.03.2026")).toBe("2026-03-01");
  });

  test("parses single-digit day and month", () => {
    expect(parseCeDate("1.3.2026")).toBe("2026-03-01");
  });

  test("returns undefined for invalid input", () => {
    expect(parseCeDate("not a date")).toBeUndefined();
    expect(parseCeDate("")).toBeUndefined();
    expect(parseCeDate("2026-03-01")).toBeUndefined();
  });
});
