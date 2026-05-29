import { describe, expect, test } from "bun:test";

import type { Paragraph } from "../../types/document";
import { serializeParagraph } from "./paragraphSerializer";

describe("serializeParagraph — paragraph-mark tracked change", () => {
  test("emits <w:ins/> inside <w:rPr> when pPrMark.kind is 'ins'", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      pPrMark: {
        kind: "ins",
        info: { id: 5, author: "Alice", date: "2026-05-01T10:00:00Z" },
      },
      content: [],
    };

    const xml = serializeParagraph(paragraph);

    expect(xml).toContain("<w:pPr>");
    expect(xml).toContain(
      '<w:rPr><w:ins w:id="5" w:author="Alice" w:date="2026-05-01T10:00:00Z"/></w:rPr>',
    );
  });

  test("emits <w:del/> inside <w:rPr> when pPrMark.kind is 'del'", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      pPrMark: {
        kind: "del",
        info: { id: 8, author: "Bob" },
      },
      content: [],
    };

    const xml = serializeParagraph(paragraph);

    expect(xml).toContain('<w:rPr><w:del w:id="8" w:author="Bob"/></w:rPr>');
  });

  test("EG_ParaRPrTrackChanges ordering: pPrMark precedes runProperties inside rPr", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      formatting: {
        runProperties: { bold: true },
      },
      pPrMark: {
        kind: "ins",
        info: { id: 1, author: "Alice" },
      },
      content: [],
    };

    const xml = serializeParagraph(paragraph);

    const rPrMatch = xml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/u);
    expect(rPrMatch).not.toBeNull();
    const inner = rPrMatch?.[1] ?? "";
    const insIdx = inner.indexOf("<w:ins ");
    const boldIdx = inner.indexOf("<w:b/>");
    expect(insIdx).toBeGreaterThanOrEqual(0);
    expect(boldIdx).toBeGreaterThan(insIdx);
  });

  test("escapes special characters in author / date attributes", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      pPrMark: {
        kind: "ins",
        info: { id: 1, author: `O'Brien & "Co"`, date: "2026-05-01T10:00:00Z" },
      },
      content: [],
    };

    const xml = serializeParagraph(paragraph);

    expect(xml).toContain("&apos;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
  });

  test("omits <w:rPr> when no pPrMark, no runProperties, and no specVanish", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      formatting: { alignment: "center" },
      content: [],
    };

    const xml = serializeParagraph(paragraph);

    expect(xml).not.toContain("<w:rPr>");
  });
});
