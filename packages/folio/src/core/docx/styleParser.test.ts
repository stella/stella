import { describe, expect, test } from "bun:test";

import { parseStyles } from "./styleParser";

describe("style table measurements", () => {
  test("defaults missing w:type to dxa", () => {
    const styles = parseStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="table" w:styleId="TableGrid">
          <w:name w:val="Table Grid"/>
          <w:tblPr>
            <w:tblW w:w="5000"/>
          </w:tblPr>
        </w:style>
      </w:styles>`,
      null,
    );

    expect(styles.get("TableGrid")?.tblPr?.width).toEqual({
      type: "dxa",
      value: 5000,
    });
  });
});

describe("style borders", () => {
  test("preserves unknown border styles for fallback rendering", () => {
    const styles = parseStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="BodyText">
          <w:name w:val="Body Text"/>
          <w:pPr>
            <w:pBdr>
              <w:top w:val="dashDotDot" w:sz="8" w:color="FF0000"/>
            </w:pBdr>
          </w:pPr>
        </w:style>
      </w:styles>`,
      null,
    );

    expect(styles.get("BodyText")?.pPr?.borders?.top).toMatchObject({
      color: { rgb: "FF0000" },
      size: 8,
      style: "dashDotDot",
    });
  });
});
