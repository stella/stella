import { describe, expect, test } from "bun:test";

import { allAvailable, anyAvailable } from "./availability";
import type { Availability } from "./availability";

const states = [
  { status: "disabled" },
  { status: "pending" },
  { status: "error", error: new Error("unavailable") },
  { status: "ready", value: "available" },
] as const satisfies readonly Availability<string>[];
type Status = Availability<unknown>["status"];
const anyPrecedence = {
  disabled: 0,
  error: 1,
  pending: 2,
  ready: 3,
} as const satisfies Record<Status, number>;
const allPrecedence = {
  ready: 0,
  pending: 1,
  error: 2,
  disabled: 3,
} as const satisfies Record<Status, number>;

const twoStateCombinations = states.flatMap((first) =>
  states.map((second) => [first, second] as const),
);
const threeStateCombinations = states.flatMap((first) =>
  states.flatMap((second) =>
    states.map((third) => [first, second, third] as const),
  ),
);
type HighestStatusOptions = {
  combination: readonly Availability<string>[];
  precedence: Readonly<Record<Status, number>>;
  initial: Status;
};
const highestStatus = ({
  combination,
  precedence,
  initial,
}: HighestStatusOptions): Status => {
  let selected = initial;
  for (const state of combination) {
    if (precedence[state.status] > precedence[selected]) {
      selected = state.status;
    }
  }
  return selected;
};
type Combination = readonly [
  Availability<string>,
  Availability<string>,
  ...Availability<string>[],
];
const expectAnyPrecedence = (combination: Combination) => {
  const expected = highestStatus({
    combination,
    precedence: anyPrecedence,
    initial: "disabled",
  });
  expect(anyAvailable(...combination).status).toBe(expected);
};
const expectAllPrecedence = (combination: Combination) => {
  const expected = highestStatus({
    combination,
    precedence: allPrecedence,
    initial: "ready",
  });
  expect(allAvailable(...combination).status).toBe(expected);
};

describe("availability combinations", () => {
  test("any prerequisite follows ready > pending > error > disabled", () => {
    for (const combination of twoStateCombinations) {
      expectAnyPrecedence(combination);
    }
    for (const combination of threeStateCombinations) {
      expectAnyPrecedence(combination);
    }
  });

  test("every prerequisite follows disabled > error > pending > ready", () => {
    for (const combination of twoStateCombinations) {
      expectAllPrecedence(combination);
    }
    for (const combination of threeStateCombinations) {
      expectAllPrecedence(combination);
    }
  });
});
