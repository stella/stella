import { describe, expect, test } from "bun:test";

import {
  HOUSE_DOCUMENT_XML,
  HOUSE_NUMBERING_XML,
  HOUSE_STYLES_XML,
} from "@/api/lib/house-style/__fixtures__/synthetic-style-set";
import {
  extractStyleCatalogue,
  readStyleDefinitions,
} from "@/api/lib/house-style/catalogue";
import type {
  CatalogueStyle,
  RenameRule,
} from "@/api/lib/house-style/catalogue";

const catalogue = (rename: readonly RenameRule[] = []) =>
  extractStyleCatalogue({
    stylesXml: HOUSE_STYLES_XML,
    numberingXml: HOUSE_NUMBERING_XML,
    documentXml: HOUSE_DOCUMENT_XML,
    rename,
  });

const styleNamed = (id: string): CatalogueStyle => {
  const found = catalogue().styles.find((style) => style.id === id);
  if (found === undefined) {
    throw new Error(`the catalogue carries no style ${id}`);
  }
  return found;
};

describe("a house style's catalogue", () => {
  test("carries the paragraph styles the document uses, most used first", () => {
    const ids = catalogue().styles.map((style) => style.id);
    expect(ids.at(0)).toBe("Heading1Firm");
    expect(ids).toContain("DefinitionFirm");
    expect(ids).toContain("Normal");
  });

  test("leaves out a style nothing uses and a table of contents", () => {
    const ids = catalogue().styles.map((style) => style.id);
    expect(ids).not.toContain("UnusedFirm");
    expect(ids).not.toContain("TOC1");
  });

  test("resolves formatting through the basedOn chain and the defaults", () => {
    expect(styleNamed("Heading1Firm").formatting).toMatchObject({
      bold: true,
      allCaps: true,
      outlineLevel: 0,
      font: "Arial",
      sizePt: 11,
    });
    // Heading 2 turns bold off but keeps the capitals it is based on.
    expect(styleNamed("Heading2Firm").formatting).toMatchObject({
      bold: false,
      allCaps: true,
    });
  });

  test("reads the level a list links to the style, not only an explicit ilvl", () => {
    expect(styleNamed("Heading2Firm").formatting.numbering).toMatchObject({
      level: 1,
      format: "decimal",
      example: "1.1",
    });
  });

  test("renders a level's own number, a letter as a letter", () => {
    expect(styleNamed("Heading1Firm").formatting.numbering?.example).toBe("1.");
    expect(styleNamed("DefinitionFirm").formatting.numbering?.example).toBe(
      "(a)",
    );
  });

  test("keeps a numbered level that prints nothing distinguishable from none", () => {
    expect(styleNamed("Bodytext1Firm").formatting.numbering).toMatchObject({
      format: "none",
      example: "",
    });
    expect(styleNamed("CentredFirm").formatting.numbering).toBeNull();
  });

  test("collects examples of the style as the document uses it", () => {
    expect(styleNamed("Heading1Firm").examples).toEqual([
      "Definitions and interpretation",
      "The facility",
    ]);
  });

  test("counts only paragraphs that carry text", () => {
    expect(styleNamed("Heading1Firm").usageCount).toBe(2);
  });
});

describe("renaming a house style's ids", () => {
  const renamed = catalogue([{ from: "Firm", to: "House" }]);

  test("rewrites ids and display names together", () => {
    const heading = renamed.styles.find(
      (style) => style.id === "Heading1House",
    );
    expect(heading?.name).toBe("Heading 1 House");
    expect(renamed.styles.map((style) => style.id)).not.toContain(
      "Heading1Firm",
    );
  });

  test("keeps the numbering links, so levels still resolve", () => {
    const heading = renamed.styles.find(
      (style) => style.id === "Heading2House",
    );
    expect(heading?.formatting.numbering).toMatchObject({
      level: 1,
      example: "1.1",
    });
  });

  test("rewrites basedOn, so inheritance survives", () => {
    const heading = renamed.styles.find(
      (style) => style.id === "Heading2House",
    );
    expect(heading?.basedOn).toBe("Heading1House");
    expect(heading?.formatting.allCaps).toBe(true);
  });
});

describe("the catalogue hash", () => {
  test("is the same for the same style set", () => {
    expect(catalogue().hash).toBe(catalogue().hash);
  });

  test("changes when a style's formatting changes", () => {
    const changed = extractStyleCatalogue({
      stylesXml: HOUSE_STYLES_XML.replace(
        '<w:sz w:val="32"/>',
        '<w:sz w:val="28"/>',
      ),
      numberingXml: HOUSE_NUMBERING_XML,
      documentXml: HOUSE_DOCUMENT_XML,
    });
    expect(changed.hash).not.toBe(catalogue().hash);
  });

  test("changes under a rename, because the ids a guide names changed", () => {
    expect(catalogue([{ from: "Firm", to: "House" }]).hash).not.toBe(
      catalogue().hash,
    );
  });
});

describe("style definitions", () => {
  test("name the default style a paragraph without a pStyle carries", () => {
    const definitions = readStyleDefinitions({
      stylesXml: HOUSE_STYLES_XML,
      numberingXml: HOUSE_NUMBERING_XML,
    });
    expect(definitions.defaultStyleId).toBe("Normal");
    expect(definitions.byId.get("UnusedFirm")).toBeDefined();
  });

  test("survive a style set with no numbering part", () => {
    const definitions = readStyleDefinitions({
      stylesXml: HOUSE_STYLES_XML,
      numberingXml: null,
    });
    expect(
      definitions.byId.get("Heading1Firm")?.formatting.numbering,
    ).toBeNull();
    expect(definitions.byId.get("Heading1Firm")?.formatting.outlineLevel).toBe(
      0,
    );
  });
});
