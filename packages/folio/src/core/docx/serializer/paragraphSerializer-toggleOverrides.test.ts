/**
 * Explicit-false paragraph toggle overrides must survive serialization and a
 * full parse -> serialize round-trip. A toggle such as `keepNext` has three
 * states in OOXML: a bare `<w:keepNext/>` (true), `<w:keepNext w:val="0"/>`
 * (explicitly false, overriding an inherited style value), and absence
 * (inherit). The serializer previously emitted the element only when the value
 * was truthy, so an explicit `false` override was dropped on save and the
 * inherited style value silently came back. Port of eigenpal/docx-editor #687,
 * adapted to folio's existing true/false/undefined toggle pattern (mirrors
 * `widowControl` and the run-property serializer).
 */
import { describe, expect, test } from "bun:test";

import type { Paragraph, ParagraphFormatting } from "../../types/document";
import { parseParagraph } from "../paragraphParser";
import type { XmlElement } from "../xmlParser";
import { parseXmlDocument } from "../xmlParser";
import { serializeParagraph } from "./paragraphSerializer";

const BOOLEAN_TOGGLES = [
  "keepNext",
  "keepLines",
  "contextualSpacing",
  "pageBreakBefore",
  "suppressLineNumbers",
  "suppressAutoHyphens",
  "bidi",
] as const satisfies readonly (keyof ParagraphFormatting)[];

type BooleanToggle = (typeof BOOLEAN_TOGGLES)[number];

const TAG: Record<BooleanToggle, string> = {
  keepNext: "w:keepNext",
  keepLines: "w:keepLines",
  contextualSpacing: "w:contextualSpacing",
  pageBreakBefore: "w:pageBreakBefore",
  suppressLineNumbers: "w:suppressLineNumbers",
  suppressAutoHyphens: "w:suppressAutoHyphens",
  bidi: "w:bidi",
};

const paraWith = (field: BooleanToggle, value: boolean): Paragraph => {
  const formatting: ParagraphFormatting = {};
  formatting[field] = value;
  return { type: "paragraph", content: [], formatting };
};

const parseParagraphXml = (xml: string): Paragraph => {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
};

describe("serializeParagraph — explicit-false paragraph toggles (eigenpal #687)", () => {
  for (const field of BOOLEAN_TOGGLES) {
    const tag = TAG[field];

    test(`emits <${tag} w:val="0"/> when ${field} is explicitly false`, () => {
      const xml = serializeParagraph(paraWith(field, false));
      expect(xml).toContain(`<${tag} w:val="0"/>`);
      // The bare (true) form must not also appear.
      expect(xml).not.toContain(`<${tag}/>`);
    });

    test(`emits bare <${tag}/> when ${field} is true`, () => {
      const xml = serializeParagraph(paraWith(field, true));
      expect(xml).toContain(`<${tag}/>`);
      expect(xml).not.toContain(`<${tag} w:val="0"/>`);
    });

    test(`omits <${tag}> entirely when ${field} is absent`, () => {
      const xml = serializeParagraph({ type: "paragraph", content: [] });
      expect(xml).not.toContain(tag);
    });
  }

  test("round-trips every explicit-false toggle through parse -> serialize", () => {
    const paragraph = parseParagraphXml(`
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pPr>
          <w:keepNext w:val="0"/>
          <w:keepLines w:val="0"/>
          <w:pageBreakBefore w:val="0"/>
          <w:suppressLineNumbers w:val="0"/>
          <w:suppressAutoHyphens w:val="0"/>
          <w:bidi w:val="0"/>
          <w:contextualSpacing w:val="0"/>
        </w:pPr>
      </w:p>
    `);

    // The parser must carry explicit false (not collapse it to undefined/true).
    for (const field of BOOLEAN_TOGGLES) {
      expect(paragraph.formatting?.[field]).toBe(false);
    }

    const xml = serializeParagraph(paragraph);
    for (const field of BOOLEAN_TOGGLES) {
      expect(xml).toContain(`<${TAG[field]} w:val="0"/>`);
    }
  });
});
