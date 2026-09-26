import { describe, expect, test } from "bun:test";

import { encodeText } from "./charsets.js";
import { decodeDeclared } from "./declared-charset.js";
import { UDHR_ARTICLE_1 } from "./udhr-article-1.fixture.js";

const windows1250 = (text: string): Uint8Array => {
  const bytes = encodeText(text, "windows-1250");
  if (bytes === null) {
    throw new Error("the fixture is writable in windows-1250");
  }
  return bytes;
};

const SENTENCE = UDHR_ARTICLE_1.sk;

describe("bytes read as the charset they declare", () => {
  test("an XML declaration in the document", () => {
    const xhtml = `<?xml version="1.0" encoding="windows-1250"?><html><body><p>${SENTENCE}</p></body></html>`;
    const decoded = decodeDeclared(windows1250(xhtml), { contentType: null });
    expect(decoded).toEqual({
      text: xhtml,
      charset: "windows-1250",
      source: "document",
    });
    // What reading the same bytes as UTF-8 does instead.
    expect(new TextDecoder().decode(windows1250(xhtml))).toContain("�");
  });

  test("a meta charset in the document", () => {
    const html = `<html><head><meta charset="windows-1250"></head><body>${SENTENCE}</body></html>`;
    expect(decodeDeclared(windows1250(html), { contentType: null }).text).toBe(
      html,
    );
  });

  test("a meta http-equiv in the document", () => {
    const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1250"></head><body>${SENTENCE}</body></html>`;
    expect(decodeDeclared(windows1250(html), { contentType: null }).text).toBe(
      html,
    );
  });

  test("the HTTP charset outranks the document's", () => {
    const html = `<html><head><meta charset="utf-8"></head><body>${SENTENCE}</body></html>`;
    expect(
      decodeDeclared(windows1250(html), {
        contentType: "text/html; charset=Windows-1250",
      }),
    ).toEqual({ text: html, charset: "windows-1250", source: "http" });
  });

  test("a byte-order mark outranks both", () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(SENTENCE),
    ]);
    expect(
      decodeDeclared(bytes, { contentType: "text/html; charset=windows-1250" }),
    ).toEqual({ text: SENTENCE, charset: "utf-8", source: "bom" });
  });

  test("an HTTP charset of UTF-16 needs no byte-order mark", () => {
    for (const [label, encode] of [
      ["utf-16le", (text: string) => Buffer.from(text, "utf16le")],
      ["utf-16be", (text: string) => Buffer.from(text, "utf16le").swap16()],
      ["utf-16", (text: string) => Buffer.from(text, "utf16le")],
    ] as const) {
      const html = `<p>${SENTENCE}</p>`;
      expect(
        decodeDeclared(encode(html), {
          contentType: `text/html; charset=${label}`,
        }),
      ).toEqual({
        text: html,
        charset: label === "utf-16be" ? "utf-16be" : "utf-16le",
        source: "http",
      });
    }
  });

  test("a document that declares UTF-16 in ASCII bytes reads as UTF-8", () => {
    const html = `<meta charset="utf-16"><p>${SENTENCE}</p>`;
    expect(
      decodeDeclared(new TextEncoder().encode(html), { contentType: null }),
    ).toEqual({ text: html, charset: "utf-8", source: "document" });
  });

  test("nothing declared, or a label the platform does not know, reads as UTF-8", () => {
    const bytes = new TextEncoder().encode(`<p>${SENTENCE}</p>`);
    expect(
      decodeDeclared(bytes, { contentType: "text/html; charset=x-unknown" }),
    ).toEqual({
      text: `<p>${SENTENCE}</p>`,
      charset: "utf-8",
      source: "default",
    });
  });
});
