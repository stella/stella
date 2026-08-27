import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import {
  createDocx,
  createEmptyDocument,
  extractDocxText,
} from "@stll/folio-core/server";

import {
  createStellaStyleEditorPreset,
  applyStyleSetEditorSettings,
  readStyleSetEditorPreset,
  createStyleSetEditorPreviewBuffer,
} from "@/api/lib/style-set-editor";
import {
  styleSetEditorSettingsSchema,
  styleSetPreviewFromEditorSchema,
} from "@/api/lib/style-set-editor-contract";
import type { StyleSetPreviewContent } from "@/api/lib/style-set-editor-contract";

const previewContent = {
  title: "SIMPLE AGREEMENT FOR FUTURE EQUITY",
  introduction: "Agreement introduction.",
  investmentHeading: "Investment",
  investmentBody: "Investment terms.",
  equityFinancingHeading: "Equity financing",
  equityFinancingBody: "Equity financing terms.",
  conversionPriceHeading: "Conversion price",
  conversionPriceBody: "Conversion price terms.",
  shareClassHeading: "Share class",
  shareClassBody: "Share class terms.",
  liquidityEventHeading: "Liquidity event",
  liquidityEventBody: "Liquidity event terms.",
  companyRepresentationsHeading: "Company representations",
  companyRepresentationsBody: "Company representation terms.",
  generalHeading: "General",
  generalBody: "General terms.",
} satisfies StyleSetPreviewContent;

describe("style set visual editing", () => {
  test("accepts only font sizes representable as OOXML half-points", () => {
    const { settings } = createStellaStyleEditorPreset();

    expect(Value.Check(styleSetEditorSettingsSchema, settings)).toBe(true);
    expect(
      Value.Check(styleSetEditorSettingsSchema, {
        ...settings,
        body: { ...settings.body, fontSizePt: 10.25 },
      }),
    ).toBe(false);
  });

  test("bounds preview content and requires saved style set identities", () => {
    const { settings } = createStellaStyleEditorPreset();

    expect(
      Value.Check(styleSetPreviewFromEditorSchema, {
        type: "stella",
        settings,
        content: previewContent,
      }),
    ).toBe(true);
    expect(
      Value.Check(styleSetPreviewFromEditorSchema, {
        type: "saved",
        settings,
        content: previewContent,
      }),
    ).toBe(false);
    expect(
      Value.Check(styleSetPreviewFromEditorSchema, {
        type: "stella",
        settings,
        content: { ...previewContent, title: "x".repeat(2001) },
      }),
    ).toBe(false);
  });

  test("round-trips curated settings through the DOCX package", async () => {
    const source = createStellaStyleEditorPreset();
    const editedSettings = structuredClone(source.settings);
    editedSettings.body.fontFamily = "Georgia";
    editedSettings.body.fontSizePt = 11;
    editedSettings.body.lineSpacing = "onePoint15";
    editedSettings.title.fontFamily = "Palatino Linotype";
    editedSettings.level2.bold = false;
    editedSettings.level2.indentLeftPt = editedSettings.level1.indentLeftPt;
    editedSettings.level3.numberingFormat = "lowerRomanParenthetical";
    editedSettings.page.paperSize = "letter";
    editedSettings.page.marginLeftPt = 90;

    const editedPreset = applyStyleSetEditorSettings(
      source.preset,
      "Firm Standard",
      editedSettings,
    );
    const buffer = Buffer.from(
      new Uint8Array(
        await createDocx(createEmptyDocument({ preset: editedPreset })),
      ),
    );
    const reopened = await readStyleSetEditorPreset(buffer, "Firm Standard");

    expect(reopened.settings).toEqual(editedSettings);
    expect(reopened.preset.styleSet.name).toBe("Firm Standard");
    expect(
      reopened.preset.styleSet.fontTable?.fonts.some(
        (font) => font.name === "Palatino Linotype",
      ),
    ).toBe(true);
  });

  test("renders the full preview as a styled Folio document", async () => {
    const source = createStellaStyleEditorPreset();
    const buffer = await createStyleSetEditorPreviewBuffer({
      source: source.preset,
      name: "Preview",
      settings: source.settings,
      content: previewContent,
    });
    const extracted = await extractDocxText(buffer);

    expect(extracted.paragraphs.map(({ text }) => text)).toEqual(
      Object.values(previewContent),
    );
    expect(extracted.paragraphs.map(({ style }) => style)).toEqual([
      "Title",
      "BodyText",
      "ClauseHeading1",
      "BodyText",
      "ClauseParagraph1",
      "BodyText",
      "ClauseParagraph2",
      "BodyText",
      "ClauseParagraph2",
      "BodyText",
      "ClauseParagraph1",
      "BodyText",
      "ClauseHeading1",
      "BodyText",
      "ClauseHeading1",
      "BodyText",
    ]);
  });

  test("preserves source presets and unedited style resources", () => {
    const source = createStellaStyleEditorPreset();
    const original = structuredClone(source.preset);
    const hyperlink = source.preset.styleSet.styles.styles.find(
      (style) => style.styleId === "Hyperlink",
    );

    const edited = applyStyleSetEditorSettings(
      source.preset,
      "Variant",
      source.settings,
    );

    expect(source.preset).toEqual(original);
    expect(
      edited.styleSet.styles.styles.find(
        (style) => style.styleId === "Hyperlink",
      ),
    ).toEqual(hyperlink);
  });

  test("preserves complex-script typography when editing Latin styles", () => {
    const source = createStellaStyleEditorPreset();
    const level1 = source.preset.styleSet.styles.styles.find(
      (style) => style.styleId === "ClauseHeading1",
    );
    if (!level1) {
      throw new Error("Expected clause level 1 style");
    }
    level1.rPr = {
      ...level1.rPr,
      fontFamily: {
        ...level1.rPr?.fontFamily,
        cs: "Noto Naskh Arabic",
      },
      fontSizeCs: 28,
    };

    const edited = applyStyleSetEditorSettings(
      source.preset,
      "Custom",
      source.settings,
    );
    const editedLevel1 = edited.styleSet.styles.styles.find(
      (style) => style.styleId === "ClauseHeading1",
    );

    expect(editedLevel1?.rPr?.fontFamily?.cs).toBe("Noto Naskh Arabic");
    expect(editedLevel1?.rPr?.fontSizeCs).toBe(28);
  });

  test("keeps custom numbering syntax when the editor reports preserve", async () => {
    const source = createStellaStyleEditorPreset();
    const clauseNumbering = source.preset.styleSet.numbering?.abstractNums.find(
      (definition) => definition.abstractNumId === 1,
    );
    const level = clauseNumbering?.levels.find((item) => item.ilvl === 2);
    if (!level) {
      throw new Error("Expected clause level 3");
    }
    level.lvlText = "Article %1, paragraph %3";
    const buffer = Buffer.from(
      new Uint8Array(
        await createDocx(createEmptyDocument({ preset: source.preset })),
      ),
    );
    const reopened = await readStyleSetEditorPreset(buffer, "Custom");
    expect(reopened.settings.level3.numberingFormat).toBe("preserve");
    const projected = applyStyleSetEditorSettings(
      reopened.preset,
      "Custom",
      reopened.settings,
    );
    const projectedLevel = projected.styleSet.numbering?.abstractNums
      .find((definition) => definition.abstractNumId === 1)
      ?.levels.find((item) => item.ilvl === 2);

    expect(projectedLevel?.lvlText).toBe("Article %1, paragraph %3");
  });

  test("preserves unsupported positive first-line numbering indents", async () => {
    const source = createStellaStyleEditorPreset();
    const firstLevel = source.preset.styleSet.numbering?.abstractNums
      .find((definition) => definition.abstractNumId === 1)
      ?.levels.find((item) => item.ilvl === 0);
    if (!firstLevel) {
      throw new Error("Expected clause level 1");
    }
    firstLevel.pPr = {
      ...firstLevel.pPr,
      indentFirstLine: 240,
      hangingIndent: false,
    };
    const buffer = Buffer.from(
      new Uint8Array(
        await createDocx(createEmptyDocument({ preset: source.preset })),
      ),
    );

    const reopened = await readStyleSetEditorPreset(buffer, "Custom");
    const projected = applyStyleSetEditorSettings(
      reopened.preset,
      "Custom",
      reopened.settings,
    );
    const projectedFirstLevel = projected.styleSet.numbering?.abstractNums
      .find((definition) => definition.abstractNumId === 1)
      ?.levels.find((item) => item.ilvl === 0);

    expect(reopened.settings.level1.hangingPt).toBe(0);
    expect(projectedFirstLevel?.pPr?.indentFirstLine).toBe(240);
    expect(projectedFirstLevel?.pPr?.hangingIndent).toBe(false);
  });

  test("projects flagged hanging indents and preserves their semantics", () => {
    const source = createStellaStyleEditorPreset();
    const firstLevel = source.preset.styleSet.numbering?.abstractNums
      .find((definition) => definition.abstractNumId === 1)
      ?.levels.find((item) => item.ilvl === 0);
    if (!firstLevel?.pPr?.hangingIndent || !firstLevel.pPr.indentFirstLine) {
      throw new Error("Expected a positive flagged hanging indent");
    }
    expect(firstLevel.pPr.indentFirstLine).toBeGreaterThan(0);

    const expectedHangingPt = firstLevel.pPr.indentFirstLine / 20;
    expect(source.settings.level1.hangingPt).toBe(expectedHangingPt);

    const projected = applyStyleSetEditorSettings(
      source.preset,
      "Variant",
      source.settings,
    );
    const projectedFirstLevel = projected.styleSet.numbering?.abstractNums
      .find((definition) => definition.abstractNumId === 1)
      ?.levels.find((item) => item.ilvl === 0);

    expect(projectedFirstLevel?.pPr?.hangingIndent).toBe(true);
    expect(Math.abs(projectedFirstLevel?.pPr?.indentFirstLine ?? 0)).toBe(
      firstLevel.pPr.indentFirstLine,
    );
  });

  test("reuses the editor numbering definition after numbering is toggled", () => {
    const source = createStellaStyleEditorPreset();
    const disabledSettings = structuredClone(source.settings);
    disabledSettings.numbering.enabled = false;
    const disabled = applyStyleSetEditorSettings(
      source.preset,
      "Variant",
      disabledSettings,
    );

    const enabledSettings = structuredClone(source.settings);
    const enabled = applyStyleSetEditorSettings(
      disabled,
      "Variant",
      enabledSettings,
    );
    const definitionCount = enabled.styleSet.numbering?.abstractNums.length;
    const disabledAgain = applyStyleSetEditorSettings(
      enabled,
      "Variant",
      disabledSettings,
    );
    const enabledAgain = applyStyleSetEditorSettings(
      disabledAgain,
      "Variant",
      enabledSettings,
    );

    expect(enabledAgain.styleSet.numbering?.abstractNums).toHaveLength(
      definitionCount ?? 0,
    );
  });

  test("restores custom numbering after a disabled package is reopened", async () => {
    const source = createStellaStyleEditorPreset();
    const clauseNumbering = source.preset.styleSet.numbering?.abstractNums.find(
      (definition) => definition.abstractNumId === 1,
    );
    const customLevel = clauseNumbering?.levels.find((item) => item.ilvl === 2);
    if (!customLevel) {
      throw new Error("Expected clause level 3");
    }
    customLevel.lvlText = "Article %1, paragraph %3";

    const customBuffer = Buffer.from(
      new Uint8Array(
        await createDocx(createEmptyDocument({ preset: source.preset })),
      ),
    );
    const custom = await readStyleSetEditorPreset(customBuffer, "Custom");
    const disabledSettings = structuredClone(custom.settings);
    disabledSettings.numbering.enabled = false;
    const disabled = applyStyleSetEditorSettings(
      custom.preset,
      "Custom",
      disabledSettings,
    );
    const disabledBuffer = Buffer.from(
      new Uint8Array(
        await createDocx(createEmptyDocument({ preset: disabled })),
      ),
    );
    const reopened = await readStyleSetEditorPreset(disabledBuffer, "Custom");

    expect(reopened.settings.numbering.enabled).toBe(false);
    expect(reopened.settings.level3.numberingFormat).toBe("preserve");

    const enabledSettings = structuredClone(reopened.settings);
    enabledSettings.numbering.enabled = true;
    const enabled = applyStyleSetEditorSettings(
      reopened.preset,
      "Custom",
      enabledSettings,
    );
    const level1Style = enabled.styleSet.styles.styles.find(
      (style) => style.styleId === "ClauseHeading1",
    );
    const activeNumId = level1Style?.pPr?.numPr?.numId;
    const activeInstance = enabled.styleSet.numbering?.nums.find(
      (instance) => instance.numId === activeNumId,
    );
    const restoredLevel = enabled.styleSet.numbering?.abstractNums
      .find(
        (definition) =>
          definition.abstractNumId === activeInstance?.abstractNumId,
      )
      ?.levels.find((item) => item.ilvl === 2);

    expect(restoredLevel?.lvlText).toBe("Article %1, paragraph %3");
  });

  test("treats an omitted section orientation as portrait", () => {
    const source = createStellaStyleEditorPreset();
    delete source.preset.sectionProperties.orientation;
    const originalWidth = source.preset.sectionProperties.pageWidth;
    const originalHeight = source.preset.sectionProperties.pageHeight;
    const settings = structuredClone(source.settings);
    settings.page.paperSize = "preserve";
    settings.page.orientation = "portrait";

    const edited = applyStyleSetEditorSettings(
      source.preset,
      "Portrait",
      settings,
    );

    expect(edited.sectionProperties.pageWidth).toBe(originalWidth);
    expect(edited.sectionProperties.pageHeight).toBe(originalHeight);
  });

  test("rejects margins that leave no printable page area", () => {
    const source = createStellaStyleEditorPreset();
    const settings = structuredClone(source.settings);
    settings.page.paperSize = "a4";
    settings.page.marginLeftPt = 300;
    settings.page.marginRightPt = 300;

    expect(() =>
      applyStyleSetEditorSettings(source.preset, "Invalid", settings),
    ).toThrow("Page margins must leave a printable area.");
  });
});
