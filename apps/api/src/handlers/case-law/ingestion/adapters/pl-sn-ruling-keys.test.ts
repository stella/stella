/**
 * The Supreme Court ruling key, on rulings both Polish sources hold.
 *
 * The pair below is one judgment as each publisher serves it: SAOS's detail
 * record and the court's own listing row for the same decision date, both
 * recorded. Each is built by its own adapter, so what is compared is what the
 * two rows store.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  assemblePlSnDecision,
  normalizePlSnListingItem,
  readPlSnEnvelope,
} from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
import {
  normalizeSupremeCourtDocket,
  plSupremeCourtRulingKeys,
} from "@/api/handlers/case-law/ingestion/adapters/pl-sn-ruling-keys";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const snListingRows = async (
  name: string,
): Promise<Record<string, unknown>[]> => {
  const payload = readPlSnEnvelope(
    JSON.parse(await Bun.file(new URL(name, FIXTURES)).text()),
  );
  if (!Array.isArray(payload)) {
    return panic(`${name} holds no listing rows`);
  }
  const rows: unknown[] = payload;
  return rows.filter(isRecord);
};

const storedRulingKeys = (metadata: Record<string, unknown>): string[] => {
  const keys = metadata["rulingKeys"];
  return isUnknownArray(keys)
    ? keys.filter((key): key is string => typeof key === "string")
    : [];
};

/** A listing row as `pl-sn` stores it when neither detail nor file is read. */
const snRowKeys = async (row: Record<string, unknown>): Promise<string[]> => {
  const built = await assemblePlSnDecision({
    item: normalizePlSnListingItem(row),
    detail: null,
    documentBytes: undefined,
    rawParts: { listing: JSON.stringify(row) },
  });
  return built.type === "unkeyable"
    ? []
    : storedRulingKeys(built.decision.metadata);
};

const saosChamberDetail = async (): Promise<Record<string, unknown>> => {
  const payload: unknown = JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(
        await Bun.file(
          new URL("pl-courts-detail-chamber.json.gz", FIXTURES),
        ).bytes(),
      ),
    ),
  );
  const data = isRecord(payload) ? payload["data"] : undefined;
  return isRecord(data) ? data : panic("the capture holds no judgment");
};

describe("one ruling stored by both sources", () => {
  test("a SAOS judgment and the court's own listing row share a key", async () => {
    const detail = await saosChamberDetail();
    const saos =
      buildPlDecision({
        listingItem: normalizeSaosDumpItem({ id: detail["id"] }),
        detail: normalizeSaosDumpItem(detail),
        rawParts: { detail: JSON.stringify({ data: detail }) },
      }) ?? panic("the SAOS capture built no decision");
    const snRow =
      (await snListingRows("pl-sn-listing-2016-06-22.json")).find(
        (row) => row["sygnatura_sprawy"] === saos.caseNumber,
      ) ?? panic(`sn.pl lists no ${saos.caseNumber} on that date`);

    const saosKeys = storedRulingKeys(saos.metadata);
    expect(saosKeys).toEqual(["sn|IIIKK195/16|2016-06-22|wyrok"]);
    expect(await snRowKeys(snRow)).toEqual(saosKeys);
  });

  // Real pairs: each SAOS record's id, type, date and docket, and the court's
  // listing row for the same ruling, as the two publishers state them.
  test.each([
    [
      76_454,
      "RESOLUTION",
      "1994-02-03",
      "II UZP 1/94",
      "IV6WSZcBZvGrB8P_cB-T",
      "uchwała SN",
    ],
    [
      77_540,
      "DECISION",
      "1997-03-20",
      "III ZP 15/97",
      "jF64SZcBZvGrB8P_liuw",
      "postanowienie siedmiu sędziów SN",
    ],
    [
      78_184,
      "SENTENCE",
      "1998-03-05",
      "III SZ 6/97",
      "0V62SZcBZvGrB8P_Oiqo",
      "orzeczenie",
    ],
    [
      81_247,
      "REGULATION",
      "2002-02-26",
      "SNO 4/02",
      "rl7JSZcBZvGrB8P_9TFq",
      "zarządzenie",
    ],
    [
      81_881,
      "SENTENCE",
      "2003-02-25",
      "WK 45/02",
      "c17DSZcBZvGrB8P_oS_L",
      "wyrok siedmiu sędziów SN",
    ],
  ])(
    "SAOS %p (%s) meets the court's own row",
    async (saosId, judgmentType, date, docket, snId, form) => {
      const saos =
        buildPlDecision({
          listingItem: normalizeSaosDumpItem({
            id: saosId,
            courtType: "SUPREME",
            judgmentType,
            judgmentDate: date,
            courtCases: [{ caseNumber: docket }],
          }),
          detail: null,
          rawParts: {},
        }) ?? panic("the SAOS record built no decision");
      const snKeys = await snRowKeys({
        sygnatura_sprawy: docket,
        data_wydania: date,
        forma_orzeczenia: form,
        id: snId,
      });

      expect(snKeys).toHaveLength(1);
      expect(storedRulingKeys(saos.metadata)).toEqual(snKeys);
    },
  );

  test("every row the court lists for a date is keyed, and no two alike", async () => {
    const rows = await snListingRows("pl-sn-listing-2016-06-22.json");
    const keys = await Promise.all(rows.map(snRowKeys));

    expect(keys.every((rowKeys) => rowKeys.length === 1)).toBe(true);
    expect(new Set(keys.flat()).size).toBe(rows.length);
  });
});

describe("the key", () => {
  const judgment = {
    caseNumber: "I CSK 679/15",
    court: "Sąd Najwyższy",
    decisionDate: "2017-02-16",
    decisionType: "wyrok",
  };

  test("a judgment and an order on one docket and date are two rulings", () => {
    // The court lists both for this docket on the same day.
    const order = plSupremeCourtRulingKeys({
      ...judgment,
      decisionType: "postanowienie",
    });

    expect(order).not.toEqual(plSupremeCourtRulingKeys(judgment));
  });

  test("one key per docket a joined ruling names", () => {
    expect(
      plSupremeCourtRulingKeys({
        ...judgment,
        identifiers: [
          {
            type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
            value: "I CSK 680/15",
          },
        ],
      }),
    ).toEqual([
      "sn|ICSK679/15|2017-02-16|wyrok",
      "sn|ICSK680/15|2017-02-16|wyrok",
    ]);
  });

  test("another court's ruling has none", () => {
    expect(
      plSupremeCourtRulingKeys({
        ...judgment,
        court: "Sąd Apelacyjny w Łodzi",
      }),
    ).toEqual([]);
  });

  test("a row without a date or a kind has none", () => {
    expect(
      plSupremeCourtRulingKeys({ ...judgment, decisionDate: undefined }),
    ).toEqual([]);
    expect(
      plSupremeCourtRulingKeys({ ...judgment, decisionType: undefined }),
    ).toEqual([]);
  });

  test("a composed bench's form keys by its leading word", () => {
    expect(
      plSupremeCourtRulingKeys({
        ...judgment,
        decisionType: "Uchwała siedmiu sędziów",
      }),
    ).toEqual(["sn|ICSK679/15|2017-02-16|uchwała"]);
  });
});

describe("docket spellings", () => {
  test.each([
    ["III CSK 12/15", "IIICSK12/15"],
    ["IIICSK 12/15", "IIICSK12/15"],
    ["III  CSK 12 / 15", "IIICSK12/15"],
    ["III CSK 12/2015", "IIICSK12/15"],
    ["III CSK 012/15", "IIICSK12/15"],
    ["Sygn. akt III CSK 12/15", "IIICSK12/15"],
    ["I NSNc 1/18", "INSNC1/18"],
    ["I NSNC 1/18", "INSNC1/18"],
    ["III SW 121-122/07", "IIISW121-122/07"],
    ["III SW 121–122/07", "IIISW121-122/07"],
  ])("%p reads as %p", (docket, normalized) => {
    expect(normalizeSupremeCourtDocket(docket)).toBe(normalized);
  });
});
