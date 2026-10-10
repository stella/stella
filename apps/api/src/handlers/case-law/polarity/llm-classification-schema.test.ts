import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  CLASSIFIABLE_POLARITIES,
  POLARITY,
  POLARITY_RULE_KIND,
} from "./consts";
import { classificationSchema } from "./llm-classification-schema";

const fields = { keyPhrase: "reference marker", confidence: 0.9 };

test("every proposed rule declares a kind, and forms express only neutral polarity", () => {
  for (const polarity of CLASSIFIABLE_POLARITIES) {
    expect(
      v.safeParse(classificationSchema, { ...fields, polarity }).success,
    ).toBe(false);
    expect(
      v.safeParse(classificationSchema, {
        ...fields,
        kind: POLARITY_RULE_KIND.STANCE,
        polarity,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(classificationSchema, {
        ...fields,
        kind: POLARITY_RULE_KIND.FORM,
        polarity,
      }).success,
    ).toBe(polarity === POLARITY.NEUTRAL);
  }
});
