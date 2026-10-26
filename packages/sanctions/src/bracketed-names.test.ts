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
import { nameVariants } from "./normalise";
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

describe("bracketed name variants", () => {
  test("lift an acronym out as its own name and keep the name without it", () => {
    expect(nameVariants("KOREA KWANGSON BANKING CORPORATION (KKBC)")).toEqual([
      { text: "KOREA KWANGSON BANKING CORPORATION (KKBC)", qualifier: false },
      { text: "KOREA KWANGSON BANKING CORPORATION", qualifier: false },
      { text: "KKBC", qualifier: true },
    ]);
    expect(nameVariants("UGANDA COMMERCIAL IMPEX (UCI) LTD")).toEqual([
      { text: "UGANDA COMMERCIAL IMPEX (UCI) LTD", qualifier: false },
      { text: "UGANDA COMMERCIAL IMPEX LTD", qualifier: false },
      { text: "UCI", qualifier: true },
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
      { text: "CAGL", qualifier: true },
      { text: "GLBC", qualifier: true },
    ]);
  });

  test("lift marked aliases and other-script names, never places or notes", () => {
    expect(nameVariants("Abubakar (original script: Абубакар)")).toEqual([
      { text: "Abubakar (original script: Абубакар)", qualifier: false },
      { text: "Abubakar", qualifier: false },
      { text: "Абубакар", qualifier: true },
    ]);
    expect(nameVariants("North Harbor Company (a.k.a. Harbor North)")).toEqual([
      { text: "North Harbor Company (a.k.a. Harbor North)", qualifier: false },
      { text: "North Harbor Company", qualifier: false },
      { text: "Harbor North", qualifier: true },
    ]);
    expect(nameVariants("Jin Tiesan (金铁三)")).toEqual([
      { text: "Jin Tiesan (金铁三)", qualifier: false },
      { text: "Jin Tiesan", qualifier: false },
      { text: "金铁三", qualifier: true },
    ]);
    for (const [name, base] of [
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

  test("leave a name without brackets as it is, and survive unbalanced ones", () => {
    expect(nameVariants("Vladimir Putin")).toEqual([
      { text: "Vladimir Putin", qualifier: false },
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
