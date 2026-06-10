import { describe, expect, test } from "bun:test";

import { parseStyleDefinitions, parseStyles } from "./styleParser";

const STYLES_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe("docDefaults presence (#909)", () => {
  test("an empty but present docDefaults parses to a defined object", () => {
    // Lets the resolver tell "document declares empty defaults" (zero spacing)
    // apart from "no docDefaults at all", so it does not synthesize the
    // built-in Normal spacing over an explicitly-empty default.
    const defs = parseStyleDefinitions(
      `<w:styles ${STYLES_NS}>
        <w:docDefaults><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>
      </w:styles>`,
      null,
    );
    expect(defs.docDefaults).toBeDefined();
  });

  test("a document with no docDefaults element leaves docDefaults undefined", () => {
    const defs = parseStyleDefinitions(
      `<w:styles ${STYLES_NS}></w:styles>`,
      null,
    );
    expect(defs.docDefaults).toBeUndefined();
  });
});

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

describe("style inheritance cycles", () => {
  test("basedOn cycle terminates and merges both styles' properties", () => {
    const styles = parseStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="character" w:styleId="CycleA">
          <w:name w:val="Cycle A"/>
          <w:basedOn w:val="CycleB"/>
          <w:rPr><w:b/></w:rPr>
        </w:style>
        <w:style w:type="character" w:styleId="CycleB">
          <w:name w:val="Cycle B"/>
          <w:basedOn w:val="CycleA"/>
          <w:rPr><w:i/></w:rPr>
        </w:style>
      </w:styles>`,
      null,
    );

    const cycleA = styles.get("CycleA");
    expect(cycleA?.rPr?.bold).toBe(true);
    expect(cycleA?.rPr?.italic).toBe(true);
    // The cycle guard stops the second visit, so CycleB's own italic must
    // still be present after merging with CycleA.
    const cycleB = styles.get("CycleB");
    expect(cycleB?.rPr?.italic).toBe(true);
  });

  test("self-referential basedOn terminates", () => {
    const styles = parseStyles(
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:style w:type="paragraph" w:styleId="Selfish">
          <w:name w:val="Selfish"/>
          <w:basedOn w:val="Selfish"/>
          <w:rPr><w:b/></w:rPr>
        </w:style>
      </w:styles>`,
      null,
    );

    expect(styles.get("Selfish")?.rPr?.bold).toBe(true);
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
