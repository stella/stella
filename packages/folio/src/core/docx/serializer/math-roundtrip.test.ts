import { describe, expect, test } from "bun:test";

import { fromProseDoc } from "../../prosemirror/conversion/fromProseDoc";
import { toProseDoc } from "../../prosemirror/conversion/toProseDoc";
import type { Document, Paragraph } from "../../types/document";
import { parseParagraph } from "../paragraphParser";
import { parseXmlDocument } from "../xmlParser";
import { serializeParagraph } from "./paragraphSerializer";

function parseParagraphXml(xml: string): Paragraph {
  const root = parseXmlDocument(xml);
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

/**
 * Math equation round-trip safety. The renderer derives MathML from
 * `ommlXml` only at paint time; the document model must keep the OMML
 * unchanged so save side stays byte-stable for the equation chunk.
 */
describe("math equation round-trip", () => {
  test("preserves inline <m:oMath> through parse → serialize", () => {
    const xml = `
      <w:p ${NS}>
        <m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>
      </w:p>
    `;
    const paragraph = parseParagraphXml(xml);
    expect(paragraph.content[0]?.type).toBe("mathEquation");

    const serialized = serializeParagraph(paragraph);
    expect(serialized).toContain("<m:oMath");
    expect(serialized).toContain("x+1");
    expect(serialized).toContain("</m:oMath>");
  });

  test("preserves <m:oMathPara> display equations", () => {
    const xml = `
      <w:p ${NS}>
        <m:oMathPara>
          <m:oMath><m:r><m:t>n</m:t></m:r></m:oMath>
        </m:oMathPara>
      </w:p>
    `;
    const paragraph = parseParagraphXml(xml);
    const first = paragraph.content[0];
    expect(first?.type).toBe("mathEquation");
    if (first?.type === "mathEquation") {
      expect(first.display).toBe("block");
    }
    const serialized = serializeParagraph(paragraph);
    expect(serialized).toContain("<m:oMathPara");
  });

  test("preserves a fraction structure verbatim", () => {
    const xml = `<w:p ${NS}><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>`;
    const paragraph = parseParagraphXml(xml);
    const first = paragraph.content[0];
    expect(first?.type).toBe("mathEquation");
    const serialized = serializeParagraph(paragraph);
    expect(serialized).toContain("<m:f>");
    expect(serialized).toContain("<m:num>");
    expect(serialized).toContain("<m:den>");
    expect(serialized).toContain("</m:f>");
  });

  test("OMML survives the full ProseMirror round-trip", () => {
    const xml = `<w:p ${NS}><m:oMath><m:r><m:t>a+b</m:t></m:r></m:oMath></w:p>`;
    const paragraph = parseParagraphXml(xml);
    // SAFETY: minimal document shape — `toProseDoc`/`fromProseDoc` only
    // touch `package.document.content` in this test path. Building a full
    // `Document` would obscure what we're actually round-tripping.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const doc = {
      package: {
        document: {
          content: [paragraph],
        },
      },
    } as unknown as Document;

    const pmDoc = toProseDoc(doc);
    const docAgain = fromProseDoc(pmDoc, doc);
    const para2 = docAgain.package.document.content.at(0);
    expect(para2?.type).toBe("paragraph");
    if (para2?.type !== "paragraph") {
      return;
    }
    const mathItem = para2.content.find((c) => c.type === "mathEquation");
    expect(mathItem).toBeDefined();
    if (mathItem?.type === "mathEquation") {
      expect(mathItem.ommlXml).toContain("<m:oMath");
      expect(mathItem.ommlXml).toContain("a+b");
    }
  });
});
