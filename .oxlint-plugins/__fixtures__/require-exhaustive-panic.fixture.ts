// Passive regression fixture for
// `require-exhaustive-panic/require-exhaustive-panic`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// accepted cases carry no disable, so a false positive would fail the fixture
// too.

import { panic, panic as fail } from "better-result";

type Kind = { type: "a" } | { type: "b" };

declare class UnhandledKindError extends Error {
  constructor(message: string);
}

// MUST flag: the binding holds the unhandled value and the next line hands it
// back to the caller.
export const boundAndReturned = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default: {
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves a `never` binding is rejected
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

// MUST flag: the same value returned directly through `satisfies`.
export const returnedSatisfies = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default:
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves returning a `satisfies never` expression is rejected
      return kind satisfies never;
  }
};

// MUST flag: the assertion proves nothing at runtime, so returning the same
// binding after it still hands the unhandled value back.
export const assertedThenReturned = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default: {
      kind satisfies never;
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves returning the asserted binding is rejected
      return kind;
    }
  }
};

// Accepted: the assertion evaluates to nothing and the miss panics.
export const assertsThenPanics = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default: {
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};

// MUST flag: a typed `null` fallback paints nothing where an unhandled state
// belongs, so the miss never surfaces.
export const assertsThenReturnsNull = (kind: Kind): string | null => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default:
      kind satisfies never;
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves a `null` fallback is rejected
      return null;
  }
};

// MUST flag: a literal fallback is the same miss wearing a default value.
export const assertsThenReturnsLiteral = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default:
      kind satisfies never;
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves a literal fallback is rejected
      return "";
  }
};

// MUST flag: breaking out of the switch leaves the miss to whatever follows it.
export const assertsThenBreaks = (kind: Kind): string => {
  let label = "";
  switch (kind.type) {
    case "a":
      label = "a";
      break;
    case "b":
      label = "b";
      break;
    default:
      kind satisfies never;
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves breaking out of the switch is rejected
      break;
  }
  return label;
};

// MUST flag: nothing follows the assertion at all, so the miss falls through.
export const assertsThenNothing = (kind: Kind, seen: string[]): void => {
  switch (kind.type) {
    case "a":
      seen.push("a");
      return;
    case "b":
      seen.push("b");
      return;
    default:
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves an assertion with no following statement is rejected
      kind satisfies never;
  }
};

// Accepted: the assertion is followed by a bare `panic(...)` call rather than a
// return, which is how a void path stops the miss.
export const assertsThenPanicCall = (kind: Kind, seen: string[]): void => {
  switch (kind.type) {
    case "a":
      seen.push("a");
      return;
    case "b":
      seen.push("b");
      return;
    default:
      kind satisfies never;
      panic(`Unhandled kind: ${String(kind)}`);
  }
};

// Accepted: a throw stops the miss too.
export const assertsThenThrows = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default:
      kind satisfies never;
      throw new UnhandledKindError(`Unhandled kind: ${String(kind)}`);
  }
};

// Accepted: the tail calls better-result's `panic` under an alias.
export const assertsThenAliasedPanic = (kind: Kind): string => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default: {
      kind satisfies never;
      return fail(`Unhandled kind: ${String(kind)}`);
    }
  }
};

// MUST flag: a local binding takes the name over, so the tail calls what this
// file wrote rather than the import that stops the miss.
export const assertsThenShadowedPanic = (kind: Kind): string => {
  // oxlint-disable-next-line no-shadow -- fixture: the shadowing is the case under test
  const panic = (message: string): string => message;
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default: {
      kind satisfies never;
      // oxlint-disable-next-line require-exhaustive-panic/require-exhaustive-panic -- fixture proves a shadowed `panic` is rejected
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};

// Accepted: an ordinary annotated binding, and a conditional type whose false
// branch is `never`.
export const ordinaryBinding: string = "value";
export const conditionalAnnotation: Kind extends { type: string }
  ? string
  : never = "value";
