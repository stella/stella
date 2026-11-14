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
import { hasExcessQueryTokens, nameReading, nameReadings } from "./normalise";
import { parseOfacList } from "./ofac";
import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "./screening";
import type { ScreeningQuery } from "./screening";
import { parseSecoList } from "./seco";
import {
  buildScreeningIndex as buildBaseIndex,
  screen as screenBase,
} from "./test-fixtures/legacy-screening";
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
const DOTTED_ACRONYM =
  /(?<![\p{L}\p{N}])\p{L}(?:\.\p{L})+\.?(?![\p{L}\p{N}])/gu;
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

const screenedScores = (
  index: ReturnType<typeof buildScreeningIndex>,
  query: ScreeningQuery,
  cutoff = DEFAULT_CUTOFF,
) =>
  new Map(
    screen(index, query, { cutoff, limit: 10_000 })
      .unwrap()
      .possibleMatches.map((match) => [key(match.entry), match.score]),
  );
const matchedKeys = (
  index: ReturnType<typeof buildScreeningIndex>,
  name: string,
  entityType: EntityType,
) => [...screenedScores(index, { name, entityType }).keys()];

const version = (source: SanctionsSource) => ({
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
  version: version("eu"),
  entries,
});

// A derived alias that names a word the listed names spell later ("martin")
// must not change which listed word an unknown query word ("martam") takes
// its weight from; a stripped legal form must not reweigh a shared token.
const weightProbes = syntheticList([
  synthetic("dotted", "organisation", "M.A.R.T.I.N. Trading"),
  synthetic("martis-ali", "person", "Martis Ali"),
  synthetic("martin", "person", "Martin Smith"),
  synthetic("martis-brown", "person", "Martis Brown"),
  synthetic("sa-person", "person", "Sa Mohammed Ali"),
  synthetic("sa-agency", "organisation", "Shipping Agency (SA)"),
  synthetic("sa-aka", "organisation", "Shipping Agency (a.k.a. SA)"),
]);

const spelled = (name: string, entityType: EntityType) =>
  nameReadings(name, entityType).map(({ tokens }) =>
    tokens.map((token) => token.raw).join(" "),
  );

describe("name readings", () => {
  test("add the name without its bracketed parts and with dotted acronyms joined", () => {
    expect(
      spelled("KOREA KWANGSON BANKING CORPORATION (KKBC)", "organisation"),
    ).toEqual([
      "korea kwangson banking corporation kkbc",
      "korea kwangson banking",
    ]);
    expect(
      spelled("UGANDA COMMERCIAL IMPEX (UCI) LTD", "organisation"),
    ).toEqual(["uganda commercial impex uci", "uganda commercial impex"]);
    expect(spelled("Acme (formerly Beta (UK))", "organisation")).toEqual([
      "acme formerly beta uk",
      "acme",
    ]);
    expect(spelled("Sber Bank (Belarus", "organisation")).toEqual([
      "sber bank belarus",
      "sber bank",
    ]);
    expect(spelled("K.K.B.C.", "organisation")).toContain("kkbc");
    expect(spelled("Vladimir Putin", "person")).toEqual(["vladimir putin"]);
    expect(spelled("Vladimir V. Putin", "person")).toEqual([
      "vladimir v putin",
    ]);
  });

  test("never read a bracketed part on its own", () => {
    for (const [name, part] of [
      ["KOREA KWANGSON BANKING CORPORATION (KKBC)", "kkbc"],
      ["AL-HARAMAYN FOUNDATION (KENYA)", "kenya"],
      ["Unrelated Services (a.k.a. US)", "us"],
      ["Sakura Holdings (東京)", "東京"],
      ["Газпром (ガスプロム)", "カスフロム"],
    ] as const) {
      expect({
        name,
        alone: spelled(name, "organisation").includes(part),
      }).toEqual({ name, alone: false });
    }
  });

  test("add no token beyond the listed name's own but joined dotted acronyms", () => {
    for (const list of [...fixtureLists, weightProbes]) {
      for (const entry of list.entries) {
        for (const { name } of entry.names) {
          const own = new Set(
            nameReading(name, entry.entityType).tokens.map(
              (token) => token.folded,
            ),
          );
          for (const acronym of name.match(DOTTED_ACRONYM) ?? []) {
            for (const token of nameReading(
              acronym.replaceAll(".", ""),
              "person",
            ).tokens) {
              own.add(token.folded);
            }
          }
          const added = nameReadings(name, entry.entityType)
            .flatMap(({ tokens }) => tokens.map((token) => token.folded))
            .filter((token) => !own.has(token));
          expect({ name, added }).toEqual({ name, added: [] });
        }
      }
    }
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
      version: version("us-sdn"),
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
    const others = (
      [
        ["eu", "KOREA KWANGSON BANKING CORPORATION (KKBC)"],
        ["uk", "KOREA KWANGSON BANKING CORPORATION (KKBC)"],
        ["us-sdn", "KOREA KWANGSON BANKING CORP."],
        ["ch", "Korea Kwangson Banking Corporation"],
      ] as const
    ).map(([source, name]) => ({
      version: version(source),
      entries: [mirrorEntry(source, kkbc, name)],
    }));
    const all = buildScreeningIndex([...fixtureLists, ...others]);
    const expected = [
      "un:6908518",
      ...others.map(({ version: { source } }) => `${source}:mirror-un:6908518`),
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

  test("match dotted and undotted acronyms both ways", () => {
    const acronyms = buildScreeningIndex([
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
        score: screenedScores(acronyms, {
          name,
          entityType: "organisation",
        }).get(entryKey),
      }).toEqual({ name, entryKey, score: 1 });
    }
  });
});

describe("against the matcher before bracket handling", () => {
  const lists = [...fixtureLists, weightProbes];
  const current = buildScreeningIndex(lists);
  const base = buildBaseIndex(lists);
  // The probes alone, so their token weights do not depend on the fixtures.
  const probes = buildScreeningIndex([weightProbes]);
  const baseProbes = buildBaseIndex([weightProbes]);
  const options = { cutoff: 0.5, limit: 10_000 };
  const baseScores = (query: ScreeningQuery, index = base) => {
    const screened = screenBase(index, query, options);
    return screened.isErr()
      ? undefined
      : new Map(
          screened.value.possibleMatches.map((match) => [
            key(match.entry),
            match.score,
          ]),
        );
  };

  test("an unknown query word keeps the weight of the same listed word", () => {
    const query = { name: "Martam Ali", entityType: "person" } as const;
    const was = baseScores(query, baseProbes)?.get("eu:martis-ali") ?? 0;
    const now = screenedScores(probes, query, 0.5).get("eu:martis-ali") ?? 0;
    expect(was).toBeGreaterThanOrEqual(DEFAULT_CUTOFF);
    expect({ query: query.name, same: Math.abs(now - was) < 1e-12 }).toEqual({
      query: query.name,
      same: true,
    });
  });

  test("a stripped legal form leaves the weight of a shared token alone", () => {
    const query = { name: "Sa Mohammed", entityType: "person" } as const;
    const was = baseScores(query, baseProbes)?.get("eu:sa-person") ?? 0;
    const now = screenedScores(probes, query, 0.5).get("eu:sa-person") ?? 0;
    expect(was).toBeGreaterThanOrEqual(DEFAULT_CUTOFF);
    expect({ query: query.name, same: Math.abs(now - was) < 1e-12 }).toEqual({
      query: query.name,
      same: true,
    });
  });

  test("no listed name or shortened name scores lower than before", () => {
    let compared = 0;
    for (const entry of lists.flatMap((list) => list.entries)) {
      for (const { name } of entry.names) {
        const words = name.split(/\s+/u).filter((word) => word !== "");
        for (const queryName of new Set([
          name,
          words.slice(1).join(" "),
          words.slice(0, -1).join(" "),
        ])) {
          if (
            !/[\p{L}\p{N}]/u.test(queryName) ||
            hasExcessQueryTokens(queryName, entry.entityType)
          ) {
            continue;
          }
          const query = { name: queryName, entityType: entry.entityType };
          const was = baseScores(query);
          if (was === undefined) {
            continue;
          }
          const now = screenedScores(current, query, options.cutoff);
          for (const [id, score] of was) {
            compared += 1;
            const scored = now.get(id) ?? 0;
            if (scored < score - 1e-9) {
              expect({ query: queryName, id, score: scored }).toEqual({
                query: queryName,
                id,
                score,
              });
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  }, 120_000); // timeout: screens every fixture name three ways on two matchers
});

describe("bracketed parts add no false positives", () => {
  const extra = syntheticList([
    synthetic("us", "organisation", "Unrelated Services (US)"),
    synthetic("us-aka", "organisation", "Unrelated Services (a.k.a. US)"),
    synthetic("tokyo", "organisation", "Sakura Holdings (東京)"),
  ]);
  const index = buildScreeningIndex([...fixtureLists, extra]);

  test("the evaluation's common names stay clear on every list", () => {
    const common = sample.filter(({ category }) =>
      category.startsWith("common-name"),
    );
    expect(common.length).toBeGreaterThan(0);
    for (const { query } of common) {
      const { birthDate } = query;
      const matched = [
        ...screenedScores(index, {
          name: query.name,
          entityType: "person",
          ...(birthDate === undefined ? {} : { birthDate }),
        }).keys(),
      ];
      expect({ name: query.name, matched }).toEqual({
        name: query.name,
        matched: [],
      });
    }
  });

  test("names sharing only a bracketed part never match on it", () => {
    for (const [name, entryKey] of [
      ["Universal Credit Insurance (UCI)", "un:6908031"],
      ["UCI", "un:6908031"],
      ["United Shipping Company (US)", "eu:us"],
      ["United Shipping Company (a.k.a. US)", "eu:us-aka"],
      ["US", "eu:us-aka"],
      ["Fuji Industries (東京)", "eu:tokyo"],
      ["東京", "eu:tokyo"],
      ["Kenya", "un:113338"],
      ["Global Trading Company (Kenya)", "un:113338"],
    ] as const) {
      const score =
        screenedScores(index, { name, entityType: "organisation" }, 0).get(
          entryKey,
        ) ?? 0;
      expect({ name, entryKey, below: score < DEFAULT_CUTOFF }).toEqual({
        name,
        entryKey,
        below: true,
      });
    }
  });
});
