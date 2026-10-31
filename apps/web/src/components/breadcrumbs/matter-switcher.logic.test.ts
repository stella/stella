import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  filterMattersByQuery,
  selectSiblingMatters,
} from "@/components/breadcrumbs/matter-switcher.logic";

const GENERATED_MATTERS_MAX_COUNT = 30;
// Few clients and few distinct instants, so generated lists share clients
// and tie on activity often enough to exercise the id tiebreak.
const GENERATED_CLIENT_INDEX_MAX = 2;
const GENERATED_ACTIVITY_MS_MAX = 5;

const matter = ({
  activity,
  clientId,
  id,
}: {
  activity: number;
  clientId: string | null;
  id: string;
}) => ({
  client: clientId === null ? null : { id: clientId },
  id,
  lastActivityAt: Temporal.Instant.fromEpochMilliseconds(activity).toString(),
});

const clientIdArbitrary = fc.option(
  fc
    .integer({ min: 0, max: GENERATED_CLIENT_INDEX_MAX })
    .map((index) => `client-${index}`),
  { nil: null },
);

const matterArbitrary = fc.record({
  activity: fc.integer({ min: 0, max: GENERATED_ACTIVITY_MS_MAX }),
  clientId: clientIdArbitrary,
  id: fc.uuid(),
});

describe("sibling matter selection", () => {
  it("keeps only matters under the same client, current included, newest activity first", () => {
    const matters = [
      matter({ activity: 1, clientId: "client-a", id: "current" }),
      matter({ activity: 3, clientId: "client-b", id: "other-client" }),
      matter({ activity: 2, clientId: "client-a", id: "newer" }),
      matter({ activity: 4, clientId: null, id: "personal" }),
    ];

    expect(
      selectSiblingMatters({ clientId: "client-a", matters }).map(
        ({ id }) => id,
      ),
    ).toEqual(["newer", "current"]);
  });

  it("treats every personal matter as a sibling of a personal matter", () => {
    const matters = [
      matter({ activity: 1, clientId: null, id: "personal-1" }),
      matter({ activity: 2, clientId: "client-a", id: "client-matter" }),
      matter({ activity: 3, clientId: null, id: "personal-2" }),
    ];

    expect(
      selectSiblingMatters({ clientId: null, matters }).map(({ id }) => id),
    ).toEqual(["personal-2", "personal-1"]);
  });
});

it("sibling selection is the same-client subset in activity order, independent of input order", () => {
  assertProperty(
    "sibling selection is the same-client subset in activity order, independent of input order",
    fc.property(
      fc.uniqueArray(matterArbitrary, {
        maxLength: GENERATED_MATTERS_MAX_COUNT,
        selector: ({ id }) => id,
      }),
      clientIdArbitrary,
      (records, clientId) => {
        const matters = records.map(matter);
        const selected = selectSiblingMatters({ clientId, matters });

        const expectedIds = matters
          .filter((candidate) => (candidate.client?.id ?? null) === clientId)
          .map(({ id }) => id)
          .toSorted(compareCodeUnit);
        expect(selected.map(({ id }) => id).toSorted(compareCodeUnit)).toEqual(
          expectedIds,
        );

        for (const [index, current] of selected.entries()) {
          const next = selected.at(index + 1);
          if (next !== undefined) {
            expect(
              Temporal.Instant.compare(
                current.lastActivityAt,
                next.lastActivityAt,
              ),
            ).toBeGreaterThanOrEqual(0);
          }
        }

        expect(
          selectSiblingMatters({ clientId, matters: matters.toReversed() }),
        ).toEqual(selected);
      },
    ),
  );
});

describe("matter switcher search", () => {
  const matters = [
    { id: "accented", name: "Čapek v. Dvořák", reference: null },
    { id: "numbered", name: "Lease renewal", reference: "2026/014" },
    { id: "plain", name: "Share purchase", reference: null },
  ];

  it("matches names regardless of accents and case", () => {
    const accentless = "capek v. DVORAK";
    expect(accentless).not.toBe(matters.at(0)?.name.toLowerCase());

    expect(
      filterMattersByQuery(matters, accentless).map(({ id }) => id),
    ).toEqual(["accented"]);
  });

  it("matches a shown reference but not a hidden one", () => {
    expect(
      filterMattersByQuery(matters, "2026/01").map(({ id }) => id),
    ).toEqual(["numbered"]);
    expect(
      filterMattersByQuery(
        matters.map((entry) => ({ ...entry, reference: null })),
        "2026/01",
      ),
    ).toEqual([]);
  });

  it("keeps every matter in order for a blank query", () => {
    expect(filterMattersByQuery(matters, "   ")).toEqual(matters);
  });
});
