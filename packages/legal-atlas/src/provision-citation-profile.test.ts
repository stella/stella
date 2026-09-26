import { describe, expect, test } from "bun:test";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import type {
  ActAliasSpec,
  ActTitleSpec,
  JurisdictionProfile,
  WorkIdentifier,
} from "./provision-citation-profile";
import { SK_PROFILE } from "./sk-provision-citation-profile";

type TableEntry =
  | { kind: "alias"; spec: ActAliasSpec }
  | { kind: "title"; spec: ActTitleSpec };

const PROFILES = [
  { name: "Czech", profile: CZ_PROFILE },
  { name: "Slovak", profile: SK_PROFILE },
] as const satisfies readonly {
  name: string;
  profile: JurisdictionProfile;
}[];

const entriesOf = (profile: JurisdictionProfile): TableEntry[] => [
  ...profile.aliases.map((spec) => ({ kind: "alias" as const, spec })),
  ...profile.titles.map((spec) => ({ kind: "title" as const, spec })),
];

const SPACE_RUN = /\s+/gu;
const SPACE_AFTER_PERIOD = /(?<=\.) (?=\S)/gu;

/**
 * A spelling as any reader may see it: either composition, any whitespace
 * run, with or without a space between abbreviated components.
 */
const spellingKey = (spelling: string): string =>
  spelling
    .normalize("NFC")
    .replaceAll(SPACE_RUN, " ")
    .replaceAll(SPACE_AFTER_PERIOD, "");

/** Titles match case-insensitively, so any pair involving one does too. */
const collides = (left: TableEntry, right: TableEntry): boolean => {
  const fold =
    left.kind === "title" || right.kind === "title"
      ? (spelling: string) => spellingKey(spelling).toLowerCase()
      : spellingKey;
  const keys = new Set(left.spec.spellings.map(fold));
  return right.spec.spellings.some((spelling) => keys.has(fold(spelling)));
};

const LATEST_DAY = "9999-12-31";

/** The citing days an entry applies: its window, never before its act. */
const effectiveWindow = ({
  citedFrom,
  citedUntil,
  identifier,
}: ActAliasSpec | ActTitleSpec): { from: string; until: string } => {
  const issued = `${String(identifier.year)}-01-01`;
  return {
    from: citedFrom !== undefined && citedFrom > issued ? citedFrom : issued,
    until: citedUntil ?? LATEST_DAY,
  };
};

const sameAct = (left: WorkIdentifier, right: WorkIdentifier): boolean =>
  left.collection === right.collection &&
  left.number === right.number &&
  left.year === right.year;

const workLabel = ({ collection, number, year }: WorkIdentifier): string =>
  `${String(number)}/${String(year)} ${collection}`;

describe.each(PROFILES)("$name profile act tables", ({ profile }) => {
  const entries = entriesOf(profile);

  test("every entry applies on at least one citing day", () => {
    expect(
      entries
        .filter(({ spec }) => {
          const { from, until } = effectiveWindow(spec);
          return from >= until;
        })
        .map(({ spec }) => workLabel(spec.identifier)),
    ).toEqual([]);
  });

  // Two acts behind one spelling on one day is an ambiguity a reader can
  // only resolve by guessing; the tables leave such days without an entry.
  test("no spelling names two acts on the same citing day", () => {
    const ambiguous: string[] = [];
    for (const [index, left] of entries.entries()) {
      for (const right of entries.slice(index + 1)) {
        if (sameAct(left.spec.identifier, right.spec.identifier)) {
          continue;
        }
        const leftWindow = effectiveWindow(left.spec);
        const rightWindow = effectiveWindow(right.spec);
        const overlap =
          leftWindow.from < rightWindow.until &&
          rightWindow.from < leftWindow.until;
        if (overlap && collides(left, right)) {
          ambiguous.push(
            `${workLabel(left.spec.identifier)} / ${workLabel(right.spec.identifier)}`,
          );
        }
      }
    }

    expect(ambiguous).toEqual([]);
  });

  test("section and article anchors never render alike", () => {
    const { render } = profile.anchor;

    expect(render.section("1")).not.toBe(render.article("1"));
  });
});

test("the Czech tables name only acts e-Sbírka publishes", () => {
  expect(
    entriesOf(CZ_PROFILE)
      .filter(({ spec }) => spec.identifier.collection !== "Sb.")
      .map(({ spec }) => workLabel(spec.identifier)),
  ).toEqual([]);
});
