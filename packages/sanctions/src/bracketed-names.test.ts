import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseCzList } from "./cz";
import type {
  EntityType,
  ParsedList,
  SanctionsEntry,
  SanctionsSource,
} from "./entry";
import { parseEuList } from "./eu";
import sample from "./evaluation/sample.json";
import { hasExcessQueryTokens, nameVariants } from "./normalise";
import { parseOfacList } from "./ofac";
import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "./screening";
import type { ScreeningQuery } from "./screening";
import { parseSecoList } from "./seco";
import { parseUkList } from "./uk";
import { parseUnList } from "./un";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const CZ_FILE = "Vnitrostatni_sankcni_seznam_2026_07_23.csv";
const fixture = (name: string) => Bun.file(path.join(FIXTURES, name));

const fixtureLists: ParsedList[] = [
  (await parseEuList(fixture("eu.xml").stream())).unwrap(),
  (await parseUnList(fixture("un.xml").stream())).unwrap(),
  // Real UN listings whose names carry acronyms, a place, a trailing legal
  // form, a semicolon-joined second name and an other-script alias.
  (await parseUnList(fixture("un-bracketed.xml").stream())).unwrap(),
  parseCzList({
    csv: await fixture(CZ_FILE).text(),
    fileNameOrUrl: CZ_FILE,
  }).unwrap(),
  (await parseOfacList("us-sdn", fixture("ofac-sdn.xml").stream())).unwrap(),
  (
    await parseOfacList("us-non-sdn", fixture("ofac-non-sdn.xml").stream())
  ).unwrap(),
  (await parseUkList(fixture("uk.xml").stream())).unwrap(),
  (await parseSecoList(fixture("seco.xml").stream())).unwrap(),
];

// Written independently of the normaliser: one bracketed part, not nested.
const BRACKETED_PART = /\s*[([][^()[\]]*[)\]]/gu;
const tidy = (text: string) => text.replaceAll(/\s+/gu, " ").trim();
const withoutPart = (name: string, part: string) =>
  tidy(name.replace(part, " "));
const withoutAll = (name: string) => tidy(name.replaceAll(BRACKETED_PART, " "));

const key = (entry: Pick<SanctionsEntry, "source" | "sourceId">) =>
  `${entry.source}:${entry.sourceId}`;

type Bracketed = { entry: SanctionsEntry; name: string; parts: string[] };
const bracketedNames = (lists: readonly ParsedList[]): Bracketed[] =>
  lists.flatMap((list) =>
    list.entries.flatMap((entry) =>
      entry.names.flatMap(({ name }) => {
        const parts = name.match(BRACKETED_PART) ?? [];
        return parts.length === 0 ? [] : [{ entry, name, parts }];
      }),
    ),
  );

/** Every spelling of a listed name with and without each bracketed part. */
const spellings = ({ name, parts }: Bracketed): string[] => [
  ...new Set([
    name,
    withoutAll(name),
    ...parts.map((part) => withoutPart(name, part)),
  ]),
];

const screenedKeys = (
  index: ReturnType<typeof buildScreeningIndex>,
  query: ScreeningQuery,
) =>
  screen(index, query, { cutoff: DEFAULT_CUTOFF, limit: 1000 })
    .unwrap()
    .possibleMatches.map(({ entry }) => key(entry));
const matchedKeys = (
  index: ReturnType<typeof buildScreeningIndex>,
  name: string,
  entityType: EntityType,
) => screenedKeys(index, { name, entityType });

const mirrorVersion = (source: SanctionsSource) => ({
  source,
  publishedAt: "2026-10-26",
  fileId: null,
});

const mirrorEntry = (
  source: SanctionsSource,
  original: SanctionsEntry,
  name: string,
): SanctionsEntry => ({
  ...original,
  source,
  sourceId: `mirror-${key(original)}`,
  names: [{ name, quality: "strong" }],
});

const synthetic = (
  sourceId: string,
  entityType: EntityType,
  name: string,
): SanctionsEntry => ({
  source: "eu",
  issuer: "EU",
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
  sourceUrl: "https://example.test/entry",
});
const syntheticList = (entries: SanctionsEntry[]): ParsedList => ({
  version: mirrorVersion("eu"),
  entries,
});

/** Best score of one entry for a query, or 0 when it is not reported. */
const scoreOf = (
  index: ReturnType<typeof buildScreeningIndex>,
  query: ScreeningQuery,
  entryKey: string,
  cutoff = DEFAULT_CUTOFF,
) =>
  screen(index, query, { cutoff, limit: 10_000 })
    .unwrap()
    .possibleMatches.find(({ entry }) => key(entry) === entryKey)?.score ?? 0;

// The same names as read before bracket handling existed: brackets,
// semicolons and dots are plain separators, so no variant is derived.
const neutralise = (name: string) =>
  name.replaceAll(/[()[\]（）［］;.]/gu, " ");
const neutralised = (lists: readonly ParsedList[]): ParsedList[] =>
  lists.map((list) => ({
    ...list,
    entries: list.entries.map((entry) => ({
      ...entry,
      names: entry.names.map((alias) => ({
        ...alias,
        name: neutralise(alias.name),
      })),
    })),
  }));

describe("bracketed name variants", () => {
  test("keep the name without its bracketed acronym, never the acronym alone", () => {
    expect(nameVariants("KOREA KWANGSON BANKING CORPORATION (KKBC)")).toEqual([
      { text: "KOREA KWANGSON BANKING CORPORATION (KKBC)", qualifier: false },
      { text: "KOREA KWANGSON BANKING CORPORATION", qualifier: false },
    ]);
    expect(nameVariants("UGANDA COMMERCIAL IMPEX (UCI) LTD")).toEqual([
      { text: "UGANDA COMMERCIAL IMPEX (UCI) LTD", qualifier: false },
      { text: "UGANDA COMMERCIAL IMPEX LTD", qualifier: false },
    ]);
  });

  test("read each name of a semicolon-joined listing on its own", () => {
    expect(
      nameVariants(
        "COMPAGNIE AERIENNE DES GRANDS LACS (CAGL) ; GREAT LAKES BUSINESS COMPANY (GLBC)",
      ),
    ).toEqual([
      {
        text: "COMPAGNIE AERIENNE DES GRANDS LACS (CAGL) ; GREAT LAKES BUSINESS COMPANY (GLBC)",
        qualifier: false,
      },
      { text: "COMPAGNIE AERIENNE DES GRANDS LACS (CAGL)", qualifier: false },
      { text: "GREAT LAKES BUSINESS COMPANY (GLBC)", qualifier: false },
      { text: "COMPAGNIE AERIENNE DES GRANDS LACS", qualifier: false },
      { text: "GREAT LAKES BUSINESS COMPANY", qualifier: false },
    ]);
  });

  test("lift marked aliases and names in another script, never places or notes", () => {
    expect(nameVariants("Abubakar (original script: Абубакар)")).toEqual([
      { text: "Abubakar (original script: Абубакар)", qualifier: false },
      { text: "Abubakar", qualifier: false },
      { text: "Абубакар", qualifier: true },
    ]);
    expect(nameVariants("North Harbor Company (a.k.a. Harbor North)")).toEqual([
      { text: "North Harbor Company (a.k.a. Harbor North)", qualifier: false },
      { text: "North Harbor Company (aka Harbor North)", qualifier: false },
      { text: "North Harbor Company", qualifier: false },
      { text: "Harbor North", qualifier: true },
    ]);
    expect(nameVariants("Jin Tiesan (金铁三)")).toEqual([
      { text: "Jin Tiesan (金铁三)", qualifier: false },
      { text: "Jin Tiesan", qualifier: false },
      { text: "金铁三", qualifier: true },
    ]);
    // The dominant script decides, not whether Latin letters are present.
    expect(nameVariants("Газпром (ガスプロム)")).toEqual([
      { text: "Газпром (ガスプロム)", qualifier: false },
      { text: "Газпром", qualifier: false },
      { text: "ガスプロム", qualifier: true },
    ]);
    // A Latin name beside a Cyrillic one counts only as its transliteration.
    expect(nameVariants("Совкомфлот (Sovcomflot)")).toEqual([
      { text: "Совкомфлот (Sovcomflot)", qualifier: false },
      { text: "Совкомфлот", qualifier: false },
      { text: "Sovcomflot", qualifier: true },
    ]);
    for (const [name, base] of [
      ["Внешторгбанк (Moscow)", "Внешторгбанк"],
      ["中国银行 (Beijing)", "中国银行"],
      ["AL-HARAMAYN FOUNDATION (KENYA)", "AL-HARAMAYN FOUNDATION"],
      ["LEADER (HONG KONG) INTERNATIONAL", "LEADER INTERNATIONAL"],
      ["Lom-ali Butayev (Butaev)", "Lom-ali Butayev"],
      ["Ezatullah Haqqani (previously listed as)", "Ezatullah Haqqani"],
      ["EL PARA (COMBAT NAME)", "EL PARA"],
      [
        "TOUS POUR LA PAIX ET LE DEVELOPPEMENT (NGO)",
        "TOUS POUR LA PAIX ET LE DEVELOPPEMENT",
      ],
    ] as const) {
      expect(nameVariants(name)).toEqual([
        { text: name, qualifier: false },
        { text: base, qualifier: false },
      ]);
    }
  });

  test("read nested brackets as a tree, inside marked aliases too", () => {
    expect(nameVariants("Acme (formerly Beta (UK))")).toEqual([
      { text: "Acme (formerly Beta (UK))", qualifier: false },
      { text: "Acme", qualifier: false },
      { text: "Beta (UK)", qualifier: true },
      { text: "Beta", qualifier: true },
    ]);
  });

  test("read a dotted acronym as one word", () => {
    expect(
      nameVariants("KOREA KWANGSON BANKING CORPORATION (K.K.B.C.)"),
    ).toEqual([
      {
        text: "KOREA KWANGSON BANKING CORPORATION (K.K.B.C.)",
        qualifier: false,
      },
      { text: "KOREA KWANGSON BANKING CORPORATION (KKBC)", qualifier: false },
      { text: "KOREA KWANGSON BANKING CORPORATION", qualifier: false },
    ]);
    expect(nameVariants("K.K.B.C.")).toEqual([
      { text: "K.K.B.C.", qualifier: false },
      { text: "KKBC", qualifier: false },
    ]);
  });

  test("leave a name without brackets as it is, and survive unbalanced ones", () => {
    expect(nameVariants("Vladimir Putin")).toEqual([
      { text: "Vladimir Putin", qualifier: false },
    ]);
    expect(nameVariants("Vladimir V. Putin")).toEqual([
      { text: "Vladimir V. Putin", qualifier: false },
    ]);
    expect(nameVariants("Sber Bank (Belarus")).toEqual([
      { text: "Sber Bank (Belarus", qualifier: false },
      { text: "Sber Bank", qualifier: false },
    ]);
    expect(nameVariants("(KKBC)")).toEqual([
      { text: "(KKBC)", qualifier: false },
    ]);
  });
});

describe("screening reviewed edge cases", () => {
  test("derived variants leave the token weights of other entries alone", () => {
    // A derived variant may hold a token the listed name itself does not
    // (a trailing "SA" is stripped as a legal form, the alias "SA" is not).
    for (const organisation of [
      "Shipping Agency (SA)",
      "Shipping Agency (a.k.a. SA)",
    ]) {
      const entries = [
        synthetic("person", "person", "Sa Mohammed Ali"),
        synthetic("organisation", "organisation", organisation),
      ];
      const query = { name: "Sa Mohammed", entityType: "person" } as const;
      const after = scoreOf(
        buildScreeningIndex([syntheticList(entries)]),
        query,
        "eu:person",
      );
      const before = scoreOf(
        buildScreeningIndex(neutralised([syntheticList(entries)])),
        query,
        "eu:person",
      );
      expect({ organisation, reported: before >= DEFAULT_CUTOFF }).toEqual({
        organisation,
        reported: true,
      });
      expect({ organisation, same: Math.abs(after - before) < 1e-12 }).toEqual({
        organisation,
        same: true,
      });
    }
  });

  test("a name in another script beside the listed one is found on its own", () => {
    const index = buildScreeningIndex([
      syntheticList([
        synthetic("gazprom", "organisation", "Газпром (ガスプロム)"),
        synthetic("vtb", "organisation", "Внешторгбанк (Moscow)"),
      ]),
    ]);
    expect(
      scoreOf(
        index,
        { name: "ガスプロム", entityType: "organisation" },
        "eu:gazprom",
      ),
    ).toBeGreaterThanOrEqual(DEFAULT_CUTOFF);
    expect(
      scoreOf(
        index,
        { name: "Moscow", entityType: "organisation" },
        "eu:vtb",
        0,
      ),
    ).toBeLessThan(DEFAULT_CUTOFF);
  });

  test("a former name with its own qualifier is found without it", () => {
    const index = buildScreeningIndex([
      syntheticList([
        synthetic("acme", "organisation", "Acme (formerly Beta (UK))"),
      ]),
    ]);
    for (const name of ["Beta", "Beta (UK)", "Acme"]) {
      expect({
        name,
        found:
          scoreOf(index, { name, entityType: "organisation" }, "eu:acme") >=
          DEFAULT_CUTOFF,
      }).toEqual({ name, found: true });
    }
  });

  test("dotted and undotted acronyms match each other both ways", () => {
    const index = buildScreeningIndex([
      syntheticList([
        {
          ...synthetic(
            "dotted",
            "organisation",
            "KOREA KWANGSON BANKING CORPORATION (K.K.B.C.)",
          ),
          names: [
            {
              name: "KOREA KWANGSON BANKING CORPORATION (K.K.B.C.)",
              quality: "strong",
            },
            { name: "K.K.B.C.", quality: "strong" },
          ],
        },
        synthetic("plain", "organisation", "KKBC"),
      ]),
    ]);
    for (const [name, entryKey] of [
      ["KKBC", "eu:dotted"],
      ["K.K.B.C.", "eu:plain"],
      ["KOREA KWANGSON BANKING CORPORATION (KKBC)", "eu:dotted"],
    ] as const) {
      expect({
        name,
        entryKey,
        score: scoreOf(index, { name, entityType: "organisation" }, entryKey),
      }).toEqual({ name, entryKey, score: 1 });
    }
  });

  test("a shared bracketed acronym alone never reaches the cutoff", () => {
    const index = buildScreeningIndex([
      ...fixtureLists,
      syntheticList([
        synthetic("us", "organisation", "Unrelated Services (US)"),
      ]),
    ]);
    for (const [name, entryKey] of [
      ["Universal Credit Insurance (UCI)", "un:6908031"],
      ["UCI", "un:6908031"],
      ["United Shipping Company (US)", "eu:us"],
      ["US", "eu:us"],
    ] as const) {
      expect({
        name,
        found:
          scoreOf(index, { name, entityType: "organisation" }, entryKey, 0) >=
          DEFAULT_CUTOFF,
      }).toEqual({ name, found: false });
    }
  });

  test("no fixture query scores lower than before bracket handling", () => {
    // Every listed name, and each with its first or last word dropped, read
    // against the fixtures as they are and with brackets as plain separators.
    const lists = [
      ...fixtureLists,
      syntheticList([
        synthetic("person", "person", "Sa Mohammed Ali"),
        synthetic("organisation", "organisation", "Shipping Agency (SA)"),
        synthetic("aka", "organisation", "Shipping Agency (a.k.a. SA)"),
      ]),
    ];
    const after = buildScreeningIndex(lists);
    const before = buildScreeningIndex(neutralised(lists));
    const options = { cutoff: 0.5, limit: 10_000 };
    let compared = 0;
    for (const entry of lists.flatMap((list) => list.entries)) {
      for (const { name } of entry.names) {
        const words = name.split(/\s+/u).filter((word) => word !== "");
        for (const query of new Set([
          name,
          words.slice(1).join(" "),
          words.slice(0, -1).join(" "),
        ])) {
          if (
            !/[\p{L}\p{N}]/u.test(neutralise(query)) ||
            hasExcessQueryTokens(query, entry.entityType)
          ) {
            continue;
          }
          const scores = new Map(
            screen(
              after,
              { name: query, entityType: entry.entityType },
              options,
            )
              .unwrap()
              .possibleMatches.map((match) => [key(match.entry), match.score]),
          );
          const was = screen(
            before,
            { name: neutralise(query), entityType: entry.entityType },
            options,
          ).unwrap().possibleMatches;
          for (const match of was) {
            compared += 1;
            const id = key(match.entry);
            const score = scores.get(id) ?? 0;
            if (score < match.score - 1e-9) {
              expect({ query, id, score }).toEqual({
                query,
                id,
                score: match.score,
              });
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  }, 120_000); // timeout: screens every fixture name three ways against two editions
});

describe("listed names with bracketed parts", () => {
  const index = buildScreeningIndex(fixtureLists);
  const bracketed = bracketedNames(fixtureLists);

  test("the fixtures carry bracketed names on organisations and persons", () => {
    expect(
      bracketed.filter(({ entry }) => entry.entityType === "organisation")
        .length,
    ).toBeGreaterThanOrEqual(4);
    expect(bracketed.some(({ entry }) => entry.entityType === "person")).toBe(
      true,
    );
  });

  test("match their own entry with and without each bracketed part", () => {
    for (const listed of bracketed) {
      for (const name of spellings(listed)) {
        expect({
          name,
          matched: matchedKeys(index, name, listed.entry.entityType).includes(
            key(listed.entry),
          ),
        }).toEqual({ name, matched: true });
      }
    }
  });

  test("match whichever side carries the bracketed part", () => {
    // Every bracketed listing mirrored on another list without its brackets,
    // the way a different publisher writes the same name.
    const mirrors: ParsedList = {
      version: mirrorVersion("us-sdn"),
      entries: bracketed.map((listed) =>
        mirrorEntry("us-sdn", listed.entry, withoutAll(listed.name)),
      ),
    };
    const mirrored = buildScreeningIndex([...fixtureLists, mirrors]);
    for (const listed of bracketed) {
      const expected = [
        key(listed.entry),
        `us-sdn:mirror-${key(listed.entry)}`,
      ];
      for (const name of spellings(listed)) {
        const matched = matchedKeys(mirrored, name, listed.entry.entityType);
        expect({
          name,
          matched: expected.filter((id) => matched.includes(id)),
        }).toEqual({ name, matched: expected });
      }
    }
  });

  test("find one listed bank on every list, whichever spelling is screened", () => {
    const kkbc = fixtureLists
      .flatMap((list) => list.entries)
      .find((entry) => entry.sourceId === "6908518");
    if (kkbc === undefined) {
      throw new Error("UN fixture lacks KPe.025");
    }
    const others: ParsedList[] = [
      {
        version: mirrorVersion("us-sdn"),
        entries: [mirrorEntry("us-sdn", kkbc, "KOREA KWANGSON BANKING CORP.")],
      },
      {
        version: mirrorVersion("ch"),
        entries: [
          mirrorEntry("ch", kkbc, "Korea Kwangson Banking Corporation"),
        ],
      },
      {
        version: mirrorVersion("uk"),
        entries: [
          mirrorEntry("uk", kkbc, "KOREA KWANGSON BANKING CORPORATION (KKBC)"),
        ],
      },
    ];
    const all = buildScreeningIndex([...fixtureLists, ...others]);
    const expected = [
      "un:6908518",
      "us-sdn:mirror-un:6908518",
      "ch:mirror-un:6908518",
      "uk:mirror-un:6908518",
    ];
    for (const name of [
      "Korea Kwangson Banking Corporation",
      "Korea Kwangson Banking Corp",
      "Korea Kwangson Banking Corporation (KKBC)",
      "KOREA KWANGSON BANKING CORP. (KKBC)",
    ]) {
      const matched = matchedKeys(all, name, "organisation");
      expect({
        name,
        matched: expected.filter((id) => matched.includes(id)),
      }).toEqual({ name, matched: expected });
    }
  });
});

describe("bracketed qualifiers add no false positives", () => {
  const index = buildScreeningIndex(fixtureLists);

  test("the evaluation's common names stay clear on every list", () => {
    const common = sample.filter(({ category }) =>
      category.startsWith("common-name"),
    );
    expect(common.length).toBeGreaterThan(0);
    for (const { query } of common) {
      const { birthDate } = query;
      const matched = screenedKeys(index, {
        name: query.name,
        entityType: "person",
        ...(birthDate === undefined ? {} : { birthDate }),
      });
      expect({ name: query.name, matched }).toEqual({
        name: query.name,
        matched: [],
      });
    }
  });

  test("a place, a note or a common word in brackets never becomes a name", () => {
    for (const [name, entityType] of [
      ["Kenya", "organisation"],
      ["Kenya Ltd", "organisation"],
      ["Kenya Trading (Nairobi)", "organisation"],
      ["Global Trading Company (Kenya)", "organisation"],
      ["International Trading (ITC)", "organisation"],
      ["Bank (Uganda)", "organisation"],
      ["Butaev", "person"],
      ["Combat Name", "person"],
      ["NGO", "organisation"],
    ] as const) {
      expect({ name, matched: matchedKeys(index, name, entityType) }).toEqual({
        name,
        matched: [],
      });
    }
  });
});
