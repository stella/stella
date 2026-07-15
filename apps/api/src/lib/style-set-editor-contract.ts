import { t } from "elysia";
import type { Static } from "elysia";

const fontFamilySchema = t.String({ minLength: 1, maxLength: 128 });
const fontSizeSchema = t.Number({ minimum: 1, maximum: 400 });
const paragraphSpacingSchema = t.Number({ minimum: 0, maximum: 1440 });
const alignmentSchema = t.UnionEnum([
  "preserve",
  "left",
  "center",
  "right",
  "both",
]);

const paragraphStyleSchema = t.Object({
  fontFamily: fontFamilySchema,
  fontSizePt: fontSizeSchema,
  bold: t.Boolean(),
  alignment: alignmentSchema,
  spaceBeforePt: paragraphSpacingSchema,
  spaceAfterPt: paragraphSpacingSchema,
});

const numberedParagraphStyleSchema = t.Composite([
  paragraphStyleSchema,
  t.Object({
    numberingFormat: t.UnionEnum([
      "preserve",
      "decimal",
      "hierarchicalDecimal",
      "lowerLetterParenthetical",
      "lowerRomanParenthetical",
      "upperLetterParenthetical",
      "upperRoman",
    ]),
    indentLeftPt: t.Number({ minimum: 0, maximum: 1440 }),
    hangingPt: t.Number({ minimum: 0, maximum: 1440 }),
  }),
]);

export const styleSetEditorSettingsSchema = t.Object({
  body: t.Object({
    fontFamily: fontFamilySchema,
    fontSizePt: fontSizeSchema,
    alignment: alignmentSchema,
    lineSpacing: t.UnionEnum([
      "preserve",
      "single",
      "onePoint15",
      "onePoint5",
      "double",
    ]),
    spaceAfterPt: paragraphSpacingSchema,
  }),
  title: paragraphStyleSchema,
  level1: numberedParagraphStyleSchema,
  level2: numberedParagraphStyleSchema,
  level3: numberedParagraphStyleSchema,
  numbering: t.Object({ enabled: t.Boolean() }),
  page: t.Object({
    paperSize: t.UnionEnum(["preserve", "a4", "letter", "legal"]),
    orientation: t.UnionEnum(["portrait", "landscape"]),
    marginTopPt: t.Number({ minimum: 0, maximum: 1440 }),
    marginBottomPt: t.Number({ minimum: 0, maximum: 1440 }),
    marginLeftPt: t.Number({ minimum: 0, maximum: 1440 }),
    marginRightPt: t.Number({ minimum: 0, maximum: 1440 }),
  }),
});

export type StyleSetEditorSettings = Static<
  typeof styleSetEditorSettingsSchema
>;

export const createStyleSetFromEditorSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  settings: styleSetEditorSettingsSchema,
});

export const updateStyleSetFromEditorSchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  expectedUpdatedAt: t.String({ format: "date-time" }),
  settings: styleSetEditorSettingsSchema,
});
