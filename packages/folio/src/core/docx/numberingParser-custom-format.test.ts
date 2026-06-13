import { describe, expect, test } from "bun:test";

import { resolveListTemplate } from "../layout-bridge/toFlowBlocks";
import { formatNumber, parseNumbering } from "./numberingParser";

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const MC =
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

// Word emits custom number formats (here: zero-padded to 4 digits) wrapped in
// mc:AlternateContent — the Choice carries the custom format, the Fallback a
// plain decimal for pre-w14 readers. Mirrors the numbering.xml from #765.
const NUMBERING_CUSTOM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W} ${MC}>
  <w:abstractNum w:abstractNumId="6">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <mc:AlternateContent>
        <mc:Choice Requires="w14">
          <w:numFmt w:val="custom" w:format="0001, 0002, 0003, ..."/>
        </mc:Choice>
        <mc:Fallback>
          <w:numFmt w:val="decimal"/>
        </mc:Fallback>
      </mc:AlternateContent>
      <w:lvlText w:val="[%1]"/>
      <w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="6"/></w:num>
</w:numbering>`;

describe("custom numFmt inside mc:AlternateContent (#765)", () => {
  const numbering = parseNumbering(NUMBERING_CUSTOM);

  test('parses w:numFmt val="custom" format="0001, ..." as decimalZero4', () => {
    expect(numbering.getLevel(1, 0)?.numFmt).toBe("decimalZero4");
  });

  test("renders zero-padded markers through the lvlText template", () => {
    expect(resolveListTemplate("[%1]", [1], ["decimalZero4"])).toBe("[0001]");
    expect(resolveListTemplate("[%1]", [12], ["decimalZero4"])).toBe("[0012]");
    expect(resolveListTemplate("[%1]", [12_345], ["decimalZero4"])).toBe(
      "[12345]",
    );
  });

  test("uses the mc:Fallback when the Choice format is not implemented", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W} ${MC}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <mc:AlternateContent>
        <mc:Choice Requires="w16du">
          <w:numFmt w:val="futureFmt"/>
        </mc:Choice>
        <mc:Fallback>
          <w:numFmt w:val="lowerRoman"/>
        </mc:Fallback>
      </mc:AlternateContent>
      <w:lvlText w:val="%1."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    expect(parseNumbering(xml).getLevel(1, 0)?.numFmt).toBe("lowerRoman");
  });

  test("custom 3- and 5-digit pad widths map to decimalZero3/5", () => {
    const xml = (
      format: string,
    ) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W} ${MC}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <mc:AlternateContent>
        <mc:Choice Requires="w14">
          <w:numFmt w:val="custom" w:format="${format}"/>
        </mc:Choice>
        <mc:Fallback><w:numFmt w:val="decimal"/></mc:Fallback>
      </mc:AlternateContent>
      <w:lvlText w:val="%1."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    expect(parseNumbering(xml("001, 002, ...")).getLevel(1, 0)?.numFmt).toBe(
      "decimalZero3",
    );
    expect(parseNumbering(xml("00001, ...")).getLevel(1, 0)?.numFmt).toBe(
      "decimalZero5",
    );
    // 6+ digits clamp to 5.
    expect(parseNumbering(xml("0000001, ...")).getLevel(1, 0)?.numFmt).toBe(
      "decimalZero5",
    );
  });

  test("unrecognized custom format with no fallback falls back to decimal", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W} ${MC}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:numFmt w:val="custom" w:format="ABC, DEF, ..."/>
      <w:lvlText w:val="%1."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
    expect(parseNumbering(xml).getLevel(1, 0)?.numFmt).toBe("decimal");
  });

  test("formatNumber pads the decimalZero family", () => {
    expect(formatNumber(7, "decimalZero")).toBe("07");
    expect(formatNumber(7, "decimalZero3")).toBe("007");
    expect(formatNumber(7, "decimalZero4")).toBe("0007");
    expect(formatNumber(7, "decimalZero5")).toBe("00007");
  });
});
