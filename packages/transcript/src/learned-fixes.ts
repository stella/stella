/**
 * The fixes stella learned from how a person corrects dictated words, and
 * the changes that update them. Every device and the server apply the same
 * changes the same way, so a device works offline on its own copy and the
 * server's copy, built from the changes every device sent, is the one they
 * all converge on. Pure: no storage, no clock.
 */
import { panic } from "better-result";

export const LEARNED_FIX_STATUSES = [
  /** Seen once; not applied yet. */
  "learning",
  /** Applied to every dictation. */
  "on",
  /** Switched off by the person. */
  "off",
  /** Corrected another way, or kept as dictated: never applied. */
  "contradicted",
] as const;

export type LearnedFixStatus = (typeof LEARNED_FIX_STATUSES)[number];

/** The statuses a person sets with a fix's switch. */
export const LEARNED_FIX_SWITCHES = ["on", "off"] as const;

export type LearnedFixSwitch = (typeof LEARNED_FIX_SWITCHES)[number];

export type LearnedFix = {
  /** The words as dictated. */
  readonly from: string;
  /** The words as the person wrote them. */
  readonly to: string;
  /** How many dictations were corrected this way. */
  readonly seen: number;
  readonly status: LearnedFixStatus;
};

/** How many fixes are kept; the oldest not in use go first. */
export const LEARNED_FIX_LIMIT = 30;
/** Corrections seen before a fix applies itself. */
const SIGHTINGS_TO_APPLY = 2;

/** One thing a person did that teaches stella about a fix. */
export type LearnedFixChange =
  /** They replaced dictated words with these. */
  | { readonly type: "corrected"; readonly from: string; readonly to: string }
  /** They left a fix's words as dictated in a dictation they otherwise edited. */
  | { readonly type: "kept"; readonly from: string }
  /** They said how the words are spelled: the fix is on at once. */
  | { readonly type: "taught"; readonly from: string; readonly to: string }
  /** They switched a fix on or off. */
  | {
      readonly type: "switched";
      readonly from: string;
      readonly status: LearnedFixSwitch;
    };

/**
 * How two phrases compare: in lower case, curly apostrophes made straight,
 * single spaces between words.
 */
export const learnedFixKey = (phrase: string): string =>
  phrase.trim().toLowerCase().replaceAll("’", "'").replaceAll(/\s+/gu, " ");

/** `fixes` after `changes`, in order. The most recently changed fix is last. */
export const applyLearnedFixChanges = (
  fixes: readonly LearnedFix[],
  changes: readonly LearnedFixChange[],
): LearnedFix[] => {
  let next = [...fixes];
  for (const change of changes) {
    next = applied(next, change);
  }
  while (next.length > LEARNED_FIX_LIMIT) {
    const unused = next.findIndex(
      ({ status }) => status === "learning" || status === "contradicted",
    );
    next.splice(Math.max(unused, 0), 1);
  }
  return next;
};

const applied = (
  fixes: readonly LearnedFix[],
  change: LearnedFixChange,
): LearnedFix[] => {
  const fromKey = learnedFixKey(change.from);
  const known = fixes.find((fix) => learnedFixKey(fix.from) === fromKey);
  switch (change.type) {
    case "corrected": {
      const next = turnedBack(fixes, change);
      const current = next.find((fix) => learnedFixKey(fix.from) === fromKey);
      const updated: LearnedFix =
        current === undefined
          ? { from: change.from, to: change.to, seen: 1, status: "learning" }
          : sighted(current, change.to);
      return [...next.filter((fix) => fix !== current), updated];
    }
    case "kept": {
      return fixes.map((fix) => (fix === known ? contradicted(fix) : fix));
    }
    case "taught": {
      const next = turnedBack(fixes, change);
      const current = next.find((fix) => learnedFixKey(fix.from) === fromKey);
      const taught: LearnedFix = {
        from: change.from,
        to: change.to,
        seen: (current?.seen ?? 0) + 1,
        status: "on",
      };
      return [...next.filter((fix) => fix !== current), taught];
    }
    case "switched": {
      return fixes.map((fix) =>
        fix === known
          ? {
              from: fix.from,
              to: fix.to,
              seen: fix.seen,
              status: change.status,
            }
          : fix,
      );
    }
    default: {
      change satisfies never;
      return panic("Unknown learned fix change");
    }
  }
};

/**
 * A fix whose words the person turned back to what was dictated was wrong.
 * A fix of case alone compares as written, or its own correction would
 * look like a reversal.
 */
const turnedBack = (
  fixes: readonly LearnedFix[],
  { from, to }: { from: string; to: string },
): LearnedFix[] =>
  fixes.map((fix) => {
    const compared = caseOnly(fix) ? exactPhrase : learnedFixKey;
    return compared(fix.from) === compared(to) &&
      compared(fix.to) === compared(from)
      ? contradicted(fix)
      : fix;
  });

const caseOnly = ({ from, to }: { from: string; to: string }): boolean =>
  learnedFixKey(from) === learnedFixKey(to);

const exactPhrase = (phrase: string): string =>
  phrase.trim().replaceAll("’", "'").replaceAll(/\s+/gu, " ");

const contradicted = (fix: LearnedFix): LearnedFix =>
  fix.status === "off"
    ? fix
    : { from: fix.from, to: fix.to, seen: fix.seen, status: "contradicted" };

/** A fix seen corrected again: the same way counts, another way contradicts it. */
const sighted = (fix: LearnedFix, to: string): LearnedFix => {
  if (fix.to !== to) {
    return contradicted(fix);
  }
  const seen = fix.seen + 1;
  return {
    from: fix.from,
    to: fix.to,
    seen,
    status:
      fix.status === "learning" && seen >= SIGHTINGS_TO_APPLY
        ? "on"
        : fix.status,
  };
};
