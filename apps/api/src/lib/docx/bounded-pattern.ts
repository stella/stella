/**
 * Bounded compilation of manifest-supplied validation patterns.
 *
 * A template manifest travels inside an uploaded DOCX, so its `pattern`
 * strings are content, not code: the fill boundary compiles them and matches
 * submitted values against them in the API process. A backtracking engine can
 * spend time exponential in the value length on some pattern shapes, so
 * compilation is gated on a structural scan and the pattern itself is length
 * capped. Callers additionally cap the value they test.
 *
 * The scan is deliberately conservative: it rejects a repeated group that
 * itself repeats or branches, two open-ended repeats standing side by side
 * (the shapes whose match time is not linear), and any backreference, so some
 * unambiguous patterns are refused. A refused pattern is treated exactly like
 * a syntactically invalid one — skipped, never enforced — which is the
 * pre-existing disposition for a manifest the fill form cannot honour either.
 *
 * Pure: no IO, no model/provider dependency.
 */

import { Result } from "better-result";

import { LIMITS } from "@/api/lib/limits";

export type BoundedPattern =
  | { status: "valid"; regex: RegExp }
  | { status: "invalid" };

/** `{n}`, `{n,}`, `{n,m}`. A `{` that starts nothing else is a literal brace. */
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/u;
/** `\1`-`\9` and `\k<name>`: a backreference makes the match non-linear. */
const BACKREFERENCE_ESCAPE = /^[1-9k]/u;
/** `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`. */
const GROUP_MODIFIER = /^\?(?::|=|!|<[=!]|<[^>]*>)/u;

type GroupScan = {
  repeats: boolean;
  branches: boolean;
  /** An atom has been read in the branch being scanned. */
  hasAtom: boolean;
  /** The first atom of some branch starts with an open-ended repeat. */
  startsUnbounded: boolean;
  /** The last atom read ends with an open-ended repeat. */
  endsUnbounded: boolean;
  /** `endsUnbounded` of a branch already closed by `|`. */
  tailUnbounded: boolean;
};

/** How an atom's own quantifier bounds it, for the adjacency rule below. */
type AtomScan = { startsUnbounded: boolean; endsUnbounded: boolean };

const emptyGroup = (): GroupScan => ({
  repeats: false,
  branches: false,
  hasAtom: false,
  startsUnbounded: false,
  endsUnbounded: false,
  tailUnbounded: false,
});

const braceQuantifierLength = (pattern: string, index: number): number =>
  BRACE_QUANTIFIER.exec(pattern.slice(index))?.[0].length ?? 0;

/** Length of the quantifier at `index`, or 0 when there is none. */
const quantifierLength = (pattern: string, index: number): number => {
  const char = pattern[index];
  if (char === "*" || char === "+" || char === "?") {
    return 1;
  }
  if (char !== "{") {
    return 0;
  }
  return braceQuantifierLength(pattern, index);
};

/** A quantifier that can match a group more than once. `?` cannot, so it never
 *  turns an inner repeat into nested repetition. */
const repeatQuantifierLength = (pattern: string, index: number): number => {
  const char = pattern[index];
  if (char === "*" || char === "+") {
    return 1;
  }
  if (char !== "{") {
    return 0;
  }
  return braceQuantifierLength(pattern, index);
};

/** Whether the quantifier at `index` leaves the repeat count open: `*`, `+`,
 *  or `{n,}`. A bounded count expands to a fixed number of attempts. */
const isUnboundedQuantifier = (pattern: string, index: number): boolean => {
  const char = pattern[index];
  if (char === "*" || char === "+") {
    return true;
  }
  if (char !== "{") {
    return false;
  }
  return (
    BRACE_QUANTIFIER.exec(pattern.slice(index))?.[0].endsWith(",}") ?? false
  );
};

/**
 * Record `atom` as the next element of `group`'s current branch. Returns false
 * when it follows an open-ended repeat with another one: two such repeats side
 * by side can divide the same run of characters in as many ways as the run is
 * long, and each further pair multiplies that again.
 */
const appendAtom = (group: GroupScan, atom: AtomScan): boolean => {
  if (group.endsUnbounded && atom.startsUnbounded) {
    return false;
  }
  if (!group.hasAtom) {
    group.startsUnbounded = group.startsUnbounded || atom.startsUnbounded;
    group.hasAtom = true;
  }
  group.endsUnbounded = atom.endsUnbounded;
  return true;
};

/** Index just past the closing `]` of the class starting at `index`. */
const skipCharacterClass = (pattern: string, index: number): number => {
  let cursor = index + 1;
  while (cursor < pattern.length) {
    const char = pattern[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "]") {
      return cursor + 1;
    }
    cursor += 1;
  }
  return pattern.length;
};

/** Index just past the opening `(` and any group modifier at `index`. */
const skipGroupOpen = (pattern: string, index: number): number => {
  const modifier = GROUP_MODIFIER.exec(pattern.slice(index + 1));
  return index + 1 + (modifier?.[0].length ?? 0);
};

/** Whether every repeated group in `pattern` matches in time linear in the
 *  input: no repeat or alternation nested inside a repeated group, no two
 *  open-ended repeats side by side, and no backreference anywhere. */
const hasLinearMatchTime = (pattern: string): boolean => {
  const enclosing: GroupScan[] = [];
  let group = emptyGroup();
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === "|") {
      group.branches = true;
      group.tailUnbounded = group.tailUnbounded || group.endsUnbounded;
      group.endsUnbounded = false;
      group.hasAtom = false;
      index += 1;
      continue;
    }

    if (char === "(") {
      enclosing.push(group);
      group = emptyGroup();
      index = skipGroupOpen(pattern, index);
      continue;
    }

    if (char === ")") {
      const parent = enclosing.pop();
      if (parent === undefined) {
        return false;
      }
      const repeated = repeatQuantifierLength(pattern, index + 1) > 0;
      if (repeated && (group.repeats || group.branches)) {
        return false;
      }
      const unbounded = isUnboundedQuantifier(pattern, index + 1);
      const closed: AtomScan = {
        startsUnbounded: unbounded || group.startsUnbounded,
        endsUnbounded: unbounded || group.endsUnbounded || group.tailUnbounded,
      };
      parent.repeats = parent.repeats || group.repeats || repeated;
      parent.branches = parent.branches || group.branches;
      if (!appendAtom(parent, closed)) {
        return false;
      }
      group = parent;
      index += 1 + quantifierLength(pattern, index + 1);
      continue;
    }

    let next = index + 1;
    if (char === "\\") {
      if (BACKREFERENCE_ESCAPE.test(pattern.slice(index + 1))) {
        return false;
      }
      next = index + 2;
    } else if (char === "[") {
      next = skipCharacterClass(pattern, index);
    }

    const quantifier = quantifierLength(pattern, next);
    if (quantifier > 0) {
      group.repeats = true;
    }
    const unbounded = isUnboundedQuantifier(pattern, next);
    if (
      !appendAtom(group, {
        startsUnbounded: unbounded,
        endsUnbounded: unbounded,
      })
    ) {
      return false;
    }
    index = next + quantifier;
  }

  return enclosing.length === 0;
};

/**
 * Compile `pattern` anchored to the whole value. Returns `invalid` for a
 * pattern that is too long, that the scan refuses, or that the engine cannot
 * parse.
 */
export const compileBoundedPattern = (pattern: string): BoundedPattern => {
  if (pattern.length > LIMITS.templateFieldPatternMaxLength) {
    return { status: "invalid" };
  }
  if (!hasLinearMatchTime(pattern)) {
    return { status: "invalid" };
  }

  return Result.try(() => new RegExp(`^(?:${pattern})$`, "u")).match({
    ok: (regex): BoundedPattern => ({ status: "valid", regex }),
    err: (): BoundedPattern => ({ status: "invalid" }),
  });
};
