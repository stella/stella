import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { plainTextOf } from "@stll/legal-ast/document-ast";
import type { Inline, InlineLegislationTarget } from "@stll/legal-ast/inline";
import { assertProperty } from "@stll/property-testing";

import {
  legislationMatchesIn,
  legislationTargetOfHref,
  withLegislationCitations,
} from "./legislation-citations";

const act = (
  series: InlineLegislationTarget["series"],
  year: number,
  number: number,
  date?: string,
): InlineLegislationTarget => ({
  status: "legislation",
  series,
  year,
  number,
  ...(date === undefined ? {} : { appliedVersion: { date } }),
});

describe("printed act designations", () => {
  test.each([
    ["Regulation (EU) 2016/679", act("eu-regulation", 2016, 679)],
    ["Regulation 2016/679/EU", act("eu-regulation", 2016, 679)],
    ["Regulation (EU) No 1215/2012", act("eu-regulation", 2012, 1215)],
    ["Regulation (EC) No 45/2001", act("eu-regulation", 2001, 45)],
    ["Regulation 45/2001", act("eu-regulation", 2001, 45)],
    ["Regulation (EC) 45/2001", act("eu-regulation", 2001, 45)],
    ["Regulation 1/2003", act("eu-regulation", 2003, 1)],
    ["Regulation 999/2001", act("eu-regulation", 2001, 999)],
    ["Directive 95/46/EC", act("eu-directive", 1995, 46)],
    ["Directive (EU) 2016/680", act("eu-directive", 2016, 680)],
    ["Decision (EU) 2016/1250", act("eu-decision", 2016, 1250)],
    ["zákona č. 110/2019 Sb.", act("cz-sb", 2019, 110)],
  ])("reads %s in its series' number order", (text, expected) => {
    expect(legislationMatchesIn(text).map(({ target }) => target)).toEqual([
      expected,
    ]);
  });

  test("states no applied version for a bare designation", () => {
    for (const { target } of legislationMatchesIn(
      "Regulation (EU) 2016/679 and zákon č. 110/2019 Sb.",
    )) {
      expect(target.appliedVersion).toBeUndefined();
    }
  });

  test("never cuts an act out of a longer number", () => {
    expect(legislationMatchesIn("Regulation (EU) 2022/20652")).toEqual([]);
  });

  test("covers exactly the designation's characters", () => {
    const text = "see zákon č. 110/2019 Sb., o zpracování";
    const [match] = legislationMatchesIn(text);
    expect(text.slice(match?.start, match?.end)).toBe("č. 110/2019 Sb.");
  });
});

describe("publisher links to legislation", () => {
  test.each([
    [
      "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679",
      act("eu-regulation", 2016, 679),
    ],
    [
      "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02016R0679-20160504",
      act("eu-regulation", 2016, 679, "2016-05-04"),
    ],
    [
      "https://eur-lex.europa.eu/eli/dir/2016/680/oj",
      act("eu-directive", 2016, 680),
    ],
    [
      "http://data.europa.eu/eli/reg_impl/2021/914/2021-06-04",
      act("eu-regulation", 2021, 914, "2021-06-04"),
    ],
    [
      "https://www.e-sbirka.cz/sb/2019/110/2024-01-01",
      act("cz-sb", 2019, 110, "2024-01-01"),
    ],
    ["https://www.zakonyprolidi.cz/cs/2019-110", act("cz-sb", 2019, 110)],
  ])("reads %s", (href, expected) => {
    expect(legislationTargetOfHref(href)).toEqual(expected);
  });

  test.each([
    "https://eur-lex.europa.eu.example.test/?uri=CELEX:32016R0679",
    "https://www.edpb.europa.eu/system/files/guidelines.pdf",
    "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62018CJ0311",
    "not a url",
  ])("names no act for %s", (href) => {
    expect(legislationTargetOfHref(href)).toBeNull();
  });
});

describe("citations in an inline run", () => {
  test("turns a link to an act into a citation that keeps its href", () => {
    const href =
      "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02016R0679-20160504";
    expect(
      withLegislationCitations([
        { type: "link", href, children: [{ type: "text", text: "GDPR" }] },
      ]),
    ).toEqual([
      {
        type: "citation",
        cite: "GDPR",
        href,
        children: [{ type: "text", text: "GDPR" }],
        target: act("eu-regulation", 2016, 679, "2016-05-04"),
      },
    ]);
  });

  test("never reads anonymized text for references", () => {
    const anonymized: Inline[] = [
      { type: "text", text: "Directive 95/46/EC", anonymized: true },
    ];
    expect(withLegislationCitations(anonymized)).toEqual(anonymized);
  });

  const fragment = fc.constantFrom(
    "Regulation (EU) 2016/679",
    "Directive 95/46/EC",
    "č. 110/2019 Sb.",
    "Article 6(1)(f) ",
    " and ",
    "2022/2065",
    " ",
    "\n",
  );
  const run: fc.Arbitrary<Inline[]> = fc.array(
    fc.oneof(
      fc
        .array(fragment, { minLength: 1, maxLength: 4 })
        .map((parts): Inline => ({ type: "text", text: parts.join("") })),
      fc
        .array(fragment, { minLength: 1, maxLength: 3 })
        .map((parts): Inline => ({
          type: "italic",
          children: [{ type: "text", text: parts.join("") }],
        })),
      fc.constant<Inline>({ type: "line-break" }),
    ),
    { maxLength: 6 },
  );

  test("keeps the character axis and is a fixed point", () => {
    assertProperty(
      "keeps the character axis and is a fixed point",
      fc.property(run, (inlines) => {
        const cited = withLegislationCitations(inlines);
        expect(plainTextOf(cited)).toBe(plainTextOf(inlines));
        expect(withLegislationCitations(cited)).toEqual(cited);
      }),
    );
  });
});
