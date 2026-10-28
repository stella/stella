import * as v from "valibot";

import { READER_ANNOTATION_QUOTE_MAX_LENGTH } from "./legal-reader-annotations";

const coordinateSchema = v.pipe(v.number(), v.finite());
const offsetSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const offsetRangeEntries = {
  start: offsetSchema,
  end: offsetSchema,
};

export const spotBoundingBoxesSchema = v.strictObject({
  version: v.literal(1),
  boxes: v.pipe(
    v.array(
      v.strictObject({
        pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
        yMin: coordinateSchema,
        xMin: coordinateSchema,
        yMax: coordinateSchema,
        xMax: coordinateSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(100),
  ),
});

export const documentSpotTargetSchema = v.strictObject({
  type: v.literal("document"),
});

const docxBlockIdentityEntries = {
  type: v.literal("docx-block"),
  blockId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
};

export const docxBlockSpotTargetSchema = v.union([
  v.strictObject(docxBlockIdentityEntries),
  v.pipe(
    v.strictObject({ ...docxBlockIdentityEntries, ...offsetRangeEntries }),
    v.check(
      ({ start, end }) => start < end,
      "The start offset must be before the end offset",
    ),
  ),
]);

const pdfPageIdentityEntries = {
  type: v.literal("pdf-page"),
  pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  pageTextSha256: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))),
  boundingBoxes: v.optional(spotBoundingBoxesSchema),
};

export const pdfPageSpotTargetSchema = v.union([
  v.strictObject(pdfPageIdentityEntries),
  v.pipe(
    v.strictObject({ ...pdfPageIdentityEntries, ...offsetRangeEntries }),
    v.check(
      ({ start, end }) => start < end,
      "The start offset must be before the end offset",
    ),
  ),
  v.pipe(
    v.strictObject({
      ...pdfPageIdentityEntries,
      startOffset: offsetSchema,
      endOffset: offsetSchema,
    }),
    v.check(
      ({ startOffset, endOffset }) => startOffset < endOffset,
      "The start offset must be before the end offset",
    ),
  ),
]);

export const spotTargetSchema = v.union([
  documentSpotTargetSchema,
  docxBlockSpotTargetSchema,
  pdfPageSpotTargetSchema,
]);

export type SpotTarget = v.InferOutput<typeof spotTargetSchema>;

export const spotSchema = v.strictObject({
  entityId: v.string(),
  fieldId: v.string(),
  target: spotTargetSchema,
  quote: v.nullable(
    v.pipe(v.string(), v.maxLength(READER_ANNOTATION_QUOTE_MAX_LENGTH)),
  ),
});

export type Spot = v.InferOutput<typeof spotSchema>;

export const parseSpotTarget = (input: unknown) =>
  v.safeParse(spotTargetSchema, input);

export const parseSpot = (input: unknown) => v.safeParse(spotSchema, input);
