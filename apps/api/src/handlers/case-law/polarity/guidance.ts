/**
 * What each polarity means, one entry per value a classifier may return.
 *
 * Shared by every reading tier: the generative prompt lists it, and the
 * System One question offers it as its criteria. Total over
 * `ClassifiablePolarity` by construction, so a new polarity cannot be added
 * to the canonical list without every tier being told what it means. The
 * examples are drawn from the same phrases the seed rules key on, because the
 * tiers label the same corpus and used to disagree: the regex tier has always
 * called "srov." supportive, while the first prompt called it neutral.
 */

import type { ClassifiablePolarity } from "./consts";

export const POLARITY_GUIDANCE = {
  positive: `The court follows, agrees with, applies, or builds on the
  cited decision, and says so. Phrases like "v souladu s", "odkazuje na",
  "jak konstatoval", "following", "in line with", "as held in".`,
  supportive: `The court relies on the cited decision without stating
  agreement outright: a comparison or see-also pointer offered in support
  of what it is saying. Phrases like "srov.", "viz", "obdobně",
  "přiměřeně", "porov.", "pozri", "cf.", "see also".`,
  neutral: `The court names the cited decision without endorsing or
  rejecting it, most often as part of the procedural record. Phrases like
  "proti rozsudku", "vedené u", "veden pod". This is also the answer when
  the excerpt does not settle the question.`,
  negative: `The court distinguishes, overrules, departs from, or
  criticizes the cited decision. Phrases like "na rozdíl od",
  "překonán", "zrušen", "odlišuje se", "overruled", "distinguished".`,
} as const satisfies Record<ClassifiablePolarity, string>;
