// Passive regression fixture for
// `require-exhaustive-panic/require-exhaustive-panic`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// accepted cases carry no disable, so a false positive would fail the fixture
// too.

import { panic } from "better-result";

type Kind = { type: "a" } | { type: "b" };

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

// Accepted: a deliberate typed fallback returns nothing unhandled.
export const assertsThenFallsBack = (kind: Kind): string | null => {
  switch (kind.type) {
    case "a":
      return "a";
    case "b":
      return "b";
    default:
      kind satisfies never;
      return null;
  }
};

// Accepted: an ordinary annotated binding, and a conditional type whose false
// branch is `never`.
export const ordinaryBinding: string = "value";
export const conditionalAnnotation: Kind extends { type: string }
  ? string
  : never = "value";
