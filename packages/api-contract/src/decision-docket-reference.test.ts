import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyConfig } from "@stll/property-testing";

import {
  DECISION_DOCKET_GRAMMARS,
  parseDecisionDocket,
  storedDecisionDocketOf,
} from "./decision-docket-grammar";
import {
  DECISION_DOCKET_IDENTITY_FIXTURES,
  DOCKET_IDENTITY_FIXTURE_NUMBER_MAX,
  DOCKET_IDENTITY_PART_NUMERAL,
  docketReaderEntryArbitrary,
} from "./decision-docket-identity.fixtures";
import {
  DECISION_DOCKETS_STORED_WITH_SHEETS,
  decisionDocketTailSpellings,
  docketFamilyKeyOf,
  readDecisionDocketReference,
} from "./decision-docket-reference";
import type { DecisionDocketSelector } from "./decision-docket-reference";
import {
  type DecisionIdentifierIntent,
  ecliSheetOf,
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "./decision-query-intent";

const CZE = { grammar: DECISION_DOCKET_GRAMMARS.CZE } as const;

/** A Czech senate docket as a court files it: senate, registry, number/year. */
type Docket = {
  readonly senate: number;
  readonly registry: string;
  readonly number: number;
  readonly year: number;
};

const docketArbitrary: fc.Arbitrary<Docket> = fc.record({
  senate: fc.integer({ min: 1, max: 99 }),
  registry: fc.constantFrom(
    "Cdo",
    "Tdo",
    "Afs",
    "As",
    "Azs",
    "Ads",
    "Odo",
    "NSČR",
    "Cmo",
    "A",
    "C",
  ),
  number: fc.integer({ min: 1, max: 99_999 }),
  year: fc.integer({ min: 1993, max: 2030 }),
});

const filed = ({ number, registry, senate, year }: Docket): string =>
  `${String(senate)} ${registry} ${String(number)}/${String(year)}`;

type Tail =
  | { readonly kind: "none" }
  | { readonly kind: "sheet"; readonly value: number }
  | { readonly kind: "part"; readonly value: string };

const ROMAN = ["I", "II", "III", "IV", "V", "IX", "XII", "XXXIX"] as const;

const tailArbitrary: fc.Arbitrary<Tail> = fc.oneof(
  fc.constant({ kind: "none" } as const),
  fc
    .integer({ min: 1, max: 9999 })
    .map((value) => ({ kind: "sheet", value }) as const),
  fc.constantFrom(...ROMAN).map((value) => ({ kind: "part", value }) as const),
);

const DASHES = ["-", "‐", "‑", "–", "—", "−"] as const;

/**
 * Every way a reader, a typist or a citing court spells one reference: the
 * citation prefix, the gaps inside the docket (none, one, several, a
 * non-breaking one), the slash spaced or not, the dash style and its spacing,
 * the case of the registry mark, and the brackets or quotes around it.
 */
const spellingOf = (docket: Docket, tail: Tail) =>
  fc
    .record({
      prefix: fc.constantFrom(
        "",
        "sp. zn. ",
        "sp.zn. ",
        "sp. zn.: ",
        "sp. zn ",
        "č. j. ",
        "č.j. ",
        "čj. ",
        "č. k. ",
        "č. j. ".normalize("NFD"),
      ),
      senateGap: fc.constantFrom(" ", "", "  ", " "),
      numberGap: fc.constantFrom(" ", "", "  "),
      slash: fc.constantFrom("/", " / ", " /", "/ "),
      dash: fc.constantFrom(...DASHES),
      dashGap: fc.constantFrom(["", ""], [" ", " "], ["", " "], [" ", ""]),
      zeros: fc.constantFrom("", "0", "00"),
      lower: fc.boolean(),
      partDot: fc.boolean(),
      wrap: fc.constantFrom(["", ""], ["(", ")"], ["„", "“"], ["", ","]),
    })
    .map(
      ({
        dash,
        dashGap: [before, after],
        lower,
        numberGap,
        partDot,
        prefix,
        senateGap,
        slash,
        wrap: [open, close],
        zeros,
      }) => {
        const registry = lower
          ? docket.registry.toLowerCase()
          : docket.registry;
        // A compact spelling glues the registry to both numbers; a reader
        // never glues one side and spaces the other in the same entry.
        const docketText = `${String(docket.senate)}${senateGap}${registry}${numberGap}${String(docket.number)}${slash}${String(docket.year)}`;
        let tailText = "";
        if (tail.kind === "sheet") {
          // A court numbers sheets in at most four digits, padded or not.
          const sheet = String(tail.value);
          const padding = zeros.slice(0, Math.max(0, 4 - sheet.length));
          tailText = `${before}${dash}${after}${padding}${sheet}`;
        } else if (tail.kind === "part") {
          tailText = `${before}${dash}${after}${tail.value}${partDot ? "." : ""}`;
        }
        return `${open}${prefix}${docketText}${tailText}${close}`;
      },
    );

/** A docket, a tail, and one spelling of the two together. */
const referenceArbitrary = fc
  .tuple(docketArbitrary, tailArbitrary)
  .chain(([docket, tail]) =>
    spellingOf(docket, tail).map((entry) => ({ docket, entry, tail })),
  );

/** The key a docket's file compares under in the Czech grammar. */
const familyKeyOf = (docket: string): string =>
  readDecisionDocketReference(docket, CZE)?.family.canonical ??
  panic(`Not a docket: ${docket}`);

const expectedSelector = (tail: Tail): DecisionDocketSelector => {
  switch (tail.kind) {
    case "none":
      return { kind: "none" };
    case "sheet":
      return { kind: "sheet", value: String(tail.value) };
    case "part":
      return { kind: "part", value: tail.value };
    default: {
      tail satisfies never;
      return panic("Unhandled tail");
    }
  }
};

const docketIntentOf = (
  entry: string,
): Extract<DecisionIdentifierIntent, { kind: "docket" }> => {
  const intent = parseDecisionQuery(entry, CZE);
  return intent.type === "identifier" && intent.kind === "docket"
    ? intent
    : panic(`Not a docket: ${JSON.stringify(intent)}`);
};

/** Words that sit around a reference in an entry and are none of its parts. */
const proseWord = fc.constantFrom(
  "rozsudek",
  "usnesení",
  "nález",
  "náhrada",
  "škody",
  "podle",
  "dovolání",
  "ze",
  "dne",
  "o",
  "trestní",
  "věci",
);

describe("reading a docket reference however it is spelled", () => {
  test("every spelling of one reference reads as the same file and the same selector", () => {
    fc.assert(
      fc.property(referenceArbitrary, ({ docket, entry, tail }) => {
        const intent = docketIntentOf(entry);
        // The family keeps the reader's case and gaps the grammar allows, and
        // keys exactly as the docket the court filed.
        expect(familyKeyOf(intent.family), entry).toBe(
          familyKeyOf(filed(docket)),
        );
        expect(intent.selector, entry).toEqual(expectedSelector(tail));
        expect(intent.embeddedIn, entry).toBeUndefined();
      }),
      propertyConfig(),
    );
  });

  test("a reference with no tail never reads as one with a selector", () => {
    fc.assert(
      fc.property(
        docketArbitrary.chain((docket) => spellingOf(docket, { kind: "none" })),
        (entry) => {
          expect(docketIntentOf(entry).selector).toEqual({ kind: "none" });
        },
      ),
      propertyConfig(),
    );
  });

  test("the spelling a reference reads back as is the same reference", () => {
    fc.assert(
      fc.property(referenceArbitrary, ({ entry }) => {
        const intent = docketIntentOf(entry);
        expect(parseDecisionQuery(intent.value, CZE)).toEqual(intent);
      }),
      propertyConfig(),
    );
  });

  test("a reference among other words is still read, and says so", () => {
    fc.assert(
      fc.property(
        referenceArbitrary,
        fc.array(proseWord, { minLength: 0, maxLength: 4 }),
        fc.array(proseWord, { minLength: 0, maxLength: 4 }),
        ({ docket, entry: reference, tail }, before, after) => {
          fc.pre(before.length + after.length > 0);
          const entry = [...before, reference, ...after].join(" ");
          const intent = docketIntentOf(entry);
          // The family keeps the reader's case and gaps the grammar allows, and
          // keys exactly as the docket the court filed.
          expect(familyKeyOf(intent.family), entry).toBe(
            familyKeyOf(filed(docket)),
          );
          // A lower-case word after a part numeral may be what the numeral
          // was (`- v němž`), so in running text a part is read only where
          // the entry ends on it.
          expect(intent.selector, entry).toEqual(
            tail.kind === "part" && after.length > 0
              ? { kind: "none" }
              : expectedSelector(tail),
          );
          expect(intent.embeddedIn).toBe(entry);
        },
      ),
      propertyConfig(),
    );
  });

  test("two different references in one entry name no single one", () => {
    fc.assert(
      fc.property(
        docketArbitrary,
        docketArbitrary,
        fc.array(proseWord, { maxLength: 2 }),
        (first, second, between) => {
          fc.pre(filed(first) !== filed(second));
          const entry = [filed(first), ...between, "a", filed(second)].join(
            " ",
          );
          expect(parseDecisionQuery(entry, CZE)).toEqual({
            type: "text",
            text: entry,
          });
        },
      ),
      propertyConfig(),
    );
  });

  test("a word after the docket is not a part numeral", () => {
    // `v` and `i` are Roman numerals and Czech words; only a dash makes one
    // a part of the reference.
    for (const entry of [
      "6 Tdo 512/2019 v trestní věci",
      "6 Tdo 512/2019 i dovolání",
      "6 Tdo 512/2019 V",
    ]) {
      expect(docketIntentOf(entry).selector, entry).toEqual({ kind: "none" });
      expect(docketIntentOf(entry).family, entry).toBe("6 Tdo 512/2019");
    }
    expect(docketIntentOf("6 Tdo 512/2019 - V.").selector).toEqual({
      kind: "part",
      value: "V",
    });
  });

  test("a dash and a short word in running text are not a part numeral", () => {
    // A window stops at a word boundary, so the word after `v` or `i` never
    // reaches the tail grammar; the guard reads the next word instead.
    for (const entry of [
      "rozsudek 30 Cdo 1/2020 – v němž soud uvedl",
      "rozsudek 30 Cdo 1/2020 - i když",
      "viz 30 Cdo 1/2020, i když",
      "viz 30 Cdo 1/2020 - I. senát",
    ]) {
      const intent = docketIntentOf(entry);
      expect(intent.selector, entry).toEqual({ kind: "none" });
      expect(intent.family, entry).toBe("30 Cdo 1/2020");
    }
    // A numeral closing on its dot before a capital, or ending the entry, is
    // the reference's own part.
    for (const [entry, value] of [
      ["viz 30 Cdo 1/2020 - II. Soud uvedl", "II"],
      ["rozsudek 30 Cdo 1/2020 - IV", "IV"],
      ["30 Cdo 1/2020 - v", "V"],
    ] as const) {
      expect(docketIntentOf(entry).selector, entry).toEqual({
        kind: "part",
        value,
      });
    }
  });

  test("a word after the reference never selects a sibling", () => {
    const siblings = [
      {
        id: "plain",
        caseNumber: "30 Cdo 1/2020",
        ecli: null,
        decisionDate: "2020-01-01",
      },
      {
        id: "part-five",
        caseNumber: "30 Cdo 1/2020 - V.",
        ecli: null,
        decisionDate: "2020-01-01",
      },
    ];
    for (const entry of [
      "rozsudek 30 Cdo 1/2020 – v němž soud uvedl",
      "rozsudek 30 Cdo 1/2020 - v tom",
    ]) {
      expect(
        resolveDecisionIdentity(docketIntentOf(entry), siblings),
        entry,
      ).toMatchObject({ status: "ambiguous", reason: "several" });
    }
  });

  test("a grammar whose trailing digits are the docket keeps them", () => {
    // A United States docket's number after the term is the case, not a
    // sheet; neither is a Polish tax signature's last group.
    const usa = parseDecisionQuery("No. 21-123", {
      grammar: DECISION_DOCKET_GRAMMARS.USA,
    });
    expect(usa).toMatchObject({
      family: "No. 21-123",
      selector: { kind: "none" },
    });
    const tax = readDecisionDocketReference("0114-KDIP1-2.4012.123.2024.1.AB", {
      grammar: DECISION_DOCKET_GRAMMARS.POL,
    });
    expect(tax?.selector).toEqual({ kind: "none" });
  });

  test("an entry that is not a reference stays text", () => {
    for (const text of [
      "náhrada škody",
      "§ 2910 občanského zákoníku",
      "4410/2019",
      "sp. zn.",
      "č. j. nájemní smlouva",
    ]) {
      expect(parseDecisionQuery(text, CZE)).toEqual({ type: "text", text });
    }
  });

  test("an ECLI among other words is read as that ECLI", () => {
    expect(
      parseDecisionQuery("viz ECLI:CZ:NS:2019:6.TDO.512.2019.2.", CZE),
    ).toEqual({
      type: "identifier",
      kind: "ecli",
      value: "ECLI:CZ:NS:2019:6.TDO.512.2019.2",
      embeddedIn: "viz ECLI:CZ:NS:2019:6.TDO.512.2019.2.",
    });
  });
});

describe("the stored spellings a file's members carry", () => {
  test("each tail spelling reads back as the file and the part it carries", () => {
    // One separator set drives both the stored spellings the file is read
    // under and the reader: a spelling the index is read under that the
    // reader would not take as its part would split the two.
    fc.assert(
      fc.property(docketArbitrary, (docket) => {
        const family = filed(docket);
        for (const spelling of decisionDocketTailSpellings(family)) {
          const reference = readDecisionDocketReference(spelling, CZE);
          expect(reference?.family.formatted, spelling).toBe(family);
          const numeral = /([IVX]+)\.$/u.exec(spelling)?.[1];
          expect(reference?.selector, spelling).toEqual(
            numeral === undefined
              ? { kind: "none" }
              : { kind: "part", value: numeral },
          );
        }
      }),
      propertyConfig({ numRuns: 40 }),
    );
  });

  test("each tail spelling trims back to the file it belongs to", () => {
    fc.assert(
      fc.property(docketArbitrary, (docket) => {
        const family = filed(docket);
        for (const spelling of decisionDocketTailSpellings(family)) {
          expect(storedDecisionDocketOf(spelling, "CZE"), spelling).toEqual({
            type: "trimmed",
            caseNumber: family,
            removed: spelling.slice(family.length),
          });
        }
      }),
      propertyConfig({ numRuns: 40 }),
    );
  });
});

describe("the sheet an ECLI carries", () => {
  test("is the number after the file's own numbers, and only that", () => {
    expect(
      ecliSheetOf("ECLI:CZ:NSS:2010:3.AFS.41.2008.98", "3afs41/2008"),
    ).toBe("98");
    // A scheme that ends on the decision's sequence number in its file, not
    // on a sheet, declares nothing: its last segment is never read as one.
    expect(
      ecliSheetOf("ECLI:CZ:NS:2019:6.TDO.512.2019.2", "6tdo512/2019"),
    ).toBeNull();
    expect(
      ecliSheetOf("ECLI:CZ:US:2005:4.US.23.05.1", "iv.ús23/05"),
    ).toBeNull();
    expect(
      ecliSheetOf("ECLI:SK:NSSR:2010:3.AFS.41.2008.98", "3afs41/2008"),
    ).toBeNull();
    // The last number is the docket's own year: no sheet.
    expect(ecliSheetOf("ECLI:CZ:US:2020:1.US.123.20", "i.ús123/20")).toBeNull();
    // Another file's ECLI carries no sheet of this one.
    expect(
      ecliSheetOf("ECLI:CZ:NSS:2010:3.AFS.42.2008.98", "3afs41/2008"),
    ).toBeNull();
    expect(ecliSheetOf("ECLI:EU:C:2014:317", "c-131/12")).toBeNull();
  });
});

type Hit = {
  id: string;
  caseNumber: string;
  ecli: string | null;
  decisionDate: string;
  identifiers?: { type: string; value: string }[];
  publishedCaseNumber?: string | null;
  sheetNumber?: string | null;
};

const resolve = (entry: string, hits: readonly Hit[]) =>
  resolveDecisionIdentity(docketIntentOf(entry), hits);

const idsOf = (resolution: ReturnType<typeof resolve>): string[] => {
  switch (resolution.status) {
    case "none":
      return [];
    case "unique":
      return [resolution.decision.id];
    case "ambiguous":
    case "incomplete_identifier":
      return resolution.candidates.map(({ id }) => id).toSorted();
    default: {
      resolution satisfies never;
      return panic("Unhandled resolution");
    }
  }
};

describe("resolving a reference to one decision or to its candidates", () => {
  // Two decisions of one file, issued the same day, told apart by their ECLI
  // and, for one, by the part the publisher left on its docket.
  const sameDay: readonly Hit[] = [
    {
      id: "part-one",
      caseNumber: "7 Tdo 100/2020- I.",
      ecli: "ECLI:CZ:NS:2020:7.TDO.100.2020.2",
      decisionDate: "2020-08-24",
    },
    {
      id: "plain",
      caseNumber: "7 Tdo 100/2020",
      ecli: "ECLI:CZ:NS:2020:7.TDO.100.2020.4",
      decisionDate: "2020-08-24",
    },
  ];

  test("a bare docket names every decision of the file, never one of them", () => {
    for (const entry of [
      "7 Tdo 100/2020",
      "sp. zn. 7 Tdo 100/2020",
      "7Tdo100/2020",
    ]) {
      const resolution = resolve(entry, sameDay);
      expect(resolution).toMatchObject({
        status: "ambiguous",
        reason: "several",
      });
      expect(idsOf(resolution)).toEqual(["part-one", "plain"]);
    }
  });

  test("a general court's ECLI sequence number is not a printed sheet", () => {
    // `.2` and `.4` count the file's decisions; `-4` printed after the docket
    // names a sheet neither is known to carry.
    for (const entry of ["7 Tdo 100/2020-4", "7 Tdo 100/2020 – 2"]) {
      expect(resolve(entry, sameDay), entry).toMatchObject({
        status: "ambiguous",
        reason: "selector_unmatched",
      });
      expect(idsOf(resolve(entry, sameDay))).toEqual(["part-one", "plain"]);
    }
  });

  test("an ECLI, a sheet or a part names exactly its decision", () => {
    const ecli = resolveDecisionIdentity(
      {
        type: "identifier",
        kind: "ecli",
        value: "ecli:cz:ns:2020:7.tdo.100.2020.2",
      },
      sameDay,
    );
    expect(ecli).toMatchObject({ status: "unique", basis: "identifier" });
    expect(idsOf(ecli)).toEqual(["part-one"]);
    expect(resolve("7 Tdo 100/2020 - I.", sameDay)).toMatchObject({
      status: "unique",
      basis: "selector",
    });
    expect(idsOf(resolve("7 Tdo 100/2020 - I.", sameDay))).toEqual([
      "part-one",
    ]);
  });

  // The administrative court's file numbers: the sheet is the last ECLI
  // segment, and the file's decisions are years apart.
  const sheets: readonly Hit[] = [
    {
      id: "sheet-86",
      caseNumber: "3 Afs 41/2008",
      ecli: "ECLI:CZ:NSS:2008:3.AFS.41.2008.86",
      decisionDate: "2008-07-22",
    },
    {
      id: "sheet-98",
      caseNumber: "3 Afs 41/2008",
      ecli: "ECLI:CZ:NSS:2010:3.AFS.41.2008.98",
      decisionDate: "2010-01-12",
    },
    {
      // No ECLI: the publisher supplied the full file number beside the
      // docket instead.
      id: "sheet-109",
      caseNumber: "3 Afs 41/2008",
      ecli: null,
      identifiers: [{ type: "case-number", value: "3 Afs 41/2008 - 109" }],
      decisionDate: "2010-02-09",
    },
  ];

  test("each sheet names its own decision, whatever the dash", () => {
    for (const [entry, id] of [
      ["3 Afs 41/2008 - 86", "sheet-86"],
      ["3 Afs 41/2008-98", "sheet-98"],
      ["č. j. 3 Afs 41/2008–109", "sheet-109"],
      ["3 Afs 41/2008 — 098", "sheet-98"],
    ] as const) {
      expect(resolve(entry, sheets), entry).toMatchObject({
        status: "unique",
        basis: "selector",
      });
      expect(idsOf(resolve(entry, sheets)), entry).toEqual([id]);
    }
  });

  // A sibling whose sheet is not known, for the sheets no decision carries.
  const unsheeted: Hit = {
    id: "unsheeted",
    caseNumber: "3 Afs 41/2008",
    ecli: null,
    decisionDate: "2011-03-01",
  };

  test("a sheet is compared whole, never as a suffix of another", () => {
    // 8 is the end of 98 and 9 the end of 109: neither is that sheet.
    for (const entry of ["3 Afs 41/2008-8", "3 Afs 41/2008-9"]) {
      const resolution = resolve(entry, [...sheets, unsheeted]);
      expect(resolution, entry).toMatchObject({
        status: "ambiguous",
        reason: "selector_unmatched",
      });
      expect(idsOf(resolution)).toEqual(["unsheeted"]);
    }
  });

  test("an unheld sheet returns the siblings whose sheet is unknown, never one known under another", () => {
    const resolution = resolve("3 Afs 41/2008 - 50", [...sheets, unsheeted]);
    expect(resolution).toMatchObject({
      status: "ambiguous",
      reason: "selector_unmatched",
    });
    expect(idsOf(resolution)).toEqual(["unsheeted"]);
    // Every sibling known under another sheet: nothing answers, as when the
    // read reaches none.
    expect(resolve("3 Afs 41/2008 - 50", sheets)).toEqual({ status: "none" });
    expect(resolve("3 Afs 41/2008 - 50", sheets.slice(0, 1))).toEqual({
      status: "none",
    });
  });

  test("a sheet no candidate is known to carry never names the file's one decision", () => {
    // The file shows one decision, with no sheet known: it may be a sibling
    // of the one named, so it is listed, never chosen.
    const lone: readonly Hit[] = [
      {
        id: "lone",
        caseNumber: "3 Afs 41/2008",
        ecli: null,
        decisionDate: "2008-07-22",
      },
    ];
    for (const entry of ["3 Afs 41/2008-86", "3 Afs 41/2008 - II."]) {
      expect(resolve(entry, lone), entry).toMatchObject({
        status: "ambiguous",
        reason: "selector_unmatched",
      });
    }
  });

  test("the sheet a source recorded, alone or in its published reference, selects", () => {
    const recorded: readonly Hit[] = [
      {
        id: "by-sheet",
        caseNumber: "3 Afs 41/2008",
        ecli: null,
        decisionDate: "2010-05-03",
        sheetNumber: "120",
      },
      {
        id: "by-reference",
        caseNumber: "3 Afs 41/2008",
        ecli: null,
        decisionDate: "2010-06-14",
        publishedCaseNumber: "3 Afs 41/2008 - 131",
      },
    ];
    expect(idsOf(resolve("3 Afs 41/2008-120", recorded))).toEqual(["by-sheet"]);
    expect(idsOf(resolve("3 Afs 41/2008 – 131", recorded))).toEqual([
      "by-reference",
    ]);
    // A different recorded sheet is never accepted for the one named.
    expect(resolve("3 Afs 41/2008-12", recorded.slice(0, 1))).toEqual({
      status: "none",
    });
  });

  test("a bare docket's lone decision is not claimed where siblings can hide under a sheet", () => {
    const lone = [
      {
        id: "lone",
        caseNumber: "3 Afs 41/2008",
        ecli: null,
        decisionDate: "2008-07-22",
      },
    ];
    expect(resolve("3 Afs 41/2008", lone)).toMatchObject({
      status: "incomplete_identifier",
      missing: ["sheet"],
    });
    // A jurisdiction whose stored dockets never carry a sheet names it.
    const read = parseDecisionQuery("II CSK 123/19", {
      grammar: DECISION_DOCKET_GRAMMARS.POL,
    });
    const polish =
      read.type === "identifier" ? read : panic("Not an identifier");
    expect(
      resolveDecisionIdentity(polish, [
        {
          id: "pl",
          caseNumber: "II CSK 123/19",
          ecli: null,
          decisionDate: "2019-01-01",
        },
      ]),
    ).toMatchObject({ status: "unique", basis: "docket" });
  });

  test("decisions of one file on different dates are never collapsed", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.date({
            min: new Date("2000-01-01"),
            max: new Date("2030-01-01"),
            noInvalidDate: true,
          }),
          { minLength: 2, maxLength: 6, selector: (date) => date.getTime() },
        ),
        (dates) => {
          const hits = dates.map((date, index) => ({
            id: `d${String(index)}`,
            caseNumber: "3 Afs 41/2008",
            ecli: null,
            decisionDate: date.toISOString().slice(0, 10),
          }));
          const resolution = resolve("3 Afs 41/2008", hits);
          expect(resolution.status).toBe("ambiguous");
          expect(idsOf(resolution)).toHaveLength(hits.length);
        },
      ),
      propertyConfig(),
    );
  });

  test("a resolution only ever names hits of the file, and one only when it can tell", () => {
    // Any mix of siblings, sheets and an unrelated docket: a unique answer is
    // always the one decision of the file that carries the sheet asked for.
    const sheetOrNull = fc.option(fc.integer({ min: 1, max: 200 }), {
      nil: null,
    });
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sibling: fc.boolean(),
            sheet: sheetOrNull,
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
        (rows, asked) => {
          const hits: Hit[] = rows.map(({ sheet, sibling }, index) => {
            const docket = sibling ? "3 Afs 41/2008" : "3 Afs 42/2008";
            return {
              id: `h${String(index)}`,
              caseNumber: docket,
              ecli:
                sheet === null
                  ? null
                  : `ECLI:CZ:NSS:2010:3.AFS.${sibling ? "41" : "42"}.2008.${String(sheet)}`,
              decisionDate: "2010-01-01",
            };
          });
          const sheetOf = (hit: Hit): string | null =>
            hit.ecli?.split(".").at(-1) ?? null;
          const family = hits.filter(
            ({ caseNumber }) => caseNumber === "3 Afs 41/2008",
          );
          const entry =
            asked === null ? "3 Afs 41/2008" : `3 Afs 41/2008-${String(asked)}`;
          const resolution = resolve(entry, hits);
          for (const id of idsOf(resolution)) {
            expect(family.map((hit) => hit.id)).toContain(id);
          }
          if (resolution.status !== "unique") {
            return;
          }
          // Only a printed sheet exactly one candidate carries names one: a
          // bare docket never does here, and no other sheet is accepted.
          const chosen = resolution.decision;
          expect(asked).not.toBeNull();
          expect(sheetOf(chosen)).toBe(String(asked));
          expect(
            family.filter((hit) => sheetOf(hit) === String(asked)),
          ).toHaveLength(1);
        },
      ),
      propertyConfig(),
    );
  });
});

/** A Slovak docket as a court files it: senate and registry glued, slashes. */
const slovakDocketArbitrary = fc.record({
  senate: fc.integer({ min: 1, max: 99 }),
  registry: fc.constantFrom("Obo", "Cdo", "Tdo", "Sžo", "Ndc", "Co", "Ndt"),
  number: fc.integer({ min: 1, max: 9999 }),
  year: fc.integer({ min: 1993, max: 2030 }),
});

/** Every way a Slovak publisher stores one member of a file. */
const slovakSpellingOf = ({
  number,
  registry,
  senate,
  year,
}: {
  number: number;
  registry: string;
  senate: number;
  year: number;
}) =>
  fc
    .record({
      senateGap: fc.constantFrom("", " "),
      numberGap: fc.constantFrom("/", " "),
      tail: tailArbitrary,
      dash: fc.constantFrom(...DASHES),
      dashGap: fc.constantFrom(["", ""], [" ", " "]),
      lower: fc.boolean(),
    })
    .map(
      ({
        dash,
        dashGap: [before, after],
        lower,
        numberGap,
        senateGap,
        tail,
      }) => {
        const mark = lower ? registry.toLowerCase() : registry;
        const docket = `${String(senate)}${senateGap}${mark}${numberGap}${String(number)}/${String(year)}`;
        if (tail.kind === "sheet") {
          return `${docket}${before}${dash}${after}${String(tail.value)}`;
        }
        if (tail.kind === "part") {
          return `${docket}${before}${dash}${after}${tail.value}.`;
        }
        return docket;
      },
    );

describe("the case-file key a stored docket is kept under", () => {
  test("every stored spelling of a Czech file's member keys as the file", () => {
    fc.assert(
      fc.property(referenceArbitrary, ({ docket, entry }) => {
        const key = docketFamilyKeyOf(entry, "CZE");
        expect(key, entry).not.toBeNull();
        expect(key, entry).toBe(docketFamilyKeyOf(filed(docket), "CZE"));
      }),
      propertyConfig(),
    );
  });

  test("every part and junk tail a member is stored under keys as its file", () => {
    fc.assert(
      fc.property(docketArbitrary, (docket) => {
        const family = filed(docket);
        const key = docketFamilyKeyOf(family, "CZE");
        for (const spelling of decisionDocketTailSpellings(family)) {
          expect(docketFamilyKeyOf(spelling, "CZE"), spelling).toBe(key);
        }
      }),
      propertyConfig(),
    );
  });

  test("every stored spelling of a Slovak file's member keys as the file", () => {
    fc.assert(
      fc.property(
        slovakDocketArbitrary.chain((docket) =>
          slovakSpellingOf(docket).map((stored) => ({ docket, stored })),
        ),
        ({ docket, stored }) => {
          const filedDocket = `${String(docket.senate)}${docket.registry}/${String(docket.number)}/${String(docket.year)}`;
          const key = docketFamilyKeyOf(stored, "SVK");
          expect(key, stored).not.toBeNull();
          expect(key, stored).toBe(docketFamilyKeyOf(filedDocket, "SVK"));
        },
      ),
      propertyConfig(),
    );
  });

  test("two different files never share a key", () => {
    fc.assert(
      fc.property(
        docketArbitrary,
        docketArbitrary,
        tailArbitrary,
        tailArbitrary,
        (left, right, leftTail, rightTail) => {
          fc.pre(filed(left).toLowerCase() !== filed(right).toLowerCase());
          const spelled = (docket: Docket, tail: Tail): string =>
            tail.kind === "none"
              ? filed(docket)
              : `${filed(docket)} - ${String(tail.value)}${tail.kind === "part" ? "." : ""}`;
          expect(docketFamilyKeyOf(spelled(left, leftTail), "CZE")).not.toBe(
            docketFamilyKeyOf(spelled(right, rightTail), "CZE"),
          );
        },
      ),
      propertyConfig(),
    );
  });

  test.each([
    ["1 Afs 27/2009", "1 Afs 27/2009 - 86"],
    ["1 Afs 27/2009", "1 Afs 27/2009-98"],
    ["1 Afs 27/2009", "1 Afs 27/2009–109"],
    ["1 Afs 27/2009", "č. j. 1 Afs 27/2009-86"],
    ["4 As 50/2012", "4 As 50/2012 - 33"],
    ["4 As 50/2012", "4As 50/2012-33"],
    ["4 As 50/2012", "4 As 50/2012-0033"],
    ["6 Tdo 794/2021", "6 Tdo 794/2021- I."],
    ["31 Cdo 2273/2022", "31 Cdo 2273/2022-150"],
    ["31 Cdo 2273/2022", "sp. zn. 31 Cdo 2273/2022"],
    ["II. ÚS 251/04", "II. ÚS 251/04-45"],
    ["II. ÚS 251/04", "II.ÚS 251/04-45"],
    ["Pl. ÚS 38/06", "Pl. ÚS 38/06-60"],
  ])(
    "a Czech member stored as %p's sibling %p keys as its file",
    (family, stored) => {
      expect(docketFamilyKeyOf(stored, "CZE")).toBe(
        docketFamilyKeyOf(family, "CZE"),
      );
      expect(docketFamilyKeyOf(family, "CZE")).not.toBeNull();
    },
  );

  test.each([
    ["5Obo/12/2019", "5Obo/12/2019 - 45"],
    ["5Obo/12/2019", "5 Obo 12/2019-45"],
    ["5Obo/12/2019", "5Obo/12/2019 - II."],
    ["2Sžo/45/2018", "2Szo/45/2018"],
    ["III. ÚS 66/98", "III. ÚS 66/98-12"],
  ])(
    "a Slovak member stored as %p's sibling %p keys as its file",
    (family, stored) => {
      expect(docketFamilyKeyOf(stored, "SVK")).toBe(
        docketFamilyKeyOf(family, "SVK"),
      );
      expect(docketFamilyKeyOf(family, "SVK")).not.toBeNull();
    },
  );

  test("files that share a prefix stay apart", () => {
    expect(docketFamilyKeyOf("1 Afs 27/2009", "CZE")).not.toBe(
      docketFamilyKeyOf("1 Afs 2/2009", "CZE"),
    );
    expect(docketFamilyKeyOf("12Co/345/2017", "SVK")).not.toBe(
      docketFamilyKeyOf("12Co/34/2017", "SVK"),
    );
  });

  test("no key where the docket does not parse or the jurisdiction has no grammar", () => {
    expect(docketFamilyKeyOf("KSCB 26 INS 8270/2018-A-15", "CZE")).toBeNull();
    expect(docketFamilyKeyOf("1 Afs 27/2009", "XXX")).toBeNull();
    expect(docketFamilyKeyOf("", "CZE")).toBeNull();
  });
});

/** The ends of the range every fixture docket is numbered in. */
const FIXTURE_NUMBERS = [1, DOCKET_IDENTITY_FIXTURE_NUMBER_MAX] as const;

/** A trailing number no sheetless grammar may read as a sheet. */
const PROBE_SHEET = "33";

test("a reader entry reads as its file, in a spelling its grammar keeps", () => {
  // The family is what the lookup keys like a stored docket: the grammar's
  // format of it is a fixed point, under the filed docket's case-file key,
  // with or without a part after it.
  const part = DOCKET_IDENTITY_PART_NUMERAL;
  assertProperty(
    "a reader entry reads as its file, in a spelling its grammar keeps",
    fc.property(
      docketReaderEntryArbitrary,
      fc.boolean(),
      ({ entry, filed: stored, jurisdiction }, withPart) => {
        const grammar = DECISION_DOCKET_GRAMMARS[jurisdiction];
        const label = `${jurisdiction}: ${entry}`;
        const canonicalOf = (docket: string) =>
          readDecisionDocketReference(docket, { grammar })?.family.canonical;
        expect(
          parseDecisionDocket(stored, { grammar })?.formatted,
          `${jurisdiction}: ${stored}`,
        ).toBe(stored);
        const read = parseDecisionQuery(
          withPart ? `${entry} - ${part}.` : entry,
          { grammar },
        );
        const intent =
          read.type === "identifier" && read.kind === "docket"
            ? read
            : panic(`Not a docket: ${label}`);
        expect(intent.jurisdiction, label).toBe(jurisdiction);
        expect(intent.selector, label).toEqual(
          withPart ? { kind: "part", value: part } : { kind: "none" },
        );
        expect(canonicalOf(intent.family), label).toBe(canonicalOf(stored));
        expect(canonicalOf(stored), label).toBeDefined();
        expect(
          parseDecisionDocket(intent.family, { grammar })?.formatted,
          label,
        ).toBe(intent.family);
      },
    ),
    propertyConfig(),
  );
});

describe.each(
  Object.values(DECISION_DOCKET_GRAMMARS).map(
    ({ jurisdiction }) => jurisdiction,
  ),
)("a %s case file and its siblings", (jurisdiction) => {
  const grammar = DECISION_DOCKET_GRAMMARS[jurisdiction];
  const fixture = DECISION_DOCKET_IDENTITY_FIXTURES[jurisdiction];
  const { sheet } = fixture;
  const part = DOCKET_IDENTITY_PART_NUMERAL;

  const intentOf = (
    entry: string,
  ): Extract<DecisionIdentifierIntent, { kind: "docket" }> => {
    const intent = parseDecisionQuery(entry, { grammar });
    return intent.type === "identifier" && intent.kind === "docket"
      ? intent
      : panic(`Not a ${jurisdiction} docket: ${entry}`);
  };

  const canonicalOf = (docket: string): string =>
    readDecisionDocketReference(docket, { grammar })?.family.canonical ??
    panic(`Not a ${jurisdiction} docket: ${docket}`);

  test("the filed docket and every reader spelling read as one file", () => {
    for (const n of FIXTURE_NUMBERS) {
      const docket = fixture.filed(n);
      expect(parseDecisionDocket(docket, { grammar })?.formatted, docket).toBe(
        docket,
      );
      const key = docketFamilyKeyOf(docket, jurisdiction);
      expect(key, docket).not.toBeNull();
      for (const entry of fixture.readerSpellings(n)) {
        expect(entry, entry).not.toBe(docket);
        const intent = intentOf(entry);
        expect(intent.jurisdiction, entry).toBe(jurisdiction);
        expect(intent.selector, entry).toEqual({ kind: "none" });
        expect(canonicalOf(intent.family), entry).toBe(canonicalOf(docket));
        expect(docketFamilyKeyOf(entry, jurisdiction), entry).toBe(key);
      }
      // The next number is another file.
      expect(docketFamilyKeyOf(fixture.filed(n + 1), jurisdiction)).not.toBe(
        key,
      );
    }
  });

  test("a sibling stored with a part numeral keys and reads as its file", () => {
    for (const n of FIXTURE_NUMBERS) {
      const docket = fixture.filed(n);
      const stored = `${docket} - ${part}.`;
      expect(docketFamilyKeyOf(stored, jurisdiction), stored).toBe(
        docketFamilyKeyOf(docket, jurisdiction),
      );
      const intent = intentOf(stored);
      expect(canonicalOf(intent.family), stored).toBe(canonicalOf(docket));
      expect(intent.selector, stored).toEqual({ kind: "part", value: part });
    }
  });

  switch (sheet.type) {
    case "supported":
      test("a sibling stored with its sheet keys as its file, and the sheet is its selector", () => {
        for (const n of FIXTURE_NUMBERS) {
          const docket = fixture.filed(n);
          for (const stored of [
            `${docket}-${sheet.held}`,
            `${docket} - ${sheet.held}`,
          ]) {
            expect(docketFamilyKeyOf(stored, jurisdiction), stored).toBe(
              docketFamilyKeyOf(docket, jurisdiction),
            );
            const intent = intentOf(stored);
            expect(canonicalOf(intent.family), stored).toBe(
              canonicalOf(docket),
            );
            expect(intent.selector, stored).toEqual({
              kind: "sheet",
              value: sheet.held,
            });
          }
        }
      });
      break;
    case "unsupported":
      test("a trailing number is never read as a sheet, as the fixture declares", () => {
        // A grammar that starts reading sheets has to declare them here.
        for (const n of FIXTURE_NUMBERS) {
          const entry = `${fixture.filed(n)}-${PROBE_SHEET}`;
          expect(
            readDecisionDocketReference(entry, { grammar })?.selector.kind,
            entry,
          ).not.toBe("sheet");
        }
      });
      break;
    default: {
      sheet satisfies never;
      panic("Unhandled sheet scenario");
    }
  }

  describe("resolving among one day's siblings", () => {
    const n = DOCKET_IDENTITY_FIXTURE_NUMBER_MAX;
    const docket = fixture.filed(n);
    const day = "2020-08-24";
    const plain: Hit = {
      id: "plain",
      caseNumber: docket,
      ecli: null,
      decisionDate: day,
    };
    const partSibling: Hit = {
      id: "part",
      caseNumber: `${docket} - ${part}.`,
      ecli: null,
      decisionDate: day,
    };
    const sheetSiblings: readonly Hit[] =
      sheet.type === "supported"
        ? [
            {
              id: "sheet",
              caseNumber: `${docket} - ${sheet.held}`,
              ecli: null,
              decisionDate: day,
            },
          ]
        : [];
    const otherFile: Hit = {
      id: "other-file",
      caseNumber: fixture.filed(n + 1),
      ecli: null,
      decisionDate: day,
    };
    const siblings = [plain, partSibling, ...sheetSiblings];
    const hits = [...siblings, otherFile];
    const resolved = (entry: string, among: readonly Hit[]) =>
      resolveDecisionIdentity(intentOf(entry), among);
    const fileIds = siblings.map(({ id }) => id).toSorted();

    test("a bare docket names every sibling, never one and never another file", () => {
      for (const entry of [docket, ...fixture.readerSpellings(n)]) {
        const resolution = resolved(entry, hits);
        expect(resolution, entry).toMatchObject({
          status: "ambiguous",
          reason: "several",
        });
        expect(idsOf(resolution), entry).toEqual(fileIds);
      }
    });

    test("the part on a stored docket names exactly its sibling", () => {
      for (const entry of [`${docket} - ${part}.`, `${docket}-${part}`]) {
        const resolution = resolved(entry, hits);
        expect(resolution, entry).toMatchObject({
          status: "unique",
          basis: "selector",
        });
        expect(idsOf(resolution), entry).toEqual(["part"]);
      }
    });

    if (sheet.type === "supported") {
      test("the sheet names exactly its sibling, and an unheld sheet every sibling not under another sheet", () => {
        const named = resolved(`${docket}-${sheet.held}`, hits);
        expect(named).toMatchObject({ status: "unique", basis: "selector" });
        expect(idsOf(named)).toEqual(["sheet"]);
        const unheld = resolved(`${docket}-${sheet.unheld}`, hits);
        expect(unheld).toMatchObject({
          status: "ambiguous",
          reason: "selector_unmatched",
        });
        expect(idsOf(unheld)).toEqual(["part", "plain"]);
      });
    }

    test("a lone decision is claimed only where no sibling can hide under a sheet", () => {
      const resolution = resolved(docket, [plain, otherFile]);
      expect(resolution).toMatchObject(
        DECISION_DOCKETS_STORED_WITH_SHEETS[jurisdiction]
          ? { status: "incomplete_identifier", missing: ["sheet"] }
          : { status: "unique", basis: "docket" },
      );
      expect(idsOf(resolution)).toEqual(["plain"]);
    });
  });
});
