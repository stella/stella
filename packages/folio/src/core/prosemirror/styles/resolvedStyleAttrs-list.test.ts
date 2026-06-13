import { describe, expect, test } from "bun:test";

import { createNumberingMap, parseNumbering } from "../../docx/numberingParser";
import { listAttrsFromResolvedStyle } from "./resolvedStyleAttrs";

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const MC =
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

// numId 1 -> abstractNum 6 (custom decimalZero4, "[%1]", level ind 360/360)
// numId 2 -> abstractNum 10 (decimal, "[Claim %1]", level ind 360/360)
const NUMBERING_CUSTOM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W} ${MC}>
  <w:abstractNum w:abstractNumId="6">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <mc:AlternateContent>
        <mc:Choice Requires="w14">
          <w:numFmt w:val="custom" w:format="0001, 0002, ..."/>
        </mc:Choice>
        <mc:Fallback><w:numFmt w:val="decimal"/></mc:Fallback>
      </mc:AlternateContent>
      <w:lvlText w:val="[%1]"/>
      <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="10">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="[Claim %1]"/>
      <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="6"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="10"/></w:num>
</w:numbering>`;

describe("listAttrsFromResolvedStyle (#765 applyStyle)", () => {
  const numbering = parseNumbering(NUMBERING_CUSTOM);
  const map = createNumberingMap({
    abstractNums: numbering.definitions.abstractNums,
    nums: numbering.definitions.nums,
  });

  test("projects the style numPr into numPr + marker attrs", () => {
    const attrs = listAttrsFromResolvedStyle(
      { paragraphFormatting: { numPr: { numId: 2 }, indentLeft: 1134 } },
      map,
    );
    expect(attrs).not.toBeNull();
    expect(attrs?.["numPr"]).toEqual({ numId: 2, ilvl: 0 });
    expect(attrs?.["numPrFromStyle"]).toEqual({ numId: 2, ilvl: 0 });
    expect(attrs?.["listMarker"]).toBe("[Claim %1]");
    expect(attrs?.["listNumFmt"]).toBe("decimal");
    expect(attrs?.["listAbstractNumId"]).toBe(10);
    // Style defines its own indent — the level's must not be projected.
    expect(attrs?.["indentLeft"]).toBeUndefined();
  });

  test("projects a custom zero-padded style numbering", () => {
    const attrs = listAttrsFromResolvedStyle(
      { paragraphFormatting: { numPr: { numId: 1 } } },
      map,
    );
    expect(attrs?.["listMarker"]).toBe("[%1]");
    expect(attrs?.["listNumFmt"]).toBe("decimalZero4");
    expect(attrs?.["listLevelNumFmts"]).toEqual(["decimalZero4"]);
  });

  test("falls back to the numbering level indents when the style has none", () => {
    const attrs = listAttrsFromResolvedStyle(
      { paragraphFormatting: { numPr: { numId: 2 } } },
      map,
    );
    expect(attrs?.["indentLeft"]).toBe(360);
    expect(attrs?.["indentFirstLine"]).toBe(-360);
    expect(attrs?.["hangingIndent"]).toBe(true);
  });

  test("returns null for styles without numbering or with numId 0", () => {
    expect(
      listAttrsFromResolvedStyle(
        { paragraphFormatting: { indentLeft: 100 } },
        map,
      ),
    ).toBeNull();
    expect(
      listAttrsFromResolvedStyle(
        { paragraphFormatting: { numPr: { numId: 0 } } },
        map,
      ),
    ).toBeNull();
  });

  test("without numbering definitions returns numPr but null marker attrs", () => {
    const attrs = listAttrsFromResolvedStyle(
      { paragraphFormatting: { numPr: { numId: 2 } } },
      null,
    );
    expect(attrs?.["numPr"]).toEqual({ numId: 2, ilvl: 0 });
    expect(attrs?.["listMarker"]).toBeNull();
  });
});
