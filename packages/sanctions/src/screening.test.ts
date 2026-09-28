import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseCzList } from "./cz";
import type { EntityType, ParsedList, SanctionsEntry } from "./entry";
import { parseEuList } from "./eu";
import { DEFAULT_CUTOFF, buildScreeningIndex, screen } from "./screening";
import type { ScreeningQuery } from "./screening";
import { parseUnList } from "./un";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const CZ_FILE = "Vnitrostatni_sankcni_seznam_2026_07_23.csv";

// Built once from the checked-in excerpts and never mutated.
const lists = [
  (
    await parseEuList(Bun.file(path.join(FIXTURES, "eu.xml")).stream())
  ).unwrap(),
  (
    await parseUnList(Bun.file(path.join(FIXTURES, "un.xml")).stream())
  ).unwrap(),
  parseCzList({
    csv: await Bun.file(path.join(FIXTURES, CZ_FILE)).text(),
    fileNameOrUrl: CZ_FILE,
  }).unwrap(),
];
const index = buildScreeningIndex(lists);

const PUTIN = "eu:135909";
const LUKASHENKO = "eu:126365";
const KOREA_SAMMA = ["eu:116198", "un:6908678"];
const VOICE_OF_EUROPE = ["cz:Voice of Europe s.r.o.", "eu:165994"];
const GUNDYAEV = "cz:GUNĎAJEV Vladimir Michajlovič 1946-11-20";
const KHARAZISHVILI = "cz:KHARAZISHVILI Zviad 1975-03-20";

const EXTRA_VERSION = {
  source: "eu",
  publishedAt: "2026-09-22",
  fileId: null,
} as const;

type ListedOptions = {
  sourceId: string;
  entityType: EntityType;
  name: string;
};

const listed = ({
  sourceId,
  entityType,
  name,
}: ListedOptions): SanctionsEntry => ({
  source: "eu",
  sourceId,
  referenceNumber: null,
  entityType,
  names: [{ name, quality: "strong" }],
  birthDates: [],
  nationalities: [],
  identifiers: [],
  addresses: [],
  programme: null,
  legalBasis: null,
  listedOn: null,
  sourceUrl: "https://eur-lex.europa.eu/",
});

const listedPerson = (sourceId: string, name: string): SanctionsEntry =>
  listed({ sourceId, entityType: "person", name });

const matches = (query: ScreeningQuery, cutoff = DEFAULT_CUTOFF) =>
  screen(index, query, { cutoff }).unwrap().possibleMatches;

const keys = (query: ScreeningQuery, cutoff = DEFAULT_CUTOFF) =>
  matches(query, cutoff).map(
    ({ entry }) => `${entry.source}:${entry.sourceId}`,
  );

const scoreOf = (query: ScreeningQuery, key: string) =>
  matches(query, 0).find(
    ({ entry }) => `${entry.source}:${entry.sourceId}` === key,
  )?.score ?? 0;

describe("name screening", () => {
  test("matches a listed person however the name is written", () => {
    for (const name of [
      "Vladimir Putin",
      "Putin, Vladimir Vladimirovich",
      "Владимир Путин",
      "Wladimir Putin",
      "Vladimir Poutine",
    ]) {
      expect(keys({ name })).toContain(PUTIN);
    }
    for (const name of [
      "Alexandr Lukašenko",
      "LUKASHENKO Aleksandr",
      "Aljaksandr Lukašenka",
    ]) {
      expect(keys({ name })).toContain(LUKASHENKO);
    }
    expect(keys({ name: "Gundyaev Vladimir" })).toContain(GUNDYAEV);
  });

  test("transliterates Cyrillic input and folds other transcriptions", () => {
    // The Czech list spells him only in Latin and Georgian.
    expect(keys({ name: "Звиад Харазишвили" })).toContain(KHARAZISHVILI);
    // The German transcription is four edits from the listed spelling.
    expect(keys({ name: "Zwiad Charasischwili" })).toContain(KHARAZISHVILI);
  });

  test("tolerates a missing middle name or patronymic", () => {
    expect(scoreOf({ name: "Vladimir Putin" }, PUTIN)).toBeGreaterThanOrEqual(
      0.9,
    );
  });

  test("reads names split or joined differently", () => {
    // Real EU aliases, each listed without the other spelling.
    const extra: ParsedList = {
      version: EXTRA_VERSION,
      entries: [
        listedPerson("split", "Aziz HAJMOHAM-MADI"),
        listedPerson("joined", "Noorollah Azizmohammadi"),
      ],
    };
    const withExtra = buildScreeningIndex([...lists, extra]);
    const found = (name: string) =>
      screen(withExtra, { name }, { cutoff: DEFAULT_CUTOFF })
        .unwrap()
        .possibleMatches.map(({ entry }) => entry.sourceId);
    expect(found("Aziz Hajmohammadi")).toContain("split");
    expect(found("Noorollah Aziz Mohammadi")).toContain("joined");
  });

  test("still sees a typo that breaks a transcription digraph", () => {
    // A real EU alias; "tp" no longer reads as "ts".
    const extra: ParsedList = {
      version: EXTRA_VERSION,
      entries: [listedPerson("typo", "Mikail Safarbekovitj GUTSERIJEV")],
    };
    const withExtra = buildScreeningIndex([...lists, extra]);
    const result = screen(
      withExtra,
      { name: "Mikail Safarbekovitj GUTpSERIJEV" },
      { cutoff: DEFAULT_CUTOFF },
    ).unwrap();
    expect(result.possibleMatches.map(({ entry }) => entry.sourceId)).toContain(
      "typo",
    );
  });

  test("tolerates one typo but not a different name", () => {
    expect(keys({ name: "Vladimir Puttin" })).toContain(PUTIN);
    expect(keys({ name: "Vladimir Petrov" })).not.toContain(PUTIN);
    expect(keys({ name: "Jan Novák" })).toEqual([]);
  });

  test("reads a surname alone as weaker evidence than the full name", () => {
    const surname = scoreOf({ name: "Putin" }, PUTIN);
    expect(surname).toBeGreaterThan(0);
    expect(surname).toBeLessThan(DEFAULT_CUTOFF);
    expect(scoreOf({ name: "Vladimir Putin" }, PUTIN)).toBeGreaterThan(surname);
  });

  test("ignores organisation legal forms and their spelling", () => {
    for (const name of [
      "Korea Samma Shipping",
      "KOREA SAMMA SHIPPING COMPANY LIMITED",
      "Korea Samma Shipping Co., Ltd.",
    ]) {
      expect(keys({ name, entityType: "organisation" })).toEqual(
        expect.arrayContaining(KOREA_SAMMA),
      );
    }
    for (const name of [
      "Voice of Europe, spol. s r.o.",
      "VOICE OF EUROPE a.s.",
      "Voice of Europe",
    ]) {
      expect(keys({ name })).toEqual(expect.arrayContaining(VOICE_OF_EUROPE));
    }
  });

  test("reads legal forms written out or abbreviated, joined by punctuation", () => {
    // Real EU aliases (entry 177294), each listed only in the short form.
    const extra: ParsedList = {
      version: EXTRA_VERSION,
      entries: [
        listed({
          sourceId: "twister",
          entityType: "organisation",
          name: "Twister Shipmanagement  LLC-FZ",
        }),
        listed({
          sourceId: "edm",
          entityType: "organisation",
          name: "EDM L.L.C-FZ",
        }),
      ],
    };
    const withExtra = buildScreeningIndex([...lists, extra]);
    const found = (name: string) =>
      screen(withExtra, { name, entityType: "organisation" }, { cutoff: 0.9 })
        .unwrap()
        .possibleMatches.map(({ entry }) => entry.sourceId);
    for (const name of [
      "Twister Shipmanagement Limited Liability Company-FZ",
      "Twister Shipmanagement LLC FZE",
      "Twister Shipmanagement Free Zone Company",
      "Twister Shipmanagement",
    ]) {
      expect(found(name)).toContain("twister");
    }
    expect(found("EDM Limited Liability Company - Free Zone")).toContain("edm");
  });

  test("lets birth dates confirm or rule out a name match", () => {
    const name = "Vladimir Putin";
    const nameOnly = scoreOf({ name }, PUTIN);
    const sameDay = scoreOf(
      { name, birthDate: { year: 1952, month: 10, day: 7 } },
      PUTIN,
    );
    const sameYear = scoreOf({ name, birthDate: { year: 1952 } }, PUTIN);
    const otherDay = scoreOf(
      { name, birthDate: { year: 1970, month: 1, day: 1 } },
      PUTIN,
    );
    expect(sameDay).toBeGreaterThan(sameYear);
    expect(sameYear).toBeGreaterThan(nameOnly);
    expect(nameOnly).toBeGreaterThanOrEqual(DEFAULT_CUTOFF);
    expect(otherDay).toBeLessThan(DEFAULT_CUTOFF);
  });

  test("respects the precision the list gives a birth date", () => {
    // Listed as born between 1973 and 1974.
    const ntaganda = "un:6908021";
    const name = "Bosco Ntaganda";
    const inRange = matches(
      { name, birthDate: { year: 1974, month: 5, day: 2 } },
      0,
    ).find(({ entry }) => `${entry.source}:${entry.sourceId}` === ntaganda);
    expect(inRange?.evidence.birthDate).toBe("match");
    expect(scoreOf({ name, birthDate: { year: 1980 } }, ntaganda)).toBeLessThan(
      scoreOf({ name }, ntaganda),
    );
  });

  test("penalises an entity-type mismatch", () => {
    const name = "Korea Samma Shipping";
    expect(scoreOf({ name, entityType: "person" }, "un:6908678")).toBeLessThan(
      scoreOf({ name, entityType: "organisation" }, "un:6908678"),
    );
  });

  test("treats a shared identifier as decisive", () => {
    const withPassport = lists
      .flatMap((list) => list.entries)
      .find((entry) =>
        entry.identifiers.some((identifier) => identifier.kind === "passport"),
      );
    const passport = withPassport?.identifiers.find(
      (identifier) => identifier.kind === "passport",
    );
    if (withPassport === undefined || passport === undefined) {
      throw new Error("the fixtures have no passport");
    }
    const [match] = matches({
      name: "Completely Different",
      identifiers: [` ${passport.number.toLowerCase()} `],
    });
    expect(match?.entry).toBe(withPassport);
    expect(match?.score).toBe(1);
    expect(match?.evidence.identifier).toBe("match");
  });

  test("never treats a known-false document number as proof", () => {
    const withDocument = (status: "listed" | "known-false") =>
      buildScreeningIndex([
        {
          version: EXTRA_VERSION,
          entries: [
            {
              ...listedPerson("forged", "Ivan Example"),
              identifiers: [
                {
                  kind: "passport",
                  label: "National passport",
                  number: "XX1234567",
                  country: null,
                  status,
                },
              ],
            },
          ],
        },
      ]);
    const query = { name: "Unrelated Person", identifiers: ["XX 1234567"] };
    const decisive = screen(withDocument("listed"), query, {
      cutoff: DEFAULT_CUTOFF,
    }).unwrap();
    expect(decisive.possibleMatches.map(({ score }) => score)).toEqual([1]);
    const forged = screen(withDocument("known-false"), query, {
      cutoff: DEFAULT_CUTOFF,
    }).unwrap();
    expect(forged.possibleMatches).toEqual([]);
  });

  test("keeps a strong name match whose client fields disagree", () => {
    // Real record, stale client data: a birth date one day off, a wrong type.
    const name = "Vladimir Vladimirovich Putin";
    const agreeing = matches({
      name,
      entityType: "person",
      birthDate: { year: 1952, month: 10, day: 7 },
    }).find(({ entry }) => `${entry.source}:${entry.sourceId}` === PUTIN);
    for (const query of [
      { name, birthDate: { year: 1952, month: 10, day: 8 } },
      { name, entityType: "organisation" as const },
    ]) {
      const kept = matches(query).find(
        ({ entry }) => `${entry.source}:${entry.sourceId}` === PUTIN,
      );
      expect(kept?.score).toBeGreaterThanOrEqual(DEFAULT_CUTOFF);
      expect(kept?.score).toBeLessThan(agreeing?.score ?? 0);
      expect(kept?.evidence.conflicts).toHaveLength(1);
    }
    // A weak name with the same conflict still drops out.
    expect(
      keys({ name: "Putin", birthDate: { year: 1952, month: 10, day: 8 } }),
    ).not.toContain(PUTIN);
  });

  test("reads an unknown party both as a person and as an organisation", () => {
    // Listed persons whose names start or end with a legal-form word.
    const extended = buildScreeningIndex([
      ...lists,
      {
        version: EXTRA_VERSION,
        entries: [
          listedPerson("leading", "Ag Ahmed Mohamed"),
          listedPerson("trailing", "Ahmed Mohamed Sa"),
        ],
      },
    ]);
    const found = (name: string) =>
      screen(extended, { name }, { cutoff: DEFAULT_CUTOFF })
        .unwrap()
        .possibleMatches.map(({ entry }) => entry.sourceId);
    expect(found("Ag Ahmed Mohamed")).toContain("leading");
    expect(found("Ahmed Mohamed Sa")).toContain("trailing");
    // The organisation reading still strips a real legal form.
    expect(found("Korea Samma Shipping Co")).toContain("6908678");
  });

  test("reports how many entries qualified when the limit cuts them", () => {
    const count = 25;
    const extended = buildScreeningIndex([
      {
        version: EXTRA_VERSION,
        entries: Array.from({ length: count }, (_, position) =>
          listedPerson(String(position), "Jana Example"),
        ),
      },
    ]);
    const limited = screen(
      extended,
      { name: "Jana Example" },
      {
        cutoff: DEFAULT_CUTOFF,
      },
    ).unwrap();
    expect(limited.possibleMatches).toHaveLength(20);
    expect(limited.totalMatches).toBe(count);
    expect(limited.truncated).toBe(true);
    const all = screen(
      extended,
      { name: "Jana Example" },
      {
        cutoff: DEFAULT_CUTOFF,
        limit: count,
      },
    ).unwrap();
    expect(all.truncated).toBe(false);
  });

  test("reports only entries at or above the cutoff, best first", () => {
    for (const cutoff of [0, 0.5, DEFAULT_CUTOFF, 1]) {
      const result = screen(
        index,
        { name: "Mohammed Ali Hussein" },
        { cutoff },
      ).unwrap();
      expect(result.cutoff).toBe(cutoff);
      expect(result.versions).toEqual(lists.map((list) => list.version));
      const scores = result.possibleMatches.map((match) => match.score);
      expect(scores.every((score) => score >= cutoff && score <= 1)).toBe(true);
      expect(scores).toEqual(scores.toSorted((left, right) => right - left));
    }
  });

  test("rejects queries that cannot be screened", () => {
    const empty = screen(index, { name: " — " }, { cutoff: DEFAULT_CUTOFF });
    expect(empty.isErr() && empty.error.code).toBe("empty-query");
    const impossible = screen(
      index,
      { name: "Vladimir Putin", birthDate: { year: 1952, month: 2, day: 30 } },
      { cutoff: DEFAULT_CUTOFF },
    );
    expect(impossible.isErr() && impossible.error.code).toBe(
      "invalid-birth-date",
    );
    expect(() =>
      screen(index, { name: "Vladimir Putin" }, { cutoff: 1.5 }),
    ).toThrow(Panic);
  });
});
