import { describe, expect, test } from "bun:test";

import type { BirthDate, EntityType, Identifier } from "./entry";
import { buildPartyIndex } from "./party-screening";
import type { ScreenedParty } from "./party-screening";
import { DEFAULT_CUTOFF, screenRecords } from "./screening";
import type { ScreeningQuery } from "./screening";

// Every party below is synthetic.
type PartyInput = {
  ref: string;
  entityType: EntityType;
  names: string[];
  birthDate?: BirthDate;
  identifiers?: string[];
};

const party = ({
  ref,
  entityType,
  names,
  birthDate,
  identifiers = [],
}: PartyInput): ScreenedParty<string> => ({
  ref,
  entityType,
  names: names.map((name) => ({ name, quality: "strong" })),
  birthDates: birthDate === undefined ? [] : [birthDate],
  nationalities: [],
  identifiers: identifiers.map((number): Identifier => ({
    kind: "registration",
    status: "listed",
    label: "Company ID",
    number,
    country: null,
  })),
});

const PARTIES = [
  party({
    ref: "dvorak",
    entityType: "person",
    names: ["Jan Dvořák"],
    birthDate: {
      precision: "day",
      year: 1971,
      month: 4,
      day: 12,
      circa: false,
    },
  }),
  party({
    ref: "svobodova",
    entityType: "person",
    names: ["Petra Svobodová"],
  }),
  party({
    ref: "acme",
    entityType: "organisation",
    names: ["Acme Holding, spol. s r.o."],
    identifiers: ["123 456 78"],
  }),
  party({
    ref: "nordwind",
    entityType: "organisation",
    names: ["Nordwind Logistik GmbH"],
  }),
  party({
    ref: "kralova",
    entityType: "person",
    names: ["Eva Králová"],
  }),
];

const index = buildPartyIndex(PARTIES, (left, right) =>
  left.localeCompare(right),
);

const found = (query: ScreeningQuery, cutoff = DEFAULT_CUTOFF) =>
  screenRecords(index, query, { cutoff }).unwrap().possibleMatches;

const refs = (query: ScreeningQuery) =>
  found(query).map(({ entry }) => entry.ref);

describe("party screening", () => {
  test("folds case and diacritics", () => {
    expect(refs({ name: "JAN DVORAK", entityType: "person" })).toContain(
      "dvorak",
    );
    expect(refs({ name: "petra svobodova", entityType: "person" })).toContain(
      "svobodova",
    );
  });

  test("reads a person's names in either order", () => {
    expect(refs({ name: "Dvořák Jan", entityType: "person" })).toContain(
      "dvorak",
    );
    expect(refs({ name: "Králová, Eva", entityType: "person" })).toContain(
      "kralova",
    );
  });

  test("tolerates a one-letter typo", () => {
    expect(refs({ name: "Petra Svobdová", entityType: "person" })).toContain(
      "svobodova",
    );
  });

  test("ignores Czech and German legal forms in any spelling", () => {
    for (const name of [
      "ACME HOLDING s.r.o.",
      "Acme Holding a.s.",
      "Acme Holding GmbH",
      "Acme Holding UG (haftungsbeschränkt)",
      "Acme Holding Gesellschaft mit beschränkter Haftung",
      "Acme Holding AG",
      "Acme Holding Ltd",
      "Acme Holding",
    ]) {
      expect(refs({ name, entityType: "organisation" })).toContain("acme");
    }
    for (const name of [
      "Nordwind Logistik mbH",
      "Nordwind Logistik OHG",
      "Nordwind Logistik e.K.",
      "Nordwind Logistik PartG mbB",
      "Nordwind Logistik PartGmbB",
      "Nordwind Logistik PartG",
      "Nordwind Logistik s.r.o.",
    ]) {
      expect(refs({ name, entityType: "organisation" })).toContain("nordwind");
    }
  });

  test("matches an identifier in any formatting, whatever the name", () => {
    const [match] = found({
      name: "Completely Different Name",
      entityType: "organisation",
      identifiers: ["12345678"],
    });
    expect(match?.entry.ref).toBe("acme");
    expect(match?.score).toBe(1);
    expect(match?.evidence.identifier).toBe("match");
    expect(match?.evidence.matchedName).toBeNull();
  });

  test("reports a differing identifier without hiding a name match", () => {
    const [match] = found({
      name: "Acme Holding s.r.o.",
      entityType: "organisation",
      identifiers: ["87654321"],
    });
    expect(match?.entry.ref).toBe("acme");
    expect(match?.evidence.identifier).toBe("mismatch");
  });

  test("lets a birth date confirm or contradict a person match", () => {
    const scoreWith = (birthDate: ScreeningQuery["birthDate"]) =>
      found(
        {
          name: "Jan Dvořák",
          entityType: "person",
          ...(birthDate === undefined ? {} : { birthDate }),
        },
        0,
      ).find(({ entry }) => entry.ref === "dvorak");
    const sameDay = scoreWith({ year: 1971, month: 4, day: 12 });
    const nameOnly = scoreWith(undefined);
    const otherDay = scoreWith({ year: 1985, month: 1, day: 3 });
    expect(sameDay?.evidence.birthDate).toBe("match");
    expect(nameOnly?.evidence.birthDate).toBe("not-compared");
    expect(otherDay?.evidence.birthDate).toBe("mismatch");
    expect(otherDay?.evidence.conflicts).toContain("birth-date");
    expect(sameDay?.score ?? 0).toBeGreaterThanOrEqual(nameOnly?.score ?? 1);
    // An exact name keeps its report at the cutoff even when the birth date
    // disagrees.
    expect(
      refs({
        name: "Jan Dvořák",
        entityType: "person",
        birthDate: { year: 1985, month: 1, day: 3 },
      }),
    ).toContain("dvorak");
  });

  test("names an entity-type contradiction in the evidence", () => {
    const match = found(
      { name: "Petra Svobodová", entityType: "organisation" },
      0,
    ).find(({ entry }) => entry.ref === "svobodova");
    expect(match?.evidence.entityType).toBe("mismatch");
    expect(match?.evidence.conflicts).toContain("entity-type");
  });

  test("does not report unrelated names", () => {
    expect(refs({ name: "Tomáš Procházka", entityType: "person" })).toEqual([]);
    expect(refs({ name: "Blue Harbour Shipping Ltd" })).toEqual([]);
  });

  test("orders equal scores by the caller's comparison, not build order", () => {
    const twins = [
      party({ ref: "b", entityType: "person", names: ["Anna Malá"] }),
      party({ ref: "a", entityType: "person", names: ["Anna Malá"] }),
    ];
    const forward = buildPartyIndex(twins, (left, right) =>
      left.localeCompare(right),
    );
    const backward = buildPartyIndex(twins.toReversed(), (left, right) =>
      left.localeCompare(right),
    );
    const order = (built: typeof forward) =>
      screenRecords(built, { name: "Anna Malá" }, { cutoff: DEFAULT_CUTOFF })
        .unwrap()
        .possibleMatches.map(({ entry }) => entry.ref);
    expect(order(forward)).toEqual(["a", "b"]);
    expect(order(backward)).toEqual(["a", "b"]);
  });

  test("indexes an empty party set", () => {
    const empty = buildPartyIndex<string>([], (left, right) =>
      left.localeCompare(right),
    );
    expect(
      screenRecords(
        empty,
        { name: "Jan Dvořák" },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches,
    ).toEqual([]);
  });
});
