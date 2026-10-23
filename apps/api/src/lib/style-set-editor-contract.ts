import * as v from "valibot";

import { resourceIdSchema } from "@/api/lib/custom-schema";
import { expectedUpdatedAtSchema } from "@/api/lib/optimistic-concurrency";

const fontFamilySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const fontSizeSchema = v.pipe(
  v.number(),
  v.minValue(1),
  v.maxValue(400),
  v.multipleOf(0.5),
);
const paragraphSpacingSchema = v.pipe(
  v.number(),
  v.minValue(0),
  v.maxValue(1440),
);
const alignmentSchema = v.picklist([
  "preserve",
  "left",
  "center",
  "right",
  "both",
]);

const paragraphStyleSchema = v.object({
  fontFamily: fontFamilySchema,
  fontSizePt: fontSizeSchema,
  bold: v.boolean(),
  alignment: alignmentSchema,
  spaceBeforePt: paragraphSpacingSchema,
  spaceAfterPt: paragraphSpacingSchema,
});

const numberedParagraphStyleSchema = v.intersect([
  paragraphStyleSchema,
  v.object({
    numberingFormat: v.picklist([
      "preserve",
      "decimal",
      "hierarchicalDecimal",
      "lowerLetterParenthetical",
      "lowerRomanParenthetical",
      "upperLetterParenthetical",
      "upperRoman",
    ]),
    indentLeftPt: v.pipe(v.number(), v.minValue(0), v.maxValue(1440)),
    hangingPt: v.pipe(v.number(), v.minValue(0), v.maxValue(1440)),
  }),
]);

export const styleSetEditorSettingsSchema = v.object({
  body: v.object({
    fontFamily: fontFamilySchema,
    fontSizePt: fontSizeSchema,
    alignment: alignmentSchema,
    lineSpacing: v.picklist([
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
  numbering: v.object({ enabled: v.boolean() }),
  page: v.object({
    paperSize: v.picklist(["preserve", "a4", "letter", "legal"]),
    orientation: v.picklist(["portrait", "landscape"]),
    marginTopPt: v.pipe(v.number(), v.minValue(0), v.maxValue(1440)),
    marginBottomPt: v.pipe(v.number(), v.minValue(0), v.maxValue(1440)),
    marginLeftPt: v.pipe(v.number(), v.minValue(0), v.maxValue(1440)),
    marginRightPt: v.pipe(v.number(), v.minValue(0), v.maxValue(1440)),
  }),
});

export type StyleSetEditorSettings = v.InferOutput<
  typeof styleSetEditorSettingsSchema
>;

export const createStyleSetFromEditorSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  settings: styleSetEditorSettingsSchema,
});

export const updateStyleSetFromEditorSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  expectedUpdatedAt: expectedUpdatedAtSchema,
  settings: styleSetEditorSettingsSchema,
});

const previewTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(2000));
const styleSetPreviewContentSchema = v.object({
  title: previewTextSchema,
  introduction: previewTextSchema,
  investmentHeading: previewTextSchema,
  investmentBody: previewTextSchema,
  equityFinancingHeading: previewTextSchema,
  equityFinancingBody: previewTextSchema,
  conversionPriceHeading: previewTextSchema,
  conversionPriceBody: previewTextSchema,
  shareClassHeading: previewTextSchema,
  shareClassBody: previewTextSchema,
  liquidityEventHeading: previewTextSchema,
  liquidityEventBody: previewTextSchema,
  companyRepresentationsHeading: previewTextSchema,
  companyRepresentationsBody: previewTextSchema,
  generalHeading: previewTextSchema,
  generalBody: previewTextSchema,
});

const styleSetPreviewRequestProperties = {
  settings: styleSetEditorSettingsSchema,
  content: styleSetPreviewContentSchema,
};

export const styleSetPreviewFromEditorSchema = v.union([
  v.object({ ...styleSetPreviewRequestProperties, type: v.literal("stella") }),
  v.object({
    ...styleSetPreviewRequestProperties,
    type: v.literal("saved"),
    styleSetId: resourceIdSchema("styleSet"),
  }),
]);

export type StyleSetPreviewContent = v.InferOutput<
  typeof styleSetPreviewContentSchema
>;
