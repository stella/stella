import { describe, expect, test } from "bun:test";

import { normalizeUnicode } from "@stll/text-normalize";

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
];

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
  normalizeUnicode(spelling, "NFC")
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

/** Whether an entry carries a window; one without is read wherever none applies. */
const bounded = ({ citedFrom, citedUntil }: ActAliasSpec | ActTitleSpec) =>
  citedFrom !== undefined || citedUntil !== undefined;

/** Recodifications before this day are older than the case law the tables serve. */
const CASE_LAW_HORIZON = "1990-01-01";

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
        // A windowed entry is the reading on its days; an unwindowed one
        // only where no windowed entry of its spelling applies.
        if (
          sameAct(left.spec.identifier, right.spec.identifier) ||
          bounded(left.spec) !== bounded(right.spec)
        ) {
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

  // Windowing the newer act from a switch older than the case law would make
  // every later decision a date pick and leave undated ones with no reading;
  // only the older act takes the window there.
  test("a name recodified before the case law reads its newer act without a window", () => {
    const windowedSince = entries.filter((entry) => {
      const { citedFrom, citedUntil, identifier } = entry.spec;
      if (
        citedUntil !== undefined ||
        citedFrom === undefined ||
        citedFrom >= CASE_LAW_HORIZON
      ) {
        return false;
      }
      return entries.some(
        (older) =>
          !sameAct(older.spec.identifier, identifier) &&
          older.spec.citedUntil !== undefined &&
          older.spec.citedUntil <= citedFrom &&
          collides(older, entry),
      );
    });

    expect(
      windowedSince.map(
        ({ spec }) =>
          `${workLabel(spec.identifier)} from ${String(spec.citedFrom)}`,
      ),
    ).toEqual([]);
  });

  test("section and article anchors never render alike", () => {
    const { render } = profile.anchor;

    expect(render.section("1")).not.toBe(render.article("1"));
  });
});

test("every Czech table entry names an act in the Sb. collection", () => {
  expect(
    entriesOf(CZ_PROFILE)
      .filter(({ spec }) => spec.identifier.collection !== "Sb.")
      .map(({ spec }) => workLabel(spec.identifier)),
  ).toEqual([]);
});
