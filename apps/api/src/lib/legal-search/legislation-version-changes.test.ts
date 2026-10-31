import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { STATUTE_VERSION_CHANGES_METHOD } from "@stll/api-contract/statute-version-changes";

import { createSafeId } from "@/api/lib/branded-types";
import {
  isVersionChangeSummaryFresh,
  planVersionChanges,
} from "@/api/lib/legal-search/legislation-version-changes";
import type { VersionChangeCandidate } from "@/api/lib/legal-search/legislation-version-changes";

const version = (
  versionValidFrom: string,
  overrides: Partial<VersionChangeCandidate> = {},
): VersionChangeCandidate => ({
  id: createSafeId<"legislationDocument">(),
  versionValidFrom,
  payloadRevision: 1n,
  eligible: true,
  changeSummary: null,
  ...overrides,
});

const COUNTS = {
  provisions: { changed: 1, added: 0, removed: 0 },
  words: { inserted: 1, deleted: 1 },
};

const comparedWith = (
  base: VersionChangeCandidate,
  { method = STATUTE_VERSION_CHANGES_METHOD, payloadRevision = 1 } = {},
) => ({
  type: "compared",
  method,
  payloadRevision,
  base: { documentId: base.id, payloadRevision: Number(base.payloadRevision) },
  counts: COUNTS,
});

const targets = (tasks: ReturnType<typeof planVersionChanges>) =>
  tasks.map(({ base, target }) => [base?.id ?? null, target.id]);

describe("planVersionChanges", () => {
  test("pairs each eligible version with the eligible one before it, oldest first", () => {
    const first = version("2020-01-01");
    const never = version("2020-06-01", { eligible: false });
    const second = version("2021-01-01");
    const third = version("2022-01-01");

    expect(
      targets(planVersionChanges({ versions: [third, never, second, first] })),
    ).toEqual([
      [null, first.id],
      [first.id, second.id],
      [second.id, third.id],
    ]);
  });

  test("a write outdates only its own summary and the next eligible version's", () => {
    const first = version("2020-01-01", {
      changeSummary: {
        type: "first",
        method: STATUTE_VERSION_CHANGES_METHOD,
        payloadRevision: 1,
      },
    });
    const second = version("2021-01-01");
    const skipped = version("2021-06-01", { eligible: false });
    const third = version("2022-01-01");
    const fourth = version("2023-01-01", {
      changeSummary: comparedWith(third),
    });

    expect(
      targets(
        planVersionChanges({
          versions: [first, second, skipped, third, fourth],
          around: second.id,
        }),
      ),
    ).toEqual([
      [first.id, second.id],
      [second.id, third.id],
    ]);
  });

  test("a version that stopped applying still outdates the next one's summary", () => {
    const first = version("2020-01-01", {
      changeSummary: {
        type: "first",
        method: STATUTE_VERSION_CHANGES_METHOD,
        payloadRevision: 1,
      },
    });
    const withdrawn = version("2021-01-01", { eligible: false });
    const third = version("2022-01-01");

    expect(
      targets(
        planVersionChanges({
          versions: [first, withdrawn, third],
          around: withdrawn.id,
        }),
      ),
    ).toEqual([[first.id, third.id]]);
  });

  test("plans nothing for a Work whose summaries are fresh", () => {
    const first = version("2020-01-01", {
      changeSummary: {
        type: "first",
        method: STATUTE_VERSION_CHANGES_METHOD,
        payloadRevision: 1,
      },
    });
    const second = version("2021-01-01");
    const fresh = { ...second, changeSummary: comparedWith(first) };

    expect(planVersionChanges({ versions: [first, fresh] })).toEqual([]);
  });
});

describe("isVersionChangeSummaryFresh", () => {
  const base = version("2020-01-01", { payloadRevision: 3n });
  const target = version("2021-01-01", { payloadRevision: 2n });

  test("holds while both revisions and the base are the ones computed from", () => {
    expect(
      isVersionChangeSummaryFresh({
        base,
        target: {
          ...target,
          changeSummary: comparedWith(base, { payloadRevision: 2 }),
        },
      }),
    ).toBe(true);
  });

  test.each([
    ["its own wording changed", { payloadRevision: 1 }, base],
    [
      "the counting changed",
      { method: STATUTE_VERSION_CHANGES_METHOD + 1, payloadRevision: 2 },
      base,
    ],
    [
      "the version before was rewritten",
      { payloadRevision: 2 },
      { ...base, payloadRevision: 4n },
    ],
    [
      "another version now comes before it",
      { payloadRevision: 2 },
      version("2020-06-01"),
    ],
  ] as const)("is stale once %s", (_reason, stored, currentBase) => {
    expect(
      isVersionChangeSummaryFresh({
        base: currentBase,
        target: { ...target, changeSummary: comparedWith(base, stored) },
      }),
    ).toBe(false);
  });

  test("a summary that does not parse is stale, never served or trusted", () => {
    expect(
      isVersionChangeSummaryFresh({
        base,
        target: { ...target, changeSummary: { type: "compared" } },
      }),
    ).toBe(false);
  });
});

test.each(
  [0, 1, 2, 3].flatMap((movedIndex) =>
    ["2019-01-01", "2021-01-01", "2023-01-01", "2025-01-01", "2027-01-01"].map(
      (opening) => [movedIndex, opening] as const,
    ),
  ),
)(
  "scoped planning matches a full repair after re-dating position %s to %s",
  (movedIndex, opening) => {
    const original = [
      "2020-01-01",
      "2022-01-01",
      "2024-01-01",
      "2026-01-01",
    ].map((date) => version(date));
    const fresh = original.map((row, index) => {
      const previous = original.at(index - 1);
      return {
        ...row,
        changeSummary:
          index === 0
            ? {
                type: "first",
                method: STATUTE_VERSION_CHANGES_METHOD,
                payloadRevision: 1,
              }
            : comparedWith(
                previous ?? panic("previous fixture version exists"),
              ),
      };
    });
    const moved = fresh.at(movedIndex) ?? panic("moved fixture version exists");
    const versions = fresh.map((row) =>
      row.id === moved.id
        ? { ...row, versionValidFrom: opening, payloadRevision: 2n }
        : row,
    );
    expect(targets(planVersionChanges({ versions, around: moved.id }))).toEqual(
      targets(planVersionChanges({ versions })),
    );
  },
);

test.each([null, { type: "unrecognized" }] as const)(
  "repairs a re-dated version's former successor without stored provenance: %j",
  (changeSummary) => {
    const first = version("2020-01-01", {
      changeSummary: {
        type: "first",
        method: STATUTE_VERSION_CHANGES_METHOD,
        payloadRevision: 1,
      },
    });
    const moved = version("2023-01-01", {
      payloadRevision: 2n,
      changeSummary: comparedWith(first),
    });
    const formerSuccessor = version("2022-01-01", { changeSummary });
    const next = version("2024-01-01", {
      changeSummary: comparedWith(formerSuccessor),
    });
    const versions = [first, moved, formerSuccessor, next];
    expect(targets(planVersionChanges({ versions, around: moved.id }))).toEqual(
      targets(planVersionChanges({ versions })),
    );
  },
);

test.each([null, { type: "unrecognized" }] as const)(
  "repairs an undated version's successor without a stored base reference: %j",
  (changeSummary) => {
    const first = version("2020-01-01", {
      changeSummary: {
        type: "first",
        method: STATUTE_VERSION_CHANGES_METHOD,
        payloadRevision: 1,
      },
    });
    const successor = version("2022-01-01", { changeSummary });
    const undatedId = createSafeId<"legislationDocument">();
    const versions = [first, successor];
    expect(
      targets(planVersionChanges({ versions, around: undatedId })),
    ).toEqual(targets(planVersionChanges({ versions })));
  },
);
