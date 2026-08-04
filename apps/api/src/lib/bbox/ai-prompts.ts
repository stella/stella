import * as v from "valibot";

// --------------- System prompts ---------------

export const BBOX_SYSTEM_PROMPT =
  "Return the minimum amount of bounding boxes for the user's " +
  "query. Make most of the bounding boxes cover the answer or " +
  "parts of the justification.";

// --------------- Schema context ---------------

const context = {
  bBoxItem: {
    description:
      "Bounding box normalized to a 0-1000 scale, with yMin/xMin the " +
      "top-left corner and yMax/xMax the bottom-right",
    examples: [{ yMin: 120, xMin: 200, yMax: 350, xMax: 800 }],
  },
  bBoxArray: {
    description: "Array of bounding boxes",
  },
};

// --------------- Schema ---------------

// Element schema for the top-level `boxes` array. The object root
// keeps provider strict-response modes away from top-level array
// schemas. Emptiness is checked at the caller boundary.
//
// Four named coordinates rather than a length-4 array: array arity is
// expressible only as `minItems`/`maxItems`, which the
// structured-output projection drops with every other value
// constraint, leaving nothing in the compiled schema to oblige four
// numbers; a shorter or longer array then fails here only once the
// response is complete. `properties` and `required` are shape, so
// they survive the projection and the coordinate count is part of
// what the provider decodes.
const bboxItemSchema = v.pipe(
  v.strictObject({
    yMin: v.number(),
    xMin: v.number(),
    yMax: v.number(),
    xMax: v.number(),
  }),
  v.description(context.bBoxItem.description),
  v.examples(context.bBoxItem.examples),
);

// No lower bound on `boxes`: the projection drops value constraints,
// so `v.minLength(1)` would reach the model as nothing at all and
// could only reject an empty response afterwards, preempting the
// caller's own emptiness check.
export const bboxOutputSchema = v.strictObject({
  boxes: v.pipe(
    v.array(bboxItemSchema),
    v.description(context.bBoxArray.description),
  ),
});

export type BBoxItem = v.InferOutput<typeof bboxItemSchema>;

// --------------- User message templates ---------------

export const buildBBoxUserMessage = ({
  prompt,
  fieldContent,
  justificationText,
}: {
  prompt: string;
  fieldContent: string;
  justificationText: string;
}) =>
  "Analyze this PDF.\n\n" +
  "Return bounding boxes for content matching " +
  "the answer and justification:\n" +
  `Question: ${prompt}\n` +
  `Answer: ${fieldContent}\n` +
  `Justification: ${justificationText}`;
