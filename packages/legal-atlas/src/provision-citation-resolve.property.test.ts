/**
 * Properties of reading the act a Czech citation names, over generated
 * citations: a provision path of any depth, any declined head, brackets or
 * parentheses around it, and the spacing courts print.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import {
  type ActTitleSpec,
  formatWorkIdentifier,
} from "./provision-citation-profile";
import {
  nominativeTitle,
  resolveActCitation,
} from "./provision-citation-resolve";

const CITED_ON = "2026-10-06";

const gap = fc.constantFrom(" ", "  ", " ");

const provisionPath = fc
  .record({
    section: fc.integer({ min: 1, max: 9999 }),
    subsection: fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }),
    letter: fc.option(fc.constantFrom("a", "b", "ch", "h", "z"), {
      nil: null,
    }),
    space: gap,
  })
  .map(({ section, subsection, letter, space }) =>
    [
      `§${space}${String(section)}`,
      ...(subsection === null ? [] : [`odst.${space}${String(subsection)}`]),
      ...(letter === null ? [] : [`písm.${space}${letter})`]),
    ].join(space),
  );

const enclosure = fc.constantFrom(
  { open: "", close: "" },
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "(", close: "" },
);

/** Words no alias or title of the profile contains. */
const SUBJECT_WORDS = [
  "obětech",
  "trestných",
  "činů",
  "myslivosti",
  "rybářství",
  "drahách",
  "včelařství",
  "archivnictví",
] as const;

const subject = fc
  .array(fc.constantFrom(...SUBJECT_WORDS), { minLength: 1, maxLength: 4 })
  .map((words) => `o ${words.join(" ")}`);

const titleHead = fc
  .constantFrom(...CZ_PROFILE.titleHeads)
  .chain((head) =>
    fc.constantFrom(...head.forms).map((form) => ({ head, form })),
  );

const TITLES: readonly ActTitleSpec[] = CZ_PROFILE.titles;
const [ACT_HEAD] = CZ_PROFILE.titleHeads;

/** Short titles `zákon o …` the profile lists for the citing date. */
const LISTED_SHORT_TITLES = TITLES.flatMap((entry) =>
  entry.spellings.flatMap((spelling) =>
    spelling.startsWith("zákon o ") &&
    (entry.citedFrom === undefined || entry.citedFrom <= CITED_ON) &&
    (entry.citedUntil === undefined || entry.citedUntil > CITED_ON)
      ? [{ subject: spelling.slice("zákon ".length), entry }]
      : [],
  ),
);

describe("reading the act a citation names", () => {
  test("hands back an unlisted short title in a form the corpus states", () => {
    assertProperty(
      "hands back an unlisted short title in a form the corpus states",
      fc.property(
        provisionPath,
        enclosure,
        titleHead,
        subject,
        gap,
        (path, { open, close }, { head, form }, words, space) => {
          const name = `${form}${space}${words}`;
          const read = resolveActCitation({
            text: `${open}${path}${space}${name}${close}`,
            profile: CZ_PROFILE,
            citedOn: CITED_ON,
          });
          expect(read).toEqual({
            status: "no_act",
            actName: name.replaceAll(/\s+/gu, " "),
          });
          if (read.status !== "no_act") {
            return;
          }
          expect(nominativeTitle(read.actName, CZ_PROFILE)).toBe(
            `${head.nominative} ${words}`,
          );
        },
      ),
    );
  });

  test("names a listed short title's act in every head form and enclosure", () => {
    expect(LISTED_SHORT_TITLES.length).toBeGreaterThan(0);
    assertProperty(
      "names a listed short title's act in every head form and enclosure",
      fc.property(
        provisionPath,
        enclosure,
        fc.constantFrom(...LISTED_SHORT_TITLES),
        fc.constantFrom(...ACT_HEAD.forms),
        gap,
        (path, { open, close }, { subject: words, entry }, form, space) => {
          const read = resolveActCitation({
            text: `${open}${path}${space}${form} ${words}${close}`,
            profile: CZ_PROFILE,
            citedOn: CITED_ON,
          });
          const expected = formatWorkIdentifier(entry.identifier);
          if (read.status === "ambiguous_act") {
            // A title two acts share on the citing date is refused, never guessed.
            expect(
              read.candidates.map(({ workIdentifier }) => workIdentifier),
            ).toContain(expected);
            return;
          }
          expect(read).toMatchObject({
            status: "resolved",
            workIdentifier: expected,
          });
        },
      ),
    );
  });
});
