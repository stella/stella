import * as v from "valibot";

import {
  CLASSIFIABLE_POLARITIES,
  POLARITY,
  POLARITY_RULE_KIND,
} from "./consts";

const classificationFields = {
  keyPhrase: v.pipe(v.string(), v.minLength(2), v.maxLength(100)),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
};

export const classificationSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal(POLARITY_RULE_KIND.STANCE),
    polarity: v.picklist(CLASSIFIABLE_POLARITIES),
    ...classificationFields,
  }),
  v.strictObject({
    kind: v.literal(POLARITY_RULE_KIND.FORM),
    polarity: v.literal(POLARITY.NEUTRAL),
    ...classificationFields,
  }),
]);

export type ClassificationResult = v.InferOutput<typeof classificationSchema>;
