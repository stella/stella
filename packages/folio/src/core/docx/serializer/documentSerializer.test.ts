import { describe, expect, test } from "bun:test";

import { createEmptyDocument } from "../../utils/createDocument";
import { serializeDocument } from "./documentSerializer";

// Issue #417 (eigenpal): integer-typed twip attributes (page size, margins,
// columns, borders, line numbers) must never appear as fractional values in
// the XML, or Microsoft Word rejects the file as corrupt. Callers commonly
// compute twips as `inches * 1440`, which produces drift like
// `0.7 * 1440 === 1008.0000000000001`.
const ANY_DECIMAL_IN_TWIPS_ATTR =
  /w:(top|right|bottom|left|header|footer|gutter|w|h|sz|space|num|countBy|start|distance)="-?\d+\.\d+"/;

describe("document section properties are integer-only (issue #417)", () => {
  test("createEmptyDocument with fractional inches produces no float twips", () => {
    const doc = createEmptyDocument({
      pageWidth: 8.5 * 1440,
      pageHeight: 11 * 1440,
      marginTop: 0.7 * 1440,
      marginBottom: 0.5 * 1440,
      marginLeft: 1.25 * 1440,
      marginRight: 1.25 * 1440,
    });

    const xml = serializeDocument(doc);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_TWIPS_ATTR);
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"');
    expect(xml).toContain('w:top="1008"');
    expect(xml).toContain('w:bottom="720"');
    expect(xml).toContain('w:left="1800"');
    expect(xml).toContain('w:right="1800"');
  });

  test("serializer-side defense catches drift even if the model carries floats", () => {
    // Bypass the createEmptyDocument input guard by mutating the model
    // directly — proves the serializer's intAttr() defense works on its own.
    const doc = createEmptyDocument();
    const sectionProps = doc.package.document.finalSectionProperties;
    if (!sectionProps) {
      throw new Error("expected finalSectionProperties on empty document");
    }
    sectionProps.marginTop = 1008.000_000_000_000_1;
    sectionProps.marginLeft = 1800.000_000_1;

    const xml = serializeDocument(doc);

    expect(xml).not.toMatch(ANY_DECIMAL_IN_TWIPS_ATTR);
    expect(xml).toContain('w:top="1008"');
    expect(xml).toContain('w:left="1800"');
  });
});
