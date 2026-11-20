import { expect, test } from "bun:test";

import { resolveHeldDecisionCandidates } from "./held-decision-candidates";

const read = (...ids: string[]) => ({
  type: "complete" as const,
  rows: ids.map((id) => ({ id })),
});
const none = { ecli: read(), courtDocketDate: read() };

test("a tuple host outranks collection copies carrying another ECLI", () => {
  expect(
    resolveHeldDecisionCandidates({
      hosts: { ecli: read(), courtDocketDate: read("official") },
      collections: {
        ecli: read("own-first"),
        courtDocketDate: read("own-first"),
      },
    }),
  ).toEqual({
    status: "matched",
    basis: "court-docket-date",
    candidate: { id: "official" },
  });
});
test.each([
  ["one", "two"],
  ["two", "one"],
])(
  "neither identity lookup bypasses a conflicting host: %s / %s",
  (ecli, tuple) => {
    expect(
      resolveHeldDecisionCandidates({
        hosts: { ecli: read(ecli), courtDocketDate: read(tuple) },
        collections: none,
      }),
    ).toEqual({
      status: "conflict",
      ecliCandidates: [{ id: ecli }],
      courtDocketDateCandidates: [{ id: tuple }],
    });
  },
);
test("different candidate sets do not silently intersect", () => {
  expect(
    resolveHeldDecisionCandidates({
      hosts: { ecli: read("one", "two"), courtDocketDate: read("one") },
      collections: none,
    }).status,
  ).toBe("conflict");
});
test("canonical aliases and repeated delivery converge on one candidate", () => {
  for (const duplicates of [1, 2, 12]) {
    const aliases = Array.from({ length: duplicates }, () => "canonical");
    expect(
      resolveHeldDecisionCandidates({
        hosts: none,
        collections: {
          ecli: read(...aliases),
          courtDocketDate: read(...aliases),
        },
      }),
    ).toEqual({
      status: "matched",
      basis: "court-docket-date",
      candidate: { id: "canonical" },
    });
  }
});
test("same-source siblings match without an external publisher", () => {
  expect(
    resolveHeldDecisionCandidates({
      hosts: none,
      collections: { ecli: read(), courtDocketDate: read("first-sibling") },
    }),
  ).toEqual({
    status: "matched",
    basis: "court-docket-date",
    candidate: { id: "first-sibling" },
  });
});
test("overflow or several owners never authorizes a new row", () => {
  expect(
    resolveHeldDecisionCandidates({
      hosts: { ecli: { type: "overflow", cap: 8 }, courtDocketDate: read() },
      collections: none,
    }),
  ).toEqual({ status: "ambiguous", candidates: [], completeness: "overflow" });
  expect(
    resolveHeldDecisionCandidates({
      hosts: none,
      collections: { ecli: read(), courtDocketDate: read("two", "one") },
    }),
  ).toEqual({
    status: "ambiguous",
    candidates: [{ id: "two" }, { id: "one" }],
    completeness: "complete",
  });
});
test("only absence on both paths and publisher classes permits an own row", () => {
  expect(
    resolveHeldDecisionCandidates({ hosts: none, collections: none }),
  ).toEqual({ status: "absent" });
});
