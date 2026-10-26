import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

/**
 * The pl-nsa reader against whole rows of the dataset.
 *
 * `pl-nsa-text-rows.json.gz` holds eight rows of the pinned revision, kept
 * whole: decisions whose line breaks the dataset turned into paragraph
 * breaks (before one-letter words, and at an old document's margin), one
 * whose page numbers follow its closing rule, one whose page footer sits
 * inside a sentence, and two citing article numbers with superscripts.
 */
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { assemblePlNsaDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa";
import { PL_NSA_SNAPSHOT } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import type { PlNsaDatasetRow } from "@/api/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import {
  parsePlNsaDecision,
  plNsaParagraphs,
  plNsaStatedSuperscripts,
} from "@/api/handlers/case-law/ingestion/parsers/pl-nsa";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURE = new URL(
  "__fixtures__/pl-nsa-text-rows.json.gz",
  import.meta.url,
);

type RecordedRow = {
  case: string;
  shard: number;
  row: number;
  values: PlNsaDatasetRow;
};

const recordedRows = async (): Promise<RecordedRow[]> => {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer())),
    ),
  );
  if (!Array.isArray(parsed)) {
    return panic("pl-nsa-text-rows.json.gz holds no rows");
  }
  return parsed.map((entry: unknown) =>
    isRecord(entry) &&
    typeof entry["case"] === "string" &&
    typeof entry["shard"] === "number" &&
    typeof entry["row"] === "number" &&
    isRecord(entry["values"])
      ? {
          case: entry["case"],
          shard: entry["shard"],
          row: entry["row"],
          values: entry["values"],
        }
      : panic("pl-nsa-text-rows.json.gz holds a malformed row"),
  );
};

const rowOf = async (name: string): Promise<RecordedRow> =>
  (await recordedRows()).find((row) => row.case === name) ??
  panic(`no recorded row ${name}`);

const build = ({ row, shard, values }: RecordedRow): IngestionResult =>
  assemblePlNsaDecision({
    source: values,
    position: {
      shard: PL_NSA_SNAPSHOT.shards[shard] ?? panic("no such shard"),
      row,
    },
    snapshot: PL_NSA_SNAPSHOT,
  }).decision;

const paragraphsOf = (decision: IngestionResult): string[] =>
  "blocks" in decision.documentAst
    ? decision.documentAst.blocks.flatMap((block) =>
        block.type === "paragraph" ? [block.plainText] : [],
      )
    : [];

const TEXT_COLUMNS = [
  "thesis",
  "sentence",
  "reasons_for_judgment",
  "dissenting_opinion",
] as const;

const columnOf = (
  values: PlNsaDatasetRow,
  column: (typeof TEXT_COLUMNS)[number],
): string | null => {
  const value = values[column];
  return typeof value === "string" ? value : null;
};

const NO_SUPERSCRIPTS = plNsaStatedSuperscripts([]);

const countOf = (text: string, pattern: RegExp): number =>
  [...text.matchAll(pattern)].length;

const visible = (text: string): string => text.replaceAll(/\s+/gu, "");

describe("pl-nsa paragraphs", () => {
  test("a reading of its own output changes nothing", async () => {
    for (const recorded of await recordedRows()) {
      const stated = plNsaStatedSuperscripts(
        TEXT_COLUMNS.map((column) => columnOf(recorded.values, column)),
      );
      for (const column of TEXT_COLUMNS) {
        const text = columnOf(recorded.values, column);
        if (text === null) {
          continue;
        }
        const once = plNsaParagraphs(text, stated);
        expect(plNsaParagraphs(once.join("\n\n"), stated)).toEqual(once);
      }
    }
  });

  test("only whitespace changes in a text without page numbers or primes", async () => {
    for (const recorded of await recordedRows()) {
      for (const column of TEXT_COLUMNS) {
        const text = columnOf(recorded.values, column);
        if (text === null || /^-{5,}$/mu.test(text)) {
          continue;
        }
        expect(visible(plNsaParagraphs(text, NO_SUPERSCRIPTS).join(""))).toBe(
          visible(text.replaceAll(" ", " ")),
        );
      }
    }
  });

  test("a sentence broken before a one-letter word reads as one paragraph", async () => {
    const recorded = await rowOf("one-letter-word-breaks");
    const raw = columnOf(recorded.values, "reasons_for_judgment") ?? "";
    const breakBeforeWord = /\n\n[wzioau] /gu;
    expect(countOf(raw, breakBeforeWord)).toBeGreaterThan(10);

    const paragraphs = paragraphsOf(build(recorded));
    expect(
      paragraphs.filter((paragraph) => /^[wzioau] /u.test(paragraph)),
    ).toEqual([]);
    for (const sentence of [
      "Kolegium decyzją z dnia 31 lipca 2024 r. utrzymało w mocy",
      "pod względem zgodności z prawem.",
      "Prawo o postępowaniu przed sądami administracyjnymi",
    ]) {
      expect(paragraphs.some((paragraph) => paragraph.includes(sentence))).toBe(
        true,
      );
    }
  });

  test("a list keeps its items and a line closing a clause keeps its break", () => {
    const text = [
      "Skarżący zarzucił naruszenie:",
      "a) art. 7 k.p.a.,",
      "b) art. 77 § 1 k.p.a., oraz",
      "c) art. 80 k.p.a.;",
      "naruszenie przepisów prawa materialnego, tj.:",
      "1) art. 11 ustawy,",
      "2b) art. 12 ustawy,",
      "3.2.7. art. 13 ustawy,",
      "4 - art. 14 ustawy.",
      "Sąd oddalił skargę.",
      "ds",
    ];
    expect(plNsaParagraphs(text.join("\n\n"), NO_SUPERSCRIPTS)).toEqual(text);
  });

  test("a line continues past an abbreviation, a date and a hyphen", () => {
    expect(
      plNsaParagraphs(
        [
          "decyzją z dnia 13 lipca",
          "2023 r.",
          "w sprawie podatku (Dz. U. z 2023 r., poz. 70 ze zm.)",
          "w zw. z art. 5 ustawy o płatnościach rolno-",
          "środowiskowych oraz gospodarczo -",
          "składowych, na działce nr [...]",
          "w M.",
        ].join("\n\n"),
        NO_SUPERSCRIPTS,
      ),
    ).toEqual([
      "decyzją z dnia 13 lipca 2023 r. w sprawie podatku (Dz. U. z 2023 r., poz. 70 ze zm.) w zw. z art. 5 ustawy o płatnościach rolno-środowiskowych oraz gospodarczo - składowych, na działce nr [...] w M.",
    ]);
  });

  test("an old document broken at its margin reads as sentences", async () => {
    const decision = build(await rowOf("margin-breaks-and-truncated-symbol"));
    const paragraphs = paragraphsOf(decision);
    expect(
      paragraphs.some((paragraph) =>
        paragraph.includes(
          "na cele gospodarczo - składowe, tj. skład owoców, garaż na sprzęt rolniczy oraz poddasze na skład siana i słomy na działce",
        ),
      ),
    ).toBe(true);
    expect(decision.metadata["textComplete"]).toBe(true);
  });

  test("a case symbol's name loses its padding, not its words", async () => {
    const recorded = await rowOf("margin-breaks-and-truncated-symbol");
    const symbols: unknown = build(recorded).metadata["caseSymbols"];
    const published = recorded.values["case_type_description"];
    expect(published).toEqual([expect.stringContaining("części,\u00a0 ")]);
    expect(symbols).toEqual([
      {
        code: "6010",
        description:
          "Pozwolenie na budowę, użytkowanie obiektu lub jego części, wykonywanie robót budowlanych innych niż budowa obiektu, prz",
        asPublished: Array.isArray(published) ? published[0] : null,
      },
    ]);
  });

  test("the thesis reads as the document does", async () => {
    const recorded = await rowOf("thesis-and-reasons-breaks");
    const decision = build(recorded);
    const { headnote } = decision.textFields;
    expect(headnote.type === "present" ? String(headnote.text) : null).toBe(
      plNsaParagraphs(
        columnOf(recorded.values, "thesis") ?? "",
        NO_SUPERSCRIPTS,
      ).join("\n\n"),
    );
    expect(
      paragraphsOf(decision).some((paragraph) =>
        paragraph.includes("okoliczności faktycznych i prawnych:"),
      ),
    ).toBe(true);
  });
});

describe("pl-nsa page furniture", () => {
  test("page numbers after the closing rule go, with the rule", async () => {
    const decision = build(await rowOf("closing-rule-page-footer"));
    const paragraphs = paragraphsOf(decision);
    expect(paragraphs.at(-1)).toEndWith(
      "na podstawie art. 151 P.p.s.a. oddalił skargę.",
    );
    expect(
      paragraphs.filter((paragraph) => /^-{5,}$/u.test(paragraph)),
    ).toEqual([]);
    expect(decision.fulltext).not.toContain("Strona 2 z 23");
    expect(decision.metadata["textComplete"]).toBe(true);
  });

  test("a note after the closing rule stays under it", () => {
    expect(
      plNsaParagraphs(
        [
          "Sąd oddalił skargę.",
          "-----------------------",
          "[1] wszystkie orzeczenia dostępne w CBOSA.",
          "2",
          "#/32",
          "Strona 2 z 9",
        ].join("\n\n"),
        NO_SUPERSCRIPTS,
      ),
    ).toEqual([
      "Sąd oddalił skargę.",
      "-----------------------",
      "[1] wszystkie orzeczenia dostępne w CBOSA.",
    ]);
  });
});

describe("pl-nsa superscript article numbers", () => {
  const superscriptRow = async () => {
    const recorded = await rowOf("superscript-forms");
    return {
      raw: columnOf(recorded.values, "reasons_for_judgment") ?? "",
      text: paragraphsOf(build(recorded)).join("\n\n"),
    };
  };

  test("a spaced or primed superscript joins its number", async () => {
    const { raw, text } = await superscriptRow();
    const spacedOrPrimed = /art\. 23(?: ¹|')/gu;
    expect(countOf(raw, spacedOrPrimed)).toBeGreaterThan(0);
    expect(countOf(text, spacedOrPrimed)).toBe(0);
    expect(countOf(text, /art\. 23¹/gu)).toBe(
      countOf(raw, /art\. 23¹/gu) + countOf(raw, spacedOrPrimed),
    );
  });

  test("a superscript merged into its number stays as published", async () => {
    const { raw, text } = await superscriptRow();
    expect(countOf(text, /art\. ?231\b/gu)).toBe(
      countOf(raw, /art\. ?231\b/gu),
    );
    const merged = await rowOf("superscript-merged");
    const mergedRaw =
      columnOf(merged.values, "reasons_for_judgment") ?? panic("no reasons");
    const mergedText = paragraphsOf(build(merged)).join("\n\n");
    expect(countOf(mergedRaw, /art\. ?231\b/gu)).toBeGreaterThan(10);
    expect(countOf(mergedText, /art\. ?231\b/gu)).toBe(
      countOf(mergedRaw, /art\. ?231\b/gu),
    );
    expect(mergedText).not.toContain("23¹");
  });

  const read = (text: string) =>
    plNsaParagraphs(text, plNsaStatedSuperscripts([text])).join("\n\n");

  test("a prime is read as a superscript only where the document writes one", () => {
    expect(read("nieważność z art. 183'§ 2 p.p.s.a.")).toBe(
      "nieważność z art. 183'§ 2 p.p.s.a.",
    );
    expect(read("art. 199`a § 3 o.p. oraz art. 199a o.p.")).toBe(
      "art. 199`a § 3 o.p. oraz art. 199a o.p.",
    );
    expect(read("art. 55' k.c. i art. 55¹ k.c.")).toBe(
      "art. 55¹ k.c. i art. 55¹ k.c.",
    );
    expect(
      read("art. 36' ust. 1 u.r.p., art. 36¹ u.r.p. i art. 36² u.r.p."),
    ).toBe("art. 36' ust. 1 u.r.p., art. 36¹ u.r.p. i art. 36² u.r.p.");
    expect(read("art. 9 ² ust. 12 i art. 626 ²§ 5 k.p.c.")).toBe(
      "art. 9² ust. 12 i art. 626²§ 5 k.p.c.",
    );
  });

  test("a prime closing a quotation stays a quotation mark", () => {
    for (const text of [
      "art. 23¹ k.p.; cytat: ‘art. 23’ ustawy o ochronie danych",
      "art. 23¹ k.p.; cytat: ‘art. 23’ k.p.",
      "art. 23¹ k.p.; cytat: 'art. 23' k.p.",
    ]) {
      expect(read(text)).toBe(text);
    }
  });

  test("a prime on another statute's article stays", () => {
    expect(read("art. 23¹ k.p. oraz art. 23' ustawy o ochronie danych")).toBe(
      "art. 23¹ k.p. oraz art. 23' ustawy o ochronie danych",
    );
    expect(read("art. 23¹ Kodeksu pracy i art. 23' § 1 Kodeksu pracy")).toBe(
      "art. 23¹ Kodeksu pracy i art. 23¹ § 1 Kodeksu pracy",
    );
    expect(read("art. 23¹ K. p. oraz art. 23' k.p.")).toBe(
      "art. 23¹ K. p. oraz art. 23¹ k.p.",
    );
  });
});

describe("pl-nsa joins it must not make", () => {
  test("a full stop after an ordinary short word ends the sentence", () => {
    for (const text of [
      ["Organ nie wykazał tych wad.", "ocena prawna należy do sądu."],
      ["Skarżący przedstawił fakt.", "w odpowiedzi organ wniósł o oddalenie."],
      ["Wniosek złożono w maju.", "na tej podstawie wszczęto postępowanie."],
    ]) {
      expect(plNsaParagraphs(text.join("\n\n"), NO_SUPERSCRIPTS)).toEqual(text);
    }
  });

  test("a sentence goes on after an abbreviation", () => {
    for (const [above, next] of [
      ["naruszenie art. 7 w zw.", "z art. 77 § 1 k.p.a."],
      ["decyzją z dnia 12.03.2020r.", "w sprawie podatku"],
      ["skarga M. D.", "na uchwałę Rady Gminy"],
      ["(t.j. Dz. U.", "z 2023 r., poz. 2383 ze zm.)"],
    ] as const) {
      expect(plNsaParagraphs(`${above}\n\n${next}`, NO_SUPERSCRIPTS)).toEqual([
        `${above} ${next}`,
      ]);
    }
  });

  test("a Roman numeral of any length marks a list item", () => {
    const text = [
      "xvii) art. 4 ustawy, lub",
      "xviii) art. 5 ustawy, lub",
      "xxxiv. art. 6 ustawy, oraz",
      "xl) art. 7 ustawy.",
    ];
    expect(plNsaParagraphs(text.join("\n\n"), NO_SUPERSCRIPTS)).toEqual(text);
  });
});

describe("pl-nsa notes after the closing rule", () => {
  test("a number before its note is the note's label", () => {
    expect(
      plNsaParagraphs(
        [
          "Treść.",
          "-----------------------",
          "1",
          "Por. wyrok NSA.",
          "2",
          "Por. komentarz do ustawy.",
          "3",
        ].join("\n\n"),
        NO_SUPERSCRIPTS,
      ),
    ).toEqual([
      "Treść.",
      "-----------------------",
      "1",
      "Por. wyrok NSA.",
      "2",
      "Por. komentarz do ustawy.",
    ]);
  });

  test("rules with only page numbers after them all go in one reading", () => {
    const once = plNsaParagraphs(
      ["Treść.", "-----", "2", "-----", "Strona 3 z 4"].join("\n\n"),
      NO_SUPERSCRIPTS,
    );
    expect(once).toEqual(["Treść."]);
    expect(plNsaParagraphs(once.join("\n\n"), NO_SUPERSCRIPTS)).toEqual(once);
  });
});

describe("pl-nsa completeness check", () => {
  const COMPOUNDS = [
    ["rolno-", "środowiskowych"],
    ["techniczno-", "budowlanych"],
    ["sądowo-", "administracyjnym"],
    ["usługowo-", "mieszkalnego"],
    ["słuchowo-", "ruchowej"],
    ["wewnątrz-", "administracyjnego"],
    ["społeczno-", "gospodarczych"],
    ["finansowo-", "księgowej"],
    ["organizacyjno-", "technicznych"],
    ["handlowo-", "usługowego"],
  ] as const;

  const reasons = COMPOUNDS.map(
    ([left, right]) => `Organ ocenił skutki ${left}\n\n${right} zmian.`,
  ).join("\n\n");

  const parse = (reference: string) =>
    parsePlNsaDecision({
      caseNumber: "II SA/Kr 1/11",
      court: "Wojewódzki Sąd Administracyjny w Krakowie",
      decisionDate: "2011-03-31",
      decisionType: "wyrok",
      title: "Wyrok WSA w Krakowie",
      documentId: "0000000000",
      sourceUrl: "https://orzeczenia.nsa.gov.pl/doc/0000000000",
      keywords: [],
      statutes: [],
      sections: {
        thesis: null,
        sentence: "Oddala skargę.",
        reasons,
        dissent: null,
      },
      reference,
    });

  test("a line joined after its hyphen loses no word", () => {
    const parsed = parse(
      `SENTENCJA\n\nOddala skargę.\n\n\nUZASADNIENIE\n\n${reasons}`,
    );
    expect(parsed.textSource).toBe("sections");
    expect(parsed.validation.stats.missingWords).toEqual([]);
    expect(parsed.fulltext).toContain(
      "Organ ocenił skutki rolno-środowiskowych zmian.",
    );
  });

  test("a word the reading drops still shows as lost", () => {
    const parsed = parse(
      `SENTENCJA\n\nOddala skargę.\n\n\nUZASADNIENIE\n\n${reasons}\n\nSąd zważył okoliczności nieobecne gdzie indziej.`,
    );
    expect(parsed.validation.stats.missingWords).toEqual(
      expect.arrayContaining(["nieobecne", "indziej"]),
    );
  });
});
