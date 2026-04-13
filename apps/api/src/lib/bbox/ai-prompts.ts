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

export const bboxSchema = v.pipe(
  v.array(
    v.pipe(
      v.tuple([v.number(), v.number(), v.number(), v.number()]),
      v.description(context.bBoxItem.description),
      v.examples(context.bBoxItem.examples),
    ),
  ),
  v.nonEmpty(),
  v.description(context.bBoxArray.description),
);

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
