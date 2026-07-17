import * as v from "valibot";

const coordinateSchema = v.pipe(v.number(), v.finite());

const boundingBoxesSchema = v.strictObject({
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

export const legalListSourceLocatorSchema = v.variant("type", [
  v.strictObject({ type: v.literal("document") }),
  v.strictObject({
    type: v.literal("docx-block"),
    blockId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
  }),
  v.strictObject({
    type: v.literal("pdf-page"),
    pageNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    boundingBoxes: v.optional(boundingBoxesSchema),
  }),
]);

export const parseLegalListSourceLocator = (input: unknown) =>
  v.safeParse(legalListSourceLocatorSchema, input);
