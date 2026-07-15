import { describe, expect, test } from "bun:test";

import { createDocx, createEmptyDocument } from "@stll/folio-core/server";

import {
  createStellaStyleEditorPreset,
  applyStyleSetEditorSettings,
  readStyleSetEditorPreset,
} from "@/api/lib/style-set-editor";

describe("style set visual editing", () => {
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
});
