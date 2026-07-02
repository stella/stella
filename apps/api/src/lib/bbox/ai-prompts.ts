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
      "Bounding box in format [ymin, xmin, ymax, xmax] " +
      "normalized to 0-1000 scale",
    examples: [[120, 200, 350, 800]] satisfies [
      number,
      number,
      number,
      number,
    ][],
  },
  bBoxArray: {
    description: "Array of bounding boxes",
  },
};

// --------------- Schema ---------------

// Element schema for the top-level `boxes` array. The object root
// keeps provider strict-response modes away from top-level array
// schemas. Emptiness is checked at the array schema/caller boundary.
//
// A length-4 array, not `v.tuple`: tuples convert to the array form
// of `items`, which OpenAI strict mode rejects; `v.length(4)`
// converts to `minItems`/`maxItems`, which it accepts. The caller
// narrows validated elements back to the 4-tuple.
export const bboxItemSchema = v.pipe(
  v.array(v.number()),
  v.length(4),
  v.description(context.bBoxItem.description),
  v.examples(context.bBoxItem.examples),
);

export const BBOX_ARRAY_DESCRIPTION = context.bBoxArray.description;

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
