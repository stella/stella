import { describe, expect, test } from "bun:test";

import {
  XML_DOCUMENT_TEXT_OVERHEAD,
  xmlDocumentPreviewText,
} from "@/api/lib/files/e-invoice-text";
import { readXmlDocumentText } from "@/api/lib/files/xml-document-text";

const utf8 = (xml: string) => new TextEncoder().encode(xml);

const utf16le = (xml: string) =>
  new Uint8Array([0xff, 0xfe, ...Buffer.from(xml, "utf16le")]);

describe("an XML file's readable text", () => {
  test("mixed content reads in document order", () => {
    const { text } = readXmlDocumentText(
      utf8("<clause>The tenant shall <b>not</b> sublet the flat.</clause>"),
      10_000,
    ).unwrap();
    expect(text).toBe(
      [
        "<clause>",
        "  The tenant shall",
        "  <b>not</b>",
        "  sublet the flat.",
        "</clause>",
      ].join("\n"),
    );
  });

  test("xml:space preserve keeps whitespace, and descendants inherit it", () => {
    const { text } = readXmlDocumentText(
      utf8(
        '<doc xml:space="preserve"><line>a\n  b</line><plain xml:space="default">c\n  d</plain></doc>',
      ),
      10_000,
    ).unwrap();
    expect(text).toContain("<line>a\n  b</line>");
    expect(text).toContain(`<plain xml:space="default">c d</plain>`);
  });

  test("a UTF-16 document the parser refuses is shown in its own encoding", () => {
    const xml =
      '<!DOCTYPE note SYSTEM "note.dtd"><note>Předávací protokol</note>';
    expect(readXmlDocumentText(utf16le(xml), 10_000).unwrap()).toEqual({
      text: xml,
      truncated: false,
    });
  });

  test("bytes holding control characters are not text", () => {
    expect(
      readXmlDocumentText(new Uint8Array([0, 0, 0, 0]), 10_000).isErr(),
    ).toBe(true);
  });

  test("the heading and truncation notice fit the budget they are read for", () => {
    const maxChars = 200;
    const { text, truncated } = readXmlDocumentText(
      utf8(`<note>${"word ".repeat(200)}</note>`),
      maxChars - XML_DOCUMENT_TEXT_OVERHEAD,
    ).unwrap();
    expect(truncated).toBe(true);
    const shown = xmlDocumentPreviewText({ type: "xml", text, truncated });
    expect(shown.length).toBeLessThanOrEqual(maxChars);
    expect(shown).toEndWith("Document text was truncated.");
  });
});
