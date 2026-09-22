/**
 * Collapse the readings of a citation's mentions into the label the row keeps.
 *
 * Pure function — no database or external dependencies.
 */

import {
  POLARITY,
  POLARITY_PRECEDENCE,
} from "@/api/handlers/case-law/polarity/consts";
import type {
  ClassifiablePolarity,
  Polarity,
} from "@/api/handlers/case-law/polarity/consts";

/** Which way a single mention leans towards the decision it names. */
type MentionSide = "departs" | "relies" | "neither";

/**
 * The side each reading is on.
 *
 * Total over the classifier codomain on purpose: a polarity added to it has
 * to say whether it is a departure, reliance, or neither. A `Partial` map
 * would let a new reading default to "neither" and quietly stop producing
 * `mixed` for the citations it appears in.
 */
const MENTION_SIDE = {
  negative: "departs",
  positive: "relies",
  supportive: "relies",
  neutral: "neither",
} as const satisfies Record<ClassifiablePolarity, MentionSide>;

/** Mentions of one cited decision within one citing decision, each read. */
export type MentionPolarities = readonly [
  ClassifiablePolarity,
  ...ClassifiablePolarity[],
];

/**
 * The polarity a citation is stored with, given how each of its mentions was
 * read.
 *
 * A citing decision names the same case several times, and the mentions need
 * not agree: a court recites the line the case belongs to, then departs from
 * it. Reducing that to the most severe reading loses the disagreement, and
 * reducing it to the first loses the departure; `mixed` records both, so the
 * citator can say the citing court did two things rather than pick one.
 *
 * `neutral` does not take a side and cannot create the conflict on its own.
 * Nor can `unknown`: it is not a reading, so it never reaches this function.
 *
 * Without a conflict the answer is the most severe reading, which is what a
 * single-mention citation has always been stored with. Ties are resolved by
 * the order given, so a caller that hands its mentions in the order its own
 * tier ranks them keeps that tier's tiebreak rather than gaining a second one.
 */
export const aggregateMentionPolarities = (
  mentions: MentionPolarities,
): Polarity => {
  const sides = new Set(mentions.map((mention) => MENTION_SIDE[mention]));
  if (sides.has("departs") && sides.has("relies")) {
    return POLARITY.MIXED;
  }

  const [first, ...rest] = mentions;
  let severest = first;
  for (const mention of rest) {
    if (POLARITY_PRECEDENCE[mention] < POLARITY_PRECEDENCE[severest]) {
      severest = mention;
    }
  }

  return severest;
};
