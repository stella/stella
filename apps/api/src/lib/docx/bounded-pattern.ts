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
 * itself repeats or branches (the shapes whose match time is not linear) and
 * any backreference, so some unambiguous patterns are refused. A refused
 * pattern is treated exactly like a syntactically invalid one — skipped, never
 * enforced — which is the pre-existing disposition for a manifest the fill
 * form cannot honour either.
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

type GroupScan = { repeats: boolean; branches: boolean };

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
 *  input: no repeat or alternation nested inside a repeated group, and no
 *  backreference anywhere. */
const hasLinearMatchTime = (pattern: string): boolean => {
  const enclosing: GroupScan[] = [];
  let group: GroupScan = { repeats: false, branches: false };
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === "\\") {
      if (BACKREFERENCE_ESCAPE.test(pattern.slice(index + 1))) {
        return false;
      }
      index += 2;
      continue;
    }

    if (char === "[") {
      index = skipCharacterClass(pattern, index);
      continue;
    }

    if (char === "|") {
      group.branches = true;
      index += 1;
      continue;
    }

    if (char === "(") {
      enclosing.push(group);
      group = { repeats: false, branches: false };
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
      parent.repeats = parent.repeats || group.repeats || repeated;
      parent.branches = parent.branches || group.branches;
      group = parent;
      index += 1;
      continue;
    }

    const quantifier = quantifierLength(pattern, index);
    if (quantifier > 0) {
      group.repeats = true;
      index += quantifier;
      continue;
    }

    index += 1;
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
