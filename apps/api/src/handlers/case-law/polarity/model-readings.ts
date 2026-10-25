import { POLARITY, POLARITY_RULE_KIND } from "./consts";
import type { ClassifiablePolarity } from "./consts";
import { POLARITY_GUIDANCE } from "./guidance";
import type { ValidRuleKindPolarity } from "./rule-engine";

// One choice binds kind, polarity, confidence and evidence to the same reading.
export const POLARITY_READINGS = {
  positive: { kind: POLARITY_RULE_KIND.STANCE, polarity: POLARITY.POSITIVE },
  supportive: {
    kind: POLARITY_RULE_KIND.STANCE,
    polarity: POLARITY.SUPPORTIVE,
  },
  neutral: { kind: POLARITY_RULE_KIND.STANCE, polarity: POLARITY.NEUTRAL },
  negative: { kind: POLARITY_RULE_KIND.STANCE, polarity: POLARITY.NEGATIVE },
  form: { kind: POLARITY_RULE_KIND.FORM, polarity: POLARITY.NEUTRAL },
} as const satisfies Record<
  ClassifiablePolarity | typeof POLARITY_RULE_KIND.FORM,
  ValidRuleKindPolarity
>;

export const MODEL_READING_GUIDANCE = {
  ...POLARITY_GUIDANCE,
  form: "Only citation typography, a reference marker or a procedure label supports the reading; it expresses no treatment. Its polarity is neutral. A bare citation marker does not by itself express support.",
} as const satisfies Record<keyof typeof POLARITY_READINGS, string>;
