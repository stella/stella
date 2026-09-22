import { describe, expect, test } from "bun:test";

import { aggregateMentionPolarities } from "@/api/handlers/case-law/polarity/aggregate";
import type { MentionPolarities } from "@/api/handlers/case-law/polarity/aggregate";
import {
  CLASSIFIABLE_POLARITIES,
  POLARITIES,
  POLARITY,
  POLARITY_PRECEDENCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";

/**
 * Every way up to `size` mentions of one cited decision can be read, so the
 * rule is exercised over its whole input class rather than over the cases
 * someone thought of. Four classifiable readings: 4 + 16 + 64 citations.
 */
const readings = (size: number): MentionPolarities[] => {
  if (size <= 1) {
    return CLASSIFIABLE_POLARITIES.map((polarity): MentionPolarities => [
      polarity,
    ]);
  }
  return readings(size - 1).flatMap((rest) =>
    CLASSIFIABLE_POLARITIES.map((polarity): MentionPolarities => [
      polarity,
      ...rest,
    ]),
  );
};

const ALL_READINGS = [...readings(1), ...readings(2), ...readings(3)];

describe("aggregating the readings of a citation's mentions", () => {
  test("answers `mixed` exactly when a departure meets a reliance", () => {
    for (const mentions of ALL_READINGS) {
      const departs = mentions.includes(POLARITY.NEGATIVE);
      const relies =
        mentions.includes(POLARITY.POSITIVE) ||
        mentions.includes(POLARITY.SUPPORTIVE);

      expect({
        mentions,
        mixed: aggregateMentionPolarities(mentions) === POLARITY.MIXED,
      }).toEqual({ mentions, mixed: departs && relies });
    }
  });

  test("otherwise answers a reading nothing in the citation outranks", () => {
    for (const mentions of ALL_READINGS) {
      const answer = aggregateMentionPolarities(mentions);
      if (answer === POLARITY.MIXED) {
        continue;
      }

      // A reading the court gave, and the severest of them: the label may
      // neither invent a stance nor soften one the text carries.
      expect({
        mentions,
        given: mentions.some((mention) => mention === answer),
      }).toEqual({ mentions, given: true });
      for (const mention of mentions) {
        expect({
          mention,
          mentions,
          outranks: POLARITY_PRECEDENCE[mention] < POLARITY_PRECEDENCE[answer],
        }).toEqual({ mention, mentions, outranks: false });
      }
    }
  });

  test("does not depend on how often a reading recurs", () => {
    // A case named twice in the same terms is the same citation as one named
    // once, so no reading may win by being repeated.
    for (const mentions of ALL_READINGS) {
      expect({
        mentions,
        answer: aggregateMentionPolarities([...mentions, ...mentions]),
      }).toEqual({ mentions, answer: aggregateMentionPolarities(mentions) });
    }
  });

  test("orders the mentions only within the tie precedence leaves open", () => {
    // `positive` and `supportive` differ in how explicit the reliance is,
    // not in how strong it is, so precedence ranks them equal and the
    // caller's own order settles which of them a citation is stored with.
    // Everywhere else the answer is a property of the readings alone.
    const answersByReadings = new Map<string, Set<Polarity>>();
    for (const mentions of ALL_READINGS) {
      const occurring = [...mentions].toSorted().join(",");
      const answers = answersByReadings.get(occurring) ?? new Set<Polarity>();
      answers.add(aggregateMentionPolarities(mentions));
      answersByReadings.set(occurring, answers);
    }

    for (const [occurring, answers] of answersByReadings) {
      const settled =
        answers.size === 1 ||
        [...answers].every(
          (answer) =>
            answer === POLARITY.POSITIVE || answer === POLARITY.SUPPORTIVE,
        );

      expect({ occurring, settled }).toEqual({ occurring, settled: true });
    }
  });

  test("never answers with a polarity outside the stored domain", () => {
    for (const mentions of ALL_READINGS) {
      const answer = aggregateMentionPolarities(mentions);

      expect({ mentions, stored: POLARITIES.includes(answer) }).toEqual({
        mentions,
        stored: true,
      });
      // `unknown` says classification did not happen; it has happened here.
      expect(answer).not.toBe(POLARITY.UNKNOWN);
    }
  });

  test("leaves a single mention's reading alone", () => {
    for (const polarity of CLASSIFIABLE_POLARITIES) {
      expect(aggregateMentionPolarities([polarity])).toBe(polarity);
    }
  });

  test("a recital followed by a rejection is the case the label exists for", () => {
    expect(
      aggregateMentionPolarities([POLARITY.SUPPORTIVE, POLARITY.NEGATIVE]),
    ).toBe(POLARITY.MIXED);
  });

  test("a mention that takes no side does not make a conflict", () => {
    expect(
      aggregateMentionPolarities([POLARITY.NEUTRAL, POLARITY.NEGATIVE]),
    ).toBe(POLARITY.NEGATIVE);
    expect(
      aggregateMentionPolarities([POLARITY.NEUTRAL, POLARITY.POSITIVE]),
    ).toBe(POLARITY.POSITIVE);
  });
});
