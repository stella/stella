/**
 * pl-kis against payloads eureka.mf.gov.pl served.
 *
 * One listing page and one detail per ingested category are captured verbatim
 * with provenance sidecars. Paging, resuming and the tip are driven through a
 * stubbed transport, because the behaviour under test is the cursor's.
 */

import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assemblePlKisDecision,
  encodePlKisCursor,
  parsePlKisCursor,
  parsePlKisProvision,
  parsePlKisSlice,
  plKisAdapter,
  plKisCategoryById,
  plKisCategoryLabel,
  plKisDay,
  plKisDocumentIdOf,
  plKisListingBody,
  plKisListingIdentity,
  plKisListingUrl,
  plKisMonthBounds,
  plKisNextSlice,
  plKisPreviousSlice,
  plKisQuarantineId,
  plKisRawPartsOf,
  plKisSlice,
  PL_KIS_INCLUDED_CATEGORIES,
  PL_KIS_UNDATED_SLICE,
  readPlKisListing,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kis";
import type { PlKisBuildResult } from "@/api/handlers/case-law/ingestion/adapters/pl-kis";
import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

// ── Captured payloads ────────────────────────────────────

const readListingFixture = async (
  tag: string,
): Promise<Record<string, unknown>[]> => {
  const parsed: unknown = JSON.parse(
    await Bun.file(new URL(`pl-kis-listing-${tag}.json`, FIXTURES_DIR)).text(),
  );
  const read = readPlKisListing(parsed);
  if (read === null) {
    throw new TypeError(`${tag}: the captured listing is not a search result`);
  }
  return read.rows;
};

const readDetailFixture = async (tag: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(
        await Bun.file(
          new URL(`pl-kis-detail-${tag}.json.gz`, FIXTURES_DIR),
        ).arrayBuffer(),
      ),
    ),
  );

const builtFrom = async (
  tag: string,
): Promise<{
  row: Record<string, unknown>;
  decision: IngestionResult;
}> => {
  const [row] = await readListingFixture(tag);
  if (row === undefined) {
    throw new TypeError(`${tag}: the captured listing holds no row`);
  }
  const built = await assemblePlKisDecision({
    row,
    rawParts: plKisRawPartsOf(row, await readDetailFixture(tag)),
  });
  if (built.type !== "built") {
    throw new TypeError(`${tag}: the captured payloads did not build`);
  }
  return { row, decision: built.decision };
};

/** The capture the stored dictionary of categories was read from. */
const readCategoryDictionary = async (): Promise<
  { id: number; kod: string }[]
> => {
  const parsed: unknown = JSON.parse(
    await Bun.file(
      new URL("pl-kis-dictionary-categories.json", FIXTURES_DIR),
    ).text(),
  );
  const content = isRecord(parsed) ? parsed["content"] : undefined;
  return Array.isArray(content)
    ? content.flatMap((entry) =>
        isRecord(entry) &&
        typeof entry["id"] === "number" &&
        typeof entry["kod"] === "string"
          ? [{ id: entry["id"], kod: entry["kod"] }]
          : [],
      )
    : [];
};

/** The dictionary's own name for each category, lowercased, by id. */
const readCategoryDictionaryLabels = async (): Promise<Map<number, string>> => {
  const parsed: unknown = JSON.parse(
    await Bun.file(
      new URL("pl-kis-dictionary-categories.json", FIXTURES_DIR),
    ).text(),
  );
  const content = isRecord(parsed) ? parsed["content"] : undefined;
  return new Map(
    (Array.isArray(content) ? content : []).flatMap((entry) =>
      isRecord(entry) &&
      typeof entry["id"] === "number" &&
      typeof entry["wartosc"] === "string"
        ? [[entry["id"], entry["wartosc"].toLocaleLowerCase("pl-PL")] as const]
        : [],
    ),
  );
};

// ── Stubbed transport ────────────────────────────────────

type Call = { url: string; method: string; body: string };

const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const stubPublisher = (
  answer: (call: Call) => Response,
): { calls: Call[]; restore: () => void } => {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: urlOf(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      return await Promise.resolve(answer(call));
    },
  );
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const isSearch = (call: Call): boolean =>
  call.url.includes("/wyszukiwarka/informacje/");

const bodyOf = (call: Call | undefined): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(call?.body ?? "null");
  return isRecord(parsed) ? parsed : {};
};

const rowFor = (id: number): Record<string, unknown> => ({
  ID_INFORMACJI: String(id),
  KATEGORIA_INFORMACJI: ["Interpretacja indywidualna"],
  SYG: `0114-KDIP1-2.4012.${id}.2024.1.AB`,
  DT_WYD: "2010-03-05",
  AUTOR: ["Dyrektor Krajowej Informacji Skarbowej"],
  STATUS_INFORMACJI: ["Aktualna"],
});

const detailFor = (id: string, html: string | undefined): unknown => ({
  id: Number(id),
  versionId: 1,
  nazwa: "Interpretacja indywidualna",
  szablonId: 1,
  wersjaSzablonuId: 1,
  dokument: {
    fields: [
      { dataType: "StringType", key: "ID_INFORMACJI", value: id },
      { dataType: "StringType", key: "KATEGORIA_INFORMACJI", value: "1" },
      { dataType: "StringType", key: "STATUS_INFORMACJI", value: "27" },
      ...(html === undefined
        ? []
        : [
            { dataType: "StringType", key: "TRESC_INTERESARIUSZ", value: html },
          ]),
    ],
  },
  informacjaTytulDto: [],
});

const DETAIL_ID = /\/informacje\/(?<id>\d+)$/u;

/** A detail for every id, stating a two-paragraph document. */
const answerDetail = (call: Call): Response | undefined => {
  const id = DETAIL_ID.exec(call.url)?.groups?.["id"];
  return id === undefined
    ? undefined
    : json(
        detailFor(
          id,
          "<p>Interpretacja indywidualna</p><p>Stanowisko jest prawidłowe.</p>",
        ),
      );
};

const cursorOf = (page: Awaited<ReturnType<typeof plKisAdapter.fetchPage>>) =>
  Result.isOk(page) ? page.value.nextCursor : `error: ${page.error.message}`;

const originalSleep = Bun.sleep;

beforeEach(() => {
  Bun.sleep = async () => {
    // The publisher gate and the retry backoff pace a live service.
  };
});

afterEach(() => {
  Bun.sleep = originalSleep;
});

// ── The search request ───────────────────────────────────

describe("the search request", () => {
  test("keeps the slash the service requires before the query", () => {
    const url = new URL(
      plKisListingUrl({
        page: 3,
        size: 20,
        sort: ["DT_WYD,asc", "ID_INFORMACJI,asc"],
      }),
    );
    expect(url.pathname).toBe("/api/public/v1/wyszukiwarka/informacje/");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("size")).toBe("20");
    expect(url.searchParams.getAll("sort")).toEqual([
      "DT_WYD,asc",
      "ID_INFORMACJI,asc",
    ]);
  });

  test("names a filter and columns, and filters categories by numeric ids", () => {
    const body: unknown = JSON.parse(
      plKisListingBody({
        categories: [1],
        issuedFrom: "2010-03-01",
        issuedTo: "2010-03-31",
      }),
    );
    expect(body).toMatchObject({
      filter: {
        KATEGORIA_INFORMACJI: [1],
        DT_WYD_start: "2010-03-01",
        DT_WYD_end: "2010-03-31",
      },
    });
    const columns = isRecord(body) ? body["columns"] : undefined;
    expect(Array.isArray(columns) && columns.includes("SYG")).toBe(true);
  });

  test("the crawl sends exactly that request", async () => {
    const stub = stubPublisher(() => json({ results: [], totalHits: 0 }));
    try {
      await plKisAdapter.fetchPage(
        encodePlKisCursor({
          phase: "sweep",
          boundary: "700000",
          month: "2010-03",
          page: 0,
        }),
        {},
      );
      const [first] = stub.calls;
      expect(first?.method).toBe("POST");
      expect(first?.url).toContain("/wyszukiwarka/informacje/?");
      const filter = bodyOf(first)["filter"];
      expect(isRecord(filter) ? filter["DT_WYD_start"] : undefined).toBe(
        "2010-03-01",
      );
      const categories = isRecord(filter)
        ? filter["KATEGORIA_INFORMACJI"]
        : undefined;
      expect(
        Array.isArray(categories) &&
          categories.every((id) => typeof id === "number"),
      ).toBe(true);
    } finally {
      stub.restore();
    }
  });
});

// ── Captured categories ──────────────────────────────────

const CAPTURED = PL_KIS_INCLUDED_CATEGORIES.filter(
  // The service lists nothing under the jurisdiction-dispute category.
  ({ slug }) => slug !== "19-spor",
);

describe("every ingested category, as the service served it", () => {
  for (const category of CAPTURED) {
    test(`${category.slug}: keyed, typed and read`, async () => {
      const { decision, row } = await builtFrom(category.slug);
      expect(decision.sourceDocumentId).toBe(plKisDocumentIdOf(row));
      expect(decision.sourceDocumentId).toMatch(/^\d+$/u);
      expect(decision.decisionType).toBe(category.decisionType);
      expect(decision.caseNumber).toBe(String(row["SYG"]).trim());
      expect(decision.court.length).toBeGreaterThan(0);
      expect(decision.decisionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(decision.fulltext?.length ?? 0).toBeGreaterThan(100);
      expect(decision.isListingOnly).toBeUndefined();
      // Nothing the service states is a field the inventory has not decided.
      expect(decision.metadata["unmappedSourceFields"]).toBeUndefined();
      expect(decision.metadata["status"]).not.toBe("unknown");
      expect(decision.sourceRawContentType).toBe(
        SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      );
      const related = decision.metadata["relatedDocuments"];
      const amended = row["INFORMACJA_ZMIENIANA"];
      if (category.relation !== undefined && typeof amended === "string") {
        expect(related).toEqual([
          expect.objectContaining({
            relation: category.relation,
            eurekaId: amended,
          }),
        ]);
      }
    });

    test(`${category.slug}: the signature is a Polish docket`, async () => {
      const rows = await readListingFixture(category.slug);
      for (const row of rows) {
        const signature = String(row["SYG"]);
        expect(
          DECISION_DOCKET_GRAMMARS.POL.parse(signature),
          signature,
        ).not.toBeNull();
      }
    });
  }

  test("a tax chamber's interpretation from 2008 reads the same way", async () => {
    const { decision } = await builtFrom("01-ind-2008");
    expect(decision.decisionDate?.startsWith("2008-03")).toBe(true);
    expect(
      DECISION_DOCKET_GRAMMARS.POL.parse(decision.caseNumber),
    ).not.toBeNull();
    expect(decision.fulltext?.length ?? 0).toBeGreaterThan(100);
  });

  test("a refused excise ruling's elided thesis is no thesis", async () => {
    const { decision, row } = await builtFrom("13-wia-odm");
    expect(row["TEZA"]).toBe("(...)");
    expect(decision.textFields.headnote).toEqual({
      type: "absent",
      reason: "publisher_placeholder",
    });
  });

  test("a thesis that only contains an elision is kept", async () => {
    const { decision } = await builtFrom("06-wis");
    expect(decision.textFields.headnote.type).toBe("present");
  });

  test("a tax chamber's interpretation names its chamber as the authority", async () => {
    const { decision } = await builtFrom("01-ind-2008");
    expect(decision.court).toBe("Dyrektor Izby Skarbowej w Bydgoszczy");
    expect(decision.caseNumber).toBe("ITPB1/415-778/07/MR");
  });

  test("a superseded interpretation says so", async () => {
    const { decision } = await builtFrom("01-ind-superseded");
    expect(decision.metadata["status"]).toBe("superseded");
    expect(decision.metadata["statusId"]).toBe("29");
  });

  test("an amendment names the document it amends", async () => {
    const { decision } = await builtFrom("02-ind-zm");
    const [relation] = Array.isArray(decision.metadata["relatedDocuments"])
      ? decision.metadata["relatedDocuments"]
      : [];
    expect(relation).toMatchObject({ relation: "amends" });
  });

  test("a detail without its HTML is read from the PDF rendition", async () => {
    const [row] = await readListingFixture("05-objas");
    const parsed: unknown = JSON.parse(await readDetailFixture("05-objas"));
    if (
      row === undefined ||
      !isRecord(parsed) ||
      !isRecord(parsed["dokument"])
    ) {
      throw new TypeError("the captured tax explanations did not read");
    }
    const fields = parsed["dokument"]["fields"];
    const withoutHtml = {
      ...parsed,
      dokument: {
        fields: Array.isArray(fields)
          ? fields.filter(
              (field) =>
                !isRecord(field) || field["key"] !== "TRESC_INTERESARIUSZ",
            )
          : [],
      },
    };
    const pdfBytes = new Uint8Array(
      await Bun.file(
        new URL("pl-kis-document-05-objas.pdf", FIXTURES_DIR),
      ).arrayBuffer(),
    );
    const built = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(row, JSON.stringify(withoutHtml)),
      pdfBytes,
    });
    expect(built.type).toBe("built");
    if (built.type === "built") {
      expect(built.decision.metadata["documentFrom"]).toBe("pdf");
      expect(built.decision.fulltext).toContain("waloryzacji");
      expect(built.decision.sourceRawObjects?.["document-pdf"]?.bytes).toEqual(
        pdfBytes,
      );
    }
  });

  test("a corrected PDF under an unchanged detail changes the hash", async () => {
    const row = rowFor(700_040);
    const rawParts = plKisRawPartsOf(
      row,
      JSON.stringify(detailFor("700040", undefined)),
    );
    const pdf = new Uint8Array(
      await Bun.file(
        new URL("pl-kis-document-05-objas.pdf", FIXTURES_DIR),
      ).arrayBuffer(),
    );
    const corrected = Uint8Array.from([...pdf, 0x0a]);
    const first = await assemblePlKisDecision({ row, rawParts, pdfBytes: pdf });
    const again = await assemblePlKisDecision({ row, rawParts, pdfBytes: pdf });
    const second = await assemblePlKisDecision({
      row,
      rawParts,
      pdfBytes: corrected,
    });
    expect(first.decision.sourceRaw).toBe(second.decision.sourceRaw);
    expect(first.decision.rawHash).toBe(again.decision.rawHash);
    expect(first.decision.rawHash).not.toBe(second.decision.rawHash);
  });

  test("a replay of the stored envelope rebuilds the same row", async () => {
    const { decision } = await builtFrom("01-ind");
    const replayed = await plKisAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: decision.sourceDocumentId ?? null,
      language: decision.language,
      court: decision.court,
      ecli: null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    expect(replayed?.type).toBe("parsed");
    if (replayed?.type === "parsed") {
      expect(replayed.result.rawHash).toBe(decision.rawHash);
      expect(replayed.result.fulltext).toBe(decision.fulltext);
      expect(replayed.result.metadata).toEqual(decision.metadata);
    }
  });

  test("every ingested category is found by the label its listing prints", async () => {
    const dictionary = await readCategoryDictionaryLabels();
    for (const category of PL_KIS_INCLUDED_CATEGORIES) {
      expect(dictionary.get(category.id), category.slug).toBe(
        plKisCategoryLabel(category),
      );
    }
  });

  test("a listing-only row of a long-named category keeps its category", async () => {
    const [row] = await readListingFixture("18-opw-odm");
    if (row === undefined) {
      throw new TypeError("the captured listing holds no row");
    }
    const built = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(row, undefined),
      detailStatus: "detail-gone",
    });
    expect(built.decision.decisionType).toBe(
      "postanowienie o odmowie wydania opinii w sprawie opodatkowania wyrównawczego",
    );
    expect(built.decision.metadata["category"]).toMatchObject({
      id: 74_593,
      disposition: "included",
    });
  });

  test("every category the service's dictionary lists has a disposition", async () => {
    const dictionary = await readCategoryDictionary();
    expect(dictionary.length).toBeGreaterThan(20);
    const undecided = dictionary.filter(
      ({ id }) => plKisCategoryById(id) === undefined,
    );
    expect(undecided).toEqual([]);
  });
});

// ── Identity and the unmapped-field guard ────────────────

describe("identity", () => {
  test("is the service's id, the same with or without the detail", async () => {
    const row = rowFor(700_001);
    const full = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(
        row,
        JSON.stringify(detailFor("700001", "<p>Treść interpretacji.</p>")),
      ),
    });
    const listingOnly = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(row, undefined),
      detailStatus: "detail-gone",
    });
    const idOf = (built: PlKisBuildResult) => built.decision.sourceDocumentId;
    expect(idOf(full)).toBe("700001");
    expect(idOf(listingOnly)).toBe("700001");
    expect(listingOnly.type).toBe("detail-unavailable");
  });

  test("a detail naming another document is not this one's detail", async () => {
    const row = rowFor(700_002);
    const built = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(
        row,
        JSON.stringify(detailFor("999999", "<p>Inny dokument.</p>")),
      ),
    });
    expect(built.type).toBe("detail-unavailable");
    if (built.type === "detail-unavailable") {
      expect(built.decision.metadata["detailStatus"]).toBe("detail-unreadable");
    }
  });

  test("a row without a numeric id is quarantined, never keyed on a guess", () => {
    const malformed = { ID_INFORMACJI: "abc", SYG: "DD4.8201.2.2026" };
    expect(plKisListingIdentity(malformed)).toEqual({
      type: "document",
      sourceDocumentId: plKisQuarantineId(malformed),
    });
    // The fingerprint reads the row's stable fields, not the id it lacks.
    expect(plKisQuarantineId(malformed)).toBe(
      plKisQuarantineId({ SYG: "DD4.8201.2.2026" }),
    );
    expect(plKisQuarantineId(malformed)).not.toBe(
      plKisQuarantineId({ SYG: "DD4.8201.3.2026" }),
    );
    expect(plKisListingIdentity({ ID_INFORMACJI: 42 })).toEqual({
      type: "document",
      sourceDocumentId: "42",
    });
  });
});

describe("the issuing authority", () => {
  test("is the record's own and never assumed", async () => {
    const { AUTOR: _authority, ...withoutAuthority } = rowFor(700_020);
    const built = await assemblePlKisDecision({
      row: withoutAuthority,
      rawParts: plKisRawPartsOf(
        withoutAuthority,
        JSON.stringify(detailFor("700020", "<p>Treść interpretacji.</p>")),
      ),
    });
    expect(built.decision.court).toBe("");
    expect(built.decision.metadata["authorities"]).toEqual([]);
  });
});

describe("the document", () => {
  test("keeps the emphasis the service's HTML prints", async () => {
    const row = rowFor(700_030);
    const built = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(
        row,
        JSON.stringify(
          detailFor(
            "700030",
            "<p>Stanowisko jest <b>prawidłowe</b> w zakresie <i>ulgi</i>.</p>",
          ),
        ),
      ),
    });
    const ast = built.decision.documentAst;
    const kinds = JSON.stringify("blocks" in ast ? ast.blocks : []);
    expect(kinds).toContain('"type":"bold"');
    expect(kinds).toContain('"type":"italic"');
  });

  test("every captured document survives into the AST whole", async () => {
    for (const category of CAPTURED) {
      const { decision } = await builtFrom(category.slug);
      const parsed: unknown = JSON.parse(
        await readDetailFixture(category.slug),
      );
      const fields =
        isRecord(parsed) && isRecord(parsed["dokument"])
          ? parsed["dokument"]["fields"]
          : [];
      const html = Array.isArray(fields)
        ? fields.find(
            (field) =>
              isRecord(field) && field["key"] === "TRESC_INTERESARIUSZ",
          )
        : undefined;
      const source =
        isRecord(html) && typeof html["value"] === "string"
          ? html["value"]
          : "";
      const ast = decision.documentAst;
      const result = validateAst(source, "blocks" in ast ? ast.blocks : []);
      const lost = result.issues.filter(({ code }) =>
        [
          "CONTENT_LOSS",
          "MISSING_WORDS",
          "EMPTY_AST",
          "MARKUP_RESIDUE",
        ].includes(code),
      );
      expect(lost, category.slug).toEqual([]);
    }
  });
});

describe("the unmapped-field guard", () => {
  test("names a field the service added and keeps it in the envelope", async () => {
    const row = { ...rowFor(700_003), NOWA_KOLUMNA: "x" };
    const detail = detailFor("700003", "<p>Treść interpretacji.</p>");
    const withField = isRecord(detail) ? { ...detail, nowyKlucz: 1 } : detail;
    const built = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(row, JSON.stringify(withField)),
    });
    expect(built.type).toBe("built");
    if (built.type === "built") {
      expect(built.decision.metadata["unmappedSourceFields"]).toEqual([
        "NOWA_KOLUMNA",
        "informacja/nowyKlucz",
      ]);
      const parts = decodeSourceRawEnvelope(built.decision.sourceRaw ?? "");
      expect(parts?.["listing"]).toContain("NOWA_KOLUMNA");
    }
  });
});

// ── Field readers ────────────────────────────────────────

describe("reading fields", () => {
  test("a provision splits into tax tags, act and units", () => {
    expect(
      parsePlKisProvision(
        "[VAT][WIS] Ustawa o podatku od towarów i usług-Dział IX-Rozdział 1-art. 86-ust. 2a",
      ),
    ).toMatchObject({
      taxTags: ["VAT", "WIS"],
      act: "Ustawa o podatku od towarów i usług",
      units: ["Dział IX", "Rozdział 1", "art. 86", "ust. 2a"],
    });
  });

  test("every bracket of a doubled tag is dropped", () => {
    expect(
      parsePlKisProvision("[[VAT]][[WIS]] Ustawa o podatku akcyzowym-art. 1"),
    ).toMatchObject({
      taxTags: ["VAT", "WIS"],
      act: "Ustawa o podatku akcyzowym",
      units: ["art. 1"],
    });
  });

  test("the publication day is the Warsaw day, from the detail as from the listing", async () => {
    const row = { ...rowFor(700_050), DATA_PUBLIKACJI: "2026-06-19" };
    const detail = detailFor("700050", "<p>Treść interpretacji.</p>");
    const withInstant =
      isRecord(detail) && isRecord(detail["dokument"])
        ? {
            ...detail,
            dokument: {
              fields: [
                ...(Array.isArray(detail["dokument"]["fields"])
                  ? detail["dokument"]["fields"]
                  : []),
                {
                  dataType: "StringType",
                  key: "DATA_PUBLIKACJI",
                  // 00:30 on 19 June in Warsaw.
                  value: "2026-06-18T22:30:00.000Z",
                },
              ],
            },
          }
        : detail;
    const { DATA_PUBLIKACJI: _listed, ...rowWithoutDay } = row;
    const fromDetail = await assemblePlKisDecision({
      row: rowWithoutDay,
      rawParts: plKisRawPartsOf(rowWithoutDay, JSON.stringify(withInstant)),
    });
    const fromListing = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(row, undefined),
      detailStatus: "detail-gone",
    });
    expect(fromDetail.decision.metadata["publishedAt"]).toBe("2026-06-19");
    expect(fromListing.decision.metadata["publishedAt"]).toBe("2026-06-19");
  });

  test("an instant is the calendar day in Warsaw", () => {
    expect(plKisDay("2026-06-18T22:30:00.000Z")).toBe("2026-06-19");
    expect(plKisDay("2026-06-18")).toBe("2026-06-18");
    expect(plKisDay("not a date")).toBeUndefined();
  });
});

// ── Slices ───────────────────────────────────────────────

describe("the reconciliation slices", () => {
  test("step category by category, then month by month, in sort order", () => {
    const first = plKisSlice("2010-03", "01-ind");
    const walked = [first];
    for (const _category of PL_KIS_INCLUDED_CATEGORIES) {
      const next = plKisNextSlice(walked.at(-1) ?? first);
      if (next === null) {
        break;
      }
      walked.push(next);
    }
    expect(walked.at(-1)).toBe(plKisSlice("2010-04", "01-ind"));
    expect(walked.toSorted()).toEqual(walked);
    for (const slice of walked.slice(1)) {
      const previous = plKisPreviousSlice(slice);
      expect(previous === null ? null : plKisNextSlice(previous)).toBe(slice);
    }
  });

  test("stop at the first month the service lists and at the present", () => {
    // The undated records come before the first month, and nothing before them.
    expect(plKisPreviousSlice(plKisSlice("2004-07", "01-ind"))).toBe(
      PL_KIS_UNDATED_SLICE,
    );
    expect(plKisPreviousSlice(PL_KIS_UNDATED_SLICE)).toBeNull();
    expect(plKisNextSlice(PL_KIS_UNDATED_SLICE)).toBe(
      plKisSlice("2004-07", "01-ind"),
    );
    expect(PL_KIS_UNDATED_SLICE < plKisSlice("2004-07", "01-ind")).toBe(true);
    expect(plKisPreviousSlice(plKisSlice("2004-08", "01-ind"))).toBe(
      plKisSlice("2004-07", "19-spor"),
    );
    expect(
      plKisNextSlice(
        plKisSlice("2026-09", "19-spor"),
        new Date("2026-09-23T10:00:00Z"),
      ),
    ).toBeNull();
    expect(parsePlKisSlice("2026-09/99-none")).toBeNull();
  });

  test("a month's bounds are its first and last day", () => {
    expect(plKisMonthBounds("2024-02")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
  });
});

// ── The crawl ────────────────────────────────────────────

describe("the crawl cursor", () => {
  test("round-trips both phases and refuses what it did not write", () => {
    for (const cursor of [
      { phase: "undated", boundary: "710556", page: 1 },
      { phase: "sweep", boundary: "710556", month: "2012-05", page: 4 },
      { phase: "tip", walk: "head", frontier: "710556" },
      {
        phase: "tip",
        walk: "catch-up",
        frontier: "710556",
        pending: "710600",
        page: 2,
      },
    ] as const) {
      expect(parsePlKisCursor(encodePlKisCursor(cursor))).toEqual(cursor);
    }
    expect(parsePlKisCursor("sweep|x|2012-05|0")).toBeNull();
    expect(parsePlKisCursor("sweep|1|2004-06|0")).toBeNull();
    expect(parsePlKisCursor("tip|catch-up|1|2|0")).toBeNull();
  });
});

describe("the crawl", () => {
  test("a first cycle reads the newest id before it sweeps", async () => {
    const stub = stubPublisher((call) =>
      new URL(call.url).searchParams.get("size") === "1"
        ? json({ results: [rowFor(710_556)], totalHits: 1 })
        : json({ results: [], totalHits: 0 }),
    );
    try {
      const page = await plKisAdapter.fetchPage(null, {});
      expect(new URL(stub.calls[0]?.url ?? "").searchParams.get("sort")).toBe(
        "ID_INFORMACJI,desc",
      );
      expect(cursorOf(page)).toStartWith("sweep|710556|");
    } finally {
      stub.restore();
    }
  });

  test("a month longer than a page is followed to its end, then the next month", async () => {
    const monthRows = Array.from({ length: 25 }, (_, index) =>
      rowFor(600_000 + index),
    );
    const stub = stubPublisher((call) => {
      if (!isSearch(call)) {
        return answerDetail(call) ?? json({}, 404);
      }
      const page = Number(new URL(call.url).searchParams.get("page"));
      return json({
        results: monthRows.slice(page * 10, page * 10 + 10),
        totalHits: monthRows.length,
      });
    });
    try {
      let cursor: string | null = encodePlKisCursor({
        phase: "sweep",
        boundary: "700000",
        month: "2010-03",
        page: 0,
      });
      const seen: string[] = [];
      const cursors: (string | null)[] = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const page = await plKisAdapter.fetchPage(cursor, {});
        if (!Result.isOk(page)) {
          throw page.error;
        }
        seen.push(
          ...page.value.decisions.flatMap(({ sourceDocumentId }) =>
            sourceDocumentId === undefined ? [] : [sourceDocumentId],
          ),
        );
        cursor = page.value.nextCursor;
        cursors.push(cursor);
      }
      expect(cursors).toEqual([
        "sweep|700000|2010-03|1",
        "sweep|700000|2010-03|2",
        "sweep|700000|2010-04|0",
      ]);
      expect(new Set(seen).size).toBe(25);
    } finally {
      stub.restore();
    }
  });

  test("a resumed cursor asks for the page it names, not the start", async () => {
    const stub = stubPublisher(() => json({ results: [], totalHits: 0 }));
    try {
      await plKisAdapter.fetchPage("sweep|700000|2015-06|7", {});
      expect(new URL(stub.calls[0]?.url ?? "").searchParams.get("page")).toBe(
        "7",
      );
    } finally {
      stub.restore();
    }
  });

  test("a first page that lists fewer rows than its count promises is a failure", async () => {
    const stub = stubPublisher(() =>
      json({ results: [rowFor(1), rowFor(2)], totalHits: 25 }),
    );
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      expect(Result.isError(page)).toBe(true);
      // Nothing was built from a page the walk does not trust.
      expect(stub.calls.filter((call) => !isSearch(call))).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("a short page at the tip is a failure, not the frontier", async () => {
    const stub = stubPublisher(() =>
      json({ results: [rowFor(710_600)], totalHits: 40 }),
    );
    try {
      const page = await plKisAdapter.fetchPage("tip|head|710556", {});
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a row stating no id is quarantined, never dropped", async () => {
    const { ID_INFORMACJI: _id, ...withoutId } = rowFor(600_000);
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? json({ results: [withoutId], totalHits: 1 })
        : (answerDetail(call) ?? json({}, 404)),
    );
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      const [decision] = Result.isOk(page) ? page.value.decisions : [];
      expect(decision?.sourceDocumentId).toBe(plKisQuarantineId(withoutId));
      expect(decision?.sourceDocumentId).toStartWith("eureka-quarantine:");
      expect(decision?.isListingOnly).toBe(true);
      expect(decision?.metadata["detailStatus"]).toBe(
        "publisher-id-unavailable",
      );
      // Its verbatim row is what the stored envelope holds.
      expect(
        decodeSourceRawEnvelope(decision?.sourceRaw ?? "")?.["listing"],
      ).toBe(JSON.stringify(withoutId));
      // No address can be built from a row without an id.
      expect(stub.calls.filter((call) => !isSearch(call))).toEqual([]);
    } finally {
      stub.restore();
    }
    expect(plKisListingIdentity(withoutId)).toEqual({
      type: "document",
      sourceDocumentId: plKisQuarantineId(withoutId),
    });
  });

  test("a row whose id recovers adopts its quarantined observation", async () => {
    const row = rowFor(700_010);
    const built = await assemblePlKisDecision({
      row,
      rawParts: plKisRawPartsOf(
        row,
        JSON.stringify(detailFor("700010", "<p>Treść interpretacji.</p>")),
      ),
    });
    const { ID_INFORMACJI: _id, ...withoutId } = row;
    expect(built.decision.sourceDocumentIdRepairAliases).toEqual([
      plKisQuarantineId(withoutId),
    ]);
  });

  test("a detail the service no longer serves keeps the row without a document", async () => {
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? json({ results: [rowFor(600_000)], totalHits: 1 })
        : json({}, 404),
    );
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      expect(cursorOf(page)).toBe("sweep|700000|2010-04|0");
      const [decision] = Result.isOk(page) ? page.value.decisions : [];
      expect(decision?.sourceDocumentId).toBe("600000");
      expect(decision?.isListingOnly).toBe(true);
      expect(decision?.metadata["detailStatus"]).toBe("detail-gone");
      // A gone detail is permanent; the PDF of it is not asked for.
      expect(
        stub.calls.filter((call) => call.url.endsWith("/eksport/PDF")),
      ).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  test("a page the count promises that lists nothing is a failure", async () => {
    const stub = stubPublisher(() => json({ results: [], totalHits: 25 }));
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|1", {});
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a month past the search's window fails instead of truncating", async () => {
    const stub = stubPublisher(() =>
      json({
        results: Array.from({ length: 10 }, (_, index) => rowFor(index + 1)),
        totalHits: 10_000,
      }),
    );
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a detail the service fails to serve holds the cursor", async () => {
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? json({ results: [rowFor(600_000)], totalHits: 1 })
        : json({}, 503),
    );
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("an unreadable HTTP 200 is a failure, not an empty month", async () => {
    const stub = stubPublisher(() => json({ unexpected: true }));
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a document whose detail states no text is read from its PDF", async () => {
    const stub = stubPublisher((call) => {
      if (isSearch(call)) {
        return json({ results: [rowFor(600_000)], totalHits: 1 });
      }
      if (call.url.endsWith("/eksport/PDF")) {
        return new Response("not a pdf");
      }
      return json(detailFor("600000", undefined));
    });
    try {
      const page = await plKisAdapter.fetchPage("sweep|700000|2010-03|0", {});
      expect(stub.calls.map(({ url }) => url)).toContain(
        "https://eureka.mf.gov.pl/api/public/v1/informacje/600000/eksport/PDF",
      );
      const [decision] = Result.isOk(page) ? page.value.decisions : [];
      // The listing proves the document exists (rule 20).
      expect(decision?.sourceDocumentId).toBe("600000");
      expect(decision?.isListingOnly).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a quiet tip cycle costs one request and returns its cursor", async () => {
    const stub = stubPublisher(() =>
      json({ results: [rowFor(710_556), rowFor(710_551)], totalHits: 2 }),
    );
    try {
      const cursor = "tip|head|710556";
      const page = await plKisAdapter.fetchPage(cursor, {});
      expect(stub.calls).toHaveLength(1);
      expect(cursorOf(page)).toBe(cursor);
    } finally {
      stub.restore();
    }
  });

  test("the tip collects what was published past the frontier and moves it", async () => {
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? json({
            results: [rowFor(710_600), rowFor(710_590), rowFor(710_556)],
            totalHits: 3,
          })
        : (answerDetail(call) ?? json({}, 404)),
    );
    try {
      const page = await plKisAdapter.fetchPage("tip|head|710556", {});
      expect(cursorOf(page)).toBe("tip|head|710600");
      const ids = Result.isOk(page)
        ? page.value.decisions.map(({ sourceDocumentId }) => sourceDocumentId)
        : [];
      expect(ids).toEqual(["710600", "710590"]);
    } finally {
      stub.restore();
    }
  });

  test("a tip further behind than a page walks down without moving the frontier", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      rowFor(710_700 - index),
    );
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? json({ results: rows, totalHits: 500 })
        : (answerDetail(call) ?? json({}, 404)),
    );
    try {
      const page = await plKisAdapter.fetchPage("tip|head|710556", {});
      expect(cursorOf(page)).toBe("tip|catch-up|710556|710700|1");
    } finally {
      stub.restore();
    }
  });
});

/**
 * A service holding one record without an issue date among dated ones: the
 * date-sorted listing serves it first, and the dated-only count leaves it out.
 */
const UNDATED_ROW = (() => {
  const { DT_WYD: _issued, ...row } = rowFor(400_001);
  return row;
})();

const answerWithUndated = (call: Call): Response => {
  if (!isSearch(call)) {
    return answerDetail(call) ?? json({}, 404);
  }
  const url = new URL(call.url);
  const filter = bodyOf(call)["filter"];
  const datedOnly = isRecord(filter) && filter["DT_WYD_start"] === "1900-01-01";
  if (url.searchParams.get("size") === "1" && !datedOnly) {
    return json({ results: [rowFor(710_556)], totalHits: 3 });
  }
  if (datedOnly) {
    return json({ results: [rowFor(1)], totalHits: 2 });
  }
  if (url.searchParams.getAll("sort").includes("DT_WYD,asc")) {
    return json({
      results: [UNDATED_ROW, rowFor(500_000), rowFor(500_001)],
      totalHits: 3,
    });
  }
  return json({ results: [], totalHits: 0 });
};

describe("records with no issue date", () => {
  test("a record that predates the crawl is ingested before the months", async () => {
    const stub = stubPublisher(answerWithUndated);
    try {
      const page = await plKisAdapter.fetchPage(null, {});
      const ids = Result.isOk(page)
        ? page.value.decisions.map(({ sourceDocumentId }) => sourceDocumentId)
        : [];
      // Only the undated head: the dated rows behind it are the months'.
      expect(ids).toEqual(["400001"]);
      expect(cursorOf(page)).toBe("sweep|710556|2004-07|0");
    } finally {
      stub.restore();
    }
  });

  test("the ledger lists them as a slice of their own", async () => {
    const stub = stubPublisher(answerWithUndated);
    try {
      const page = await plKisAdapter.reconciliation.listSlicePage({
        slice: PL_KIS_UNDATED_SLICE,
        page: 0,
      });
      expect(page.totalPages).toBe(1);
      expect(page.items.map(({ identity }) => identity)).toEqual([
        { type: "document", sourceDocumentId: "400001" },
      ]);
    } finally {
      stub.restore();
    }
  });

  test("a dated record inside the undated head is a failure", async () => {
    const stub = stubPublisher((call) => {
      const filter = bodyOf(call)["filter"];
      if (isRecord(filter) && filter["DT_WYD_start"] === "1900-01-01") {
        return json({ results: [rowFor(1)], totalHits: 1 });
      }
      return json({ results: [rowFor(500_000), UNDATED_ROW], totalHits: 2 });
    });
    try {
      const listed = await plKisAdapter.reconciliation
        .listSlicePage({ slice: PL_KIS_UNDATED_SLICE, page: 0 })
        .then(
          () => "listed",
          () => "refused",
        );
      expect(listed).toBe("refused");
    } finally {
      stub.restore();
    }
  });
});

describe("the reconciliation listing", () => {
  test("lists one category's issue month and states its pages", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => rowFor(index + 1));
    const stub = stubPublisher(() => json({ results: rows, totalHits: 250 }));
    try {
      const page = await plKisAdapter.reconciliation.listSlicePage({
        slice: plKisSlice("2010-03", "06-wis"),
        page: 0,
      });
      expect(page.totalPages).toBe(3);
      expect(page.items.slice(0, 2).map(({ identity }) => identity)).toEqual([
        { type: "document", sourceDocumentId: "1" },
        { type: "document", sourceDocumentId: "2" },
      ]);
      const filter = bodyOf(stub.calls[0])["filter"];
      expect(
        isRecord(filter) ? filter["KATEGORIA_INFORMACJI"] : undefined,
      ).toEqual([18]);
    } finally {
      stub.restore();
    }
  });
});
