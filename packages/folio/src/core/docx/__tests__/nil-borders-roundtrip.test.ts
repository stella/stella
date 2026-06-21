/**
 * Explicit `nil`/`none` borders must survive serialization (eigenpal/docx-editor#959).
 *
 * `serializeBorder` used to drop any side whose style was `nil`/`none`, treating
 * an explicit "border off" the same as "no border specified". For the common
 * form/layout pattern — a table grid via `w:tblBorders` (`insideH`/`insideV` =
 * `single`) hidden per cell with all-`nil` `w:tcBorders` — the overrides were
 * omitted on save, so each cell re-inherited the table default and the hidden
 * gridlines reappeared as a full grid on reload. The fix emits explicit nil
 * sides as `<w:side w:val="nil"/>` across table, paragraph, and page borders.
 *
 * Also covers two latent parse bugs fixed alongside: table `w:color="auto"`
 * stored as `{auto:true}` (not literal `rgb:"auto"`), and style-defined table
 * borders honouring the RTL `w:start`/`w:end` fallbacks.
 */

import { describe, expect, test } from "bun:test";

import { parseSectionProperties } from "../sectionParser";
import { serializeBorder } from "../serializer/borderSerializer";
import { serializeParagraphFormatting } from "../serializer/paragraphSerializer";
import { serializeSectionProperties } from "../serializer/sectionPropertiesSerializer";
import { serializeTableCellFormatting } from "../serializer/tableSerializer";
import { parseStyles } from "../styleParser";
import { parseTableCellProperties, parseTableProperties } from "../tableParser";
import type { XmlElement } from "../xmlParser";
import { parseXmlDocument } from "../xmlParser";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const parseSectPr = (inner: string) => {
  const node = parseXmlDocument(
    `<w:sectPr ${W_NS}>${inner}</w:sectPr>`,
  ) as XmlElement | null;
  if (!node) {
    throw new Error("Failed to parse sectPr fixture");
  }
  return parseSectionProperties(node);
};

describe("serializeBorder", () => {
  test("emits an explicit nil side instead of dropping it", () => {
    expect(serializeBorder({ style: "nil" }, "top")).toBe(
      '<w:top w:val="nil"/>',
    );
    expect(serializeBorder({ style: "none" }, "bottom")).toBe(
      '<w:bottom w:val="none"/>',
    );
  });

  test("serializes a normal border with size, space, and color", () => {
    expect(
      serializeBorder(
        { style: "single", size: 4, space: 24, color: { rgb: "FF0000" } },
        "top",
      ),
    ).toBe('<w:top w:val="single" w:sz="4" w:space="24" w:color="FF0000"/>');
  });

  test("emits auto color", () => {
    expect(
      serializeBorder({ style: "single", color: { auto: true } }, "left"),
    ).toBe('<w:left w:val="single" w:color="auto"/>');
  });

  test("preserves custom page-border art relationship ids", () => {
    expect(
      serializeBorder({ style: "single", artRelationshipId: "rId7" }, "top"),
    ).toContain('w:id="rId7"');
  });

  test("escapes untrusted style/color so a crafted value cannot inject markup", () => {
    const out = serializeBorder(
      { style: 'single"/><w:evil', color: { rgb: 'x"/>' } },
      "top",
    );
    expect(out).not.toContain('"/><w:evil');
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;w:evil");
  });

  test("returns empty string for an absent border", () => {
    expect(serializeBorder(undefined, "top")).toBe("");
  });
});

describe("table cell nil borders (#947 form pattern)", () => {
  test("all-nil tcBorders are written, not dropped", () => {
    const xml = serializeTableCellFormatting({
      borders: {
        top: { style: "nil" },
        left: { style: "nil" },
        bottom: { style: "nil" },
        right: { style: "nil" },
      },
    });
    expect(xml).toContain("<w:tcBorders>");
    expect(xml).toContain('<w:top w:val="nil"/>');
    expect(xml).toContain('<w:left w:val="nil"/>');
    expect(xml).toContain('<w:bottom w:val="nil"/>');
    expect(xml).toContain('<w:right w:val="nil"/>');
  });

  test("nil cell borders round-trip through parse → serialize", () => {
    const tcPr = parseXmlDocument(
      `<w:tcPr ${W_NS}><w:tcBorders><w:top w:val="nil"/><w:bottom w:val="nil"/></w:tcBorders></w:tcPr>`,
    ) as XmlElement | null;
    const formatting = parseTableCellProperties(tcPr);
    expect(formatting?.borders?.top?.style).toBe("nil");

    const out = serializeTableCellFormatting(formatting);
    expect(out).toContain('<w:top w:val="nil"/>');
    expect(out).toContain('<w:bottom w:val="nil"/>');
  });

  test("mixed sides keep both the visible and the nil override", () => {
    const xml = serializeTableCellFormatting({
      borders: {
        top: { style: "single", size: 4 },
        bottom: { style: "nil" },
      },
    });
    expect(xml).toContain('<w:top w:val="single"');
    expect(xml).toContain('<w:bottom w:val="nil"/>');
  });

  test("does not emit tcBorders when none are set", () => {
    expect(serializeTableCellFormatting({})).not.toContain("<w:tcBorders");
  });
});

describe("paragraph nil borders", () => {
  test("explicit nil paragraph border is written", () => {
    const xml = serializeParagraphFormatting({
      borders: { bottom: { style: "nil" } },
    });
    expect(xml).toContain("<w:pBdr>");
    expect(xml).toContain('<w:bottom w:val="nil"/>');
  });

  test("does not emit pBdr when no borders are set", () => {
    expect(serializeParagraphFormatting({})).not.toContain("<w:pBdr");
  });
});

describe("page (section) nil borders", () => {
  test("explicit nil page border round-trips through parse → serialize", () => {
    const section = parseSectPr(
      '<w:pgBorders><w:top w:val="nil"/><w:bottom w:val="single" w:sz="4" w:space="24" w:color="000000"/></w:pgBorders>',
    );
    expect(section.pageBorders?.top?.style).toBe("nil");

    const out = serializeSectionProperties(section);
    expect(out).toContain('<w:top w:val="nil"/>');
    expect(out).toContain('<w:bottom w:val="single"');
  });
});

describe("table border parse fixes", () => {
  test('w:color="auto" is parsed as {auto:true}, not rgb:"auto"', () => {
    const tblPr = parseXmlDocument(
      `<w:tblPr ${W_NS}><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr>`,
    ) as XmlElement | null;
    const formatting = parseTableProperties(tblPr);
    expect(formatting?.borders?.top?.color).toEqual({ auto: true });
  });

  test("style-defined table borders honour the RTL w:start/w:end fallback", () => {
    const styleMap = parseStyles(
      `<w:styles ${W_NS}>
        <w:style w:type="table" w:styleId="RtlGrid">
          <w:name w:val="Rtl Grid"/>
          <w:tblPr>
            <w:tblBorders>
              <w:start w:val="single" w:sz="4"/>
              <w:end w:val="dashed" w:sz="6"/>
            </w:tblBorders>
          </w:tblPr>
        </w:style>
      </w:styles>`,
      null,
    );
    const style = styleMap.get("RtlGrid");
    expect(style?.tblPr?.borders?.left?.style).toBe("single");
    expect(style?.tblPr?.borders?.right?.style).toBe("dashed");
  });
});
