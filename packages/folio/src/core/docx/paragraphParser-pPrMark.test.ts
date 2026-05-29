import { describe, expect, test } from "bun:test";

import { parseParagraph } from "./paragraphParser";
import type { XmlElement } from "./xmlParser";
import { parseXmlDocument } from "./xmlParser";

function parseParagraphXml(xml: string) {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
}

describe("parseParagraph — paragraph-mark tracked change (ECMA-376 §17.13.5)", () => {
  test("reads <w:pPr><w:rPr><w:ins/> as pPrMark.kind = 'ins'", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:rPr>
            <w:ins w:id="42" w:author="Alice" w:date="2026-05-01T10:00:00Z"/>
          </w:rPr>
        </w:pPr>
      </w:p>
    `);

    expect(paragraph.pPrMark).toEqual({
      kind: "ins",
      info: { id: 42, author: "Alice", date: "2026-05-01T10:00:00Z" },
    });
  });

  test("reads <w:pPr><w:rPr><w:del/> as pPrMark.kind = 'del'", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:rPr>
            <w:del w:id="7" w:author="Bob" w:date="2026-05-02T11:00:00Z"/>
          </w:rPr>
        </w:pPr>
      </w:p>
    `);

    expect(paragraph.pPrMark).toEqual({
      kind: "del",
      info: { id: 7, author: "Bob", date: "2026-05-02T11:00:00Z" },
    });
  });

  test("leaves pPrMark unset when neither ins nor del is present in rPr", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:rPr><w:b/></w:rPr>
        </w:pPr>
      </w:p>
    `);

    expect(paragraph.pPrMark).toBeUndefined();
  });

  test("ins takes precedence over del when both appear (malformed but defensive)", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:rPr>
            <w:ins w:id="1" w:author="A"/>
            <w:del w:id="2" w:author="B"/>
          </w:rPr>
        </w:pPr>
      </w:p>
    `);

    expect(paragraph.pPrMark?.kind).toBe("ins");
  });

  test("omits w:date when it is absent on the source element", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:rPr>
            <w:ins w:id="3" w:author="Carol"/>
          </w:rPr>
        </w:pPr>
      </w:p>
    `);

    expect(paragraph.pPrMark).toEqual({
      kind: "ins",
      info: { id: 3, author: "Carol" },
    });
  });
});
