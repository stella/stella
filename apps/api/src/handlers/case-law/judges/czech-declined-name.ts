import { panic } from "better-result";

import { judgeNameKey } from "@/api/handlers/case-law/judges/judge-name";

/**
 * Find the roster row a Czech name printed in a declined case form belongs to.
 *
 * A Czech decision names its bench inside a sentence, so the names stand in
 * the case the grammar asks for: "z předsedy Jana Svatoně" (genitive),
 * "soudcem zpravodajem Michalem Bartoněm" (instrumental). The roster states
 * the same people in the nominative. Undoing a declension is ambiguous in
 * general ("Jana" is a woman's name and a man's genitive), but the people who
 * can sit on one court are a closed set the court publishes, so the question
 * asked here is only which of those people this declined name can be.
 *
 * Each name part is compared on its stems: the part itself, the part with one
 * case ending removed, and the part without the fleeting `e` Czech drops
 * before a final consonant (Šimíček, Šimíčka). Two parts agree when they share
 * a stem. A roster row matches when every part pairs with a distinct part of
 * the row, and the answer is a match only when exactly one row does: a name
 * two rows can claim is left unmatched rather than guessed.
 */

/**
 * Case endings of Czech given names and surnames, folded the way the match key
 * folds them (lowercase, diacritics removed). Genitive and instrumental are
 * the cases a bench is printed in; the nominative endings are here because the
 * roster side is stemmed the same way, so "Baxa" and "Baxy" both reach "bax".
 */
const CASE_ENDINGS = [
  "ovou",
  "ove",
  "ova",
  "eho",
  "iho",
  "emu",
  "imu",
  "ym",
  "im",
  "em",
  "ou",
  "a",
  "e",
  "y",
  "u",
  "i",
  "o",
] as const;

/** A stem shorter than this says too little about the name to match on. */
const MIN_STEM_LENGTH = 2;

/** `-ek`, `-ec`, `-el`, `-er`: the `e` a declined form drops (Pavel, Pavla). */
const FLEETING_E_PATTERN = /e(?<consonant>[cklr])$/u;

const stems = (part: string): ReadonlySet<string> => {
  const found = new Set([part]);
  for (const ending of CASE_ENDINGS) {
    if (
      part.endsWith(ending) &&
      part.length - ending.length >= MIN_STEM_LENGTH
    ) {
      found.add(part.slice(0, -ending.length));
    }
  }
  const fleeting = part.replace(FLEETING_E_PATTERN, "$<consonant>");
  if (fleeting !== part && fleeting.length > MIN_STEM_LENGTH) {
    found.add(fleeting);
  }
  return found;
};

/** The name's parts as the match key folds them, each with its stems. */
const nameParts = (name: string): readonly ReadonlySet<string>[] => {
  const key = judgeNameKey(name);
  return key === "" ? [] : key.split("-").map(stems);
};

const shareStem = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].some((stem) => b.has(stem));

/**
 * Whether every declined part pairs with a distinct roster part. Build the
 * compatibility graph once, then augment one matching per part; repeated
 * words with a late mismatch must not enumerate every permutation.
 */
export const partsPair = (
  declined: readonly ReadonlySet<string>[],
  roster: readonly ReadonlySet<string>[],
): boolean => {
  if (declined.length !== roster.length) {
    return false;
  }
  const compatible = declined.map((part) =>
    roster.flatMap((candidate, index) =>
      shareStem(part, candidate) ? [index] : [],
    ),
  );
  const matched = new Map<number, number>();
  const augment = (part: number, visited: Set<number>): boolean => {
    const candidates = compatible.at(part) ?? panic("Unknown name-part vertex");
    for (const candidate of candidates) {
      if (visited.has(candidate)) {
        continue;
      }
      visited.add(candidate);
      const previous = matched.get(candidate);
      if (previous === undefined || augment(previous, visited)) {
        matched.set(candidate, part);
        return true;
      }
    }
    return false;
  };
  return compatible.every((_candidates, index) => augment(index, new Set()));
};

export type DeclinedNameMatch<Judge> =
  | { type: "matched"; judge: Judge }
  | { type: "unmatched" }
  | { type: "ambiguous"; candidates: number };

/** The one roster row a declined Czech name can be, or why there is none. */
export const matchCzechDeclinedName = <Judge extends { fullName: string }>(
  declined: string,
  roster: readonly Judge[],
): DeclinedNameMatch<Judge> => {
  const parts = nameParts(declined);
  if (parts.length === 0) {
    return { type: "unmatched" };
  }
  const candidates = roster.filter((judge) =>
    partsPair(parts, nameParts(judge.fullName)),
  );
  const [only, ...others] = candidates;
  if (only === undefined) {
    return { type: "unmatched" };
  }
  return others.length === 0
    ? { type: "matched", judge: only }
    : { type: "ambiguous", candidates: candidates.length };
};
