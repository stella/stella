/**
 * pl-ncourt against what the judgments API actually served.
 *
 * Every listing, record and document fixture is a verbatim capture with a
 * provenance sidecar. Where a behaviour needs the API to answer a request
 * no capture holds (a window that answers 404, a page cut short), the stub
 * serves captured rows and fails exactly the requests the case is about.
 */

import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
  PL_COURTS_RULING_DECISION_TYPES,
  PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  assemblePlNcourtDecision,
  encodePlNcourtCursor,
  normalizePlNcourtListingRow,
  parsePlNcourtCursor,
  PL_NCOURT_WINDOW,
  plCommonCourtRulingKeys,
  plNcourtAdapter,
  plNcourtCensus,
  plNcourtComponents,
  plNcourtCourtCount,
  plNcourtDay,
  plNcourtDecisionType,
  plNcourtPositionId,
  readPlNcourtDetail,
  readPlNcourtListing,
  readPlNcourtListingRow,
} from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import type { PlNcourtBuild } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { PL_NCOURT_COURT_NAMES } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt-courts";
import { parsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import {
  readPlNcourtContent,
  validatePlNcourtDocument,
} from "@/api/handlers/case-law/ingestion/parsers/pl-ncourt";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const PAIR = "155020000001003_II_Ca_000236_2018_Uz_2018-03-22_001";
const REASONS = "154010150001006_II_K_000466_2017_Uz_2018-03-22_001";
const GONE = "152520000000503_I_C_000024_2015_Uz_2018-03-22_001";
const LIST_DOC = "151020200002521_V_P_000335_2013_Uz_2015-11-02_001";
const TABLE_DOC = "150515000000503_I_C_000697_2021_Uz_2023-03-27_002";
const THESIS = "151515000001503_III_Ca_001999_2018_Uz_2019-09-11_001";

/** The offset whose one-row window the API answered 404 when captured. */
const POISONED_OFFSET = 165_996;

const fixture = async (name: string): Promise<string> => {
  const bytes = await Bun.file(new URL(name, FIXTURES)).bytes();
  return new TextDecoder().decode(
    name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

const listingOf = async (name: string) =>
  readPlNcourtListing(await fixture(name)) ?? panic(`${name} is not a listing`);

const built = (outcome: PlNcourtBuild): IngestionResult =>
  outcome.type === "built"
    ? outcome.decision
    : panic(`the fixture built ${outcome.type}`);

/** The captured pair: the listed row, the record and the document. */
const pairDecision = async (): Promise<IngestionResult> => {
  const listed = await listingOf("pl-ncourt-listing-signature.xml");
  return built(
    assemblePlNcourtDecision({
      listingXml: listed.fragments[0] ?? panic("the signature lists nothing"),
      detailXml: await fixture(`pl-ncourt-detail-${PAIR}.xml`),
      contentXml: await fixture(`pl-ncourt-content-${PAIR}.xml.gz`),
    }),
  );
};

/** A `<judgement>` row in the listing's own markup. */
const rowXml = (fields: Record<string, string>): string =>
  `<judgement>${Object.entries(fields)
    .map(([name, value]) => `<${name}>${value}</${name}>`)
    .join("")}</judgement>`;

/** What a promise rejected with, or `null` where it resolved. */
const rejectionOf = async (promise: Promise<unknown>): Promise<string | null> =>
  await promise.then(
    () => null,
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );

const xml = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/xml" } });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A record for any id, in the API's own shape, as the stubbed walks need. */
const recordFor = (id: string, row: Record<string, string>): string =>
  `<judgement id="${id}"><signature>${row["signature"] ?? ""}</signature><date>${row["date"] ?? ""}</date><courtId>${row["courtId"] ?? ""}</courtId><type>${row["type"] ?? ""}</type><chairman>A B</chairman><judges><judge>A B</judge></judges></judgement>`;

// ── Listing ──────────────────────────────────────────────

describe("reading a listing", () => {
  test("a page states its total and the rows it holds, each element as printed", async () => {
    const page = await listingOf("pl-ncourt-listing-1000.xml");
    expect(page.total).toBeGreaterThan(400_000);
    expect(page.rows).toHaveLength(10);
    for (const row of page.rows) {
      expect(row.id).toMatch(/^15\d{13}_/u);
      expect(row.courtId).toMatch(/^15\d{6}$/u);
      expect(plNcourtDay(row.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });

  test("the unfiltered count is a listing with no rows", async () => {
    const total = await listingOf("pl-ncourt-total.xml");
    expect(total.rows).toEqual([]);
    expect(total.total).toBeGreaterThan(400_000);
  });

  test("an error, an HTML page or an empty body is not a listing", async () => {
    expect(
      readPlNcourtListing(
        '<?xml version="1.0"?><error>Available sort columns are [date]. </error>',
      ),
    ).toBeNull();
    expect(
      readPlNcourtListing("<html><body>Request unsuccessful.</body></html>"),
    ).toBeNull();
    expect(readPlNcourtListing("")).toBeNull();
    expect(
      readPlNcourtListing(await fixture(`pl-ncourt-detail-${PAIR}.xml`)),
    ).toBeNull();
  });

  test("a page stating more rows than it carries is refused, not read short", () => {
    expect(
      readPlNcourtListing(
        '<judgements total="9" results="2" offset="0" limit="2"><judgement><id>a</id></judgement></judgements>',
      ),
    ).toBeNull();
  });
});

// ── Identity ─────────────────────────────────────────────

describe("identity", () => {
  test("two overlapping pages list the same judgments at the same offsets", async () => {
    const first = await listingOf("pl-ncourt-listing-1000.xml");
    const second = await listingOf("pl-ncourt-listing-1005.xml");
    expect(first.rows.slice(5).map((row) => row.id)).toEqual(
      second.rows.slice(0, 5).map((row) => row.id),
    );
  });

  test("the listing, the record and SAOS's copy name one judgment by one id", async () => {
    const decision = await pairDecision();
    const detail = readPlNcourtDetail(
      await fixture(`pl-ncourt-detail-${PAIR}.xml`),
    );
    expect(detail?.type === "record" ? detail.id : undefined).toBe(PAIR);
    expect(decision.sourceDocumentId).toBe(PAIR);

    const saos: unknown = JSON.parse(
      await fixture("pl-courts-detail-common.json.gz"),
    );
    const record = isRecord(saos) ? saos["data"] : undefined;
    const source = isRecord(record) ? record["source"] : undefined;
    expect(isRecord(source) ? source["judgmentId"] : undefined).toBe(PAIR);
  });

  test("a stored row replays to the same identity and the same decision", async () => {
    const decision = await pairDecision();
    const replayed = plNcourtAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
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
    const result =
      replayed !== undefined && "type" in replayed && replayed.type === "parsed"
        ? replayed.result
        : panic("the stored row did not replay");
    expect(result.sourceDocumentId).toBe(PAIR);
    expect(result.rawHash).toBe(decision.rawHash);
    expect(result.fulltext).toBe(decision.fulltext);
  });
});

// ── The judgment ─────────────────────────────────────────

describe("building a judgment", () => {
  test("the captured pair carries court, signature, date, type, bench and statutes", async () => {
    const decision = await pairDecision();
    expect(decision.court).toBe("Sąd Okręgowy w Świdnicy");
    expect(decision.caseNumber).toBe("II Ca 236/18");
    expect(decision.decisionDate).toBe("2018-03-22");
    expect(decision.decisionType).toBe("postanowienie");
    expect(decision.isListingOnly).toBeUndefined();
    const detail = readPlNcourtDetail(
      await fixture(`pl-ncourt-detail-${PAIR}.xml`),
    );
    const record =
      detail?.type === "record" ? detail : panic("the record did not read");
    expect(
      decision.judges?.find((judge) => judge.role === "presiding")
        ?.nameAsPrinted,
    ).toBe(record.fields.get("chairman"));
    expect(
      decision.judges?.map((judge) => judge.nameAsPrinted).toSorted(),
    ).toEqual((record.lists.get("judges") ?? []).toSorted());
    expect(decision.judges).toHaveLength(3);
    expect(decision.metadata["legalBases"]).toEqual(["art.410§1 kpc"]);
    expect(decision.metadata["keywords"]).toEqual([
      "Skarga o wznowienie postępowania",
    ]);
    expect(decision.metadata["departmentId"]).toBe("1003");
    expect(decision.fulltext).toContain("odrzucić skargę");
    const references = decision.metadata["legalReferences"];
    expect(
      isUnknownArray(references) &&
        references.some(
          (reference) =>
            isRecord(reference) && reference["isapId"] === "WDU19640430296",
        ),
    ).toBe(true);
  });

  test("the stored envelope keeps the listed row, the record and the document verbatim", async () => {
    const decision = await pairDecision();
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts?.["detail"]).toBe(
      await fixture(`pl-ncourt-detail-${PAIR}.xml`),
    );
    expect(parts?.["document"]).toBe(
      await fixture(`pl-ncourt-content-${PAIR}.xml.gz`),
    );
    // The listed row is the publisher's own bytes, cut out of the page.
    const page = await fixture("pl-ncourt-listing-signature.xml");
    expect(parts?.["listing"]).toStartWith("<judgement>");
    expect(page).toContain(parts?.["listing"] ?? "missing");
    expect(parts?.["listing"]).toContain(`<id>${PAIR}</id>`);
  });

  test("written reasons published on their own are a supplement of their ruling", async () => {
    const detailXml = await fixture(`pl-ncourt-detail-${REASONS}.xml`);
    const contentXml = await fixture(`pl-ncourt-content-${REASONS}.xml.gz`);
    const detail = readPlNcourtDetail(detailXml);
    const row =
      detail?.type === "record"
        ? {
            id: REASONS,
            signature: detail.fields.get("signature") ?? "",
            date: detail.fields.get("date") ?? "",
            courtId: detail.fields.get("courtId") ?? "",
            type: detail.fields.get("type") ?? "",
          }
        : panic("the reasons record did not read");
    expect(plNcourtComponents(row.type)).toEqual(["REASON"]);
    const listingXml = rowXml(row);
    const outcome = assemblePlNcourtDecision({
      listingXml,
      detailXml,
      contentXml,
    });
    const supplement =
      outcome.type === "supplement"
        ? outcome.supplement
        : panic(`the reasons built ${outcome.type}`);
    // The same shape SAOS's reasons take, so the pipeline joins either.
    expect(supplement.kind).toBe(DECISION_SUPPLEMENT_KIND.REASONS);
    expect(supplement.target).toEqual({
      decisionTypes: PL_COURTS_RULING_DECISION_TYPES,
      latestDecisionDate: "2018-03-22",
    });
    expect(supplement.document.sourceDocumentId).toBe(REASONS);
    expect(supplement.document.court).toBe(
      PL_NCOURT_COURT_NAMES[row.courtId] ?? panic("court not indexed"),
    );
    expect(supplement.document.decisionType).toBe(
      PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    );
    expect(supplement.document.fulltext?.length ?? 0).toBeGreaterThan(1000);

    // The reconciliation hands it over as a supplement too.
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) =>
      urlOf(input).pathname.endsWith("/judgement/content")
        ? await Promise.resolve(xml(contentXml))
        : await Promise.resolve(xml(detailXml)),
    );
    const reconciled = await plNcourtAdapter.reconciliation.buildDecision({
      listingXml,
    });
    expect(reconciled.type).toBe("built-supplement");

    // A replay of its stored payload is the supplement again.
    const replayed = plNcourtAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(supplement.document.sourceRaw ?? ""),
      contentType: supplement.document.sourceRawContentType ?? null,
      caseNumber: supplement.document.caseNumber,
      sourceDocumentId: REASONS,
      language: supplement.document.language,
      court: supplement.document.court,
      ecli: null,
      decisionDate: supplement.document.decisionDate ?? null,
      decisionType: supplement.document.decisionType ?? null,
      sourceUrl: supplement.document.sourceUrl ?? null,
      documentUrl: supplement.document.documentUrl ?? null,
      metadata: supplement.document.metadata,
    });
    expect(
      replayed !== undefined && "type" in replayed ? replayed.type : undefined,
    ).toBe("supplement");
  });

  test("a crawl page carries listed reasons as supplements, beside its decisions", async () => {
    const detailXml = await fixture(`pl-ncourt-detail-${REASONS}.xml`);
    const contentXml = await fixture(`pl-ncourt-content-${REASONS}.xml.gz`);
    const detail = readPlNcourtDetail(detailXml);
    const fields =
      detail?.type === "record" ? detail.fields : panic("no reasons record");
    const reasonsRow = rowXml({
      id: REASONS,
      signature: fields.get("signature") ?? "",
      date: fields.get("date") ?? "",
      publicationDate: "2026-09-20 18:40:07.0 CEST",
      courtId: fields.get("courtId") ?? "",
      type: fields.get("type") ?? "",
    });
    const pairRow =
      (await listingOf("pl-ncourt-listing-signature.xml")).fragments[0] ??
      panic("no pair row");
    const pairDetail = await fixture(`pl-ncourt-detail-${PAIR}.xml`);
    const pairContent = await fixture(`pl-ncourt-content-${PAIR}.xml.gz`);
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = urlOf(input);
      const reasons = url.searchParams.get("id") === REASONS;
      if (url.pathname.endsWith("/judgement/details")) {
        return await Promise.resolve(xml(reasons ? detailXml : pairDetail));
      }
      if (url.pathname.endsWith("/judgement/content")) {
        return await Promise.resolve(xml(reasons ? contentXml : pairContent));
      }
      return await Promise.resolve(
        xml(
          `<judgements total="2" results="2" offset="0" limit="200">${pairRow}${reasonsRow}</judgements>`,
        ),
      );
    });
    const page = await fetchPage(
      encodePlNcourtCursor({
        lane: "walk",
        since: "2026-09-23",
        offset: 0,
        window: PL_NCOURT_WINDOW,
        anchor: "",
      }),
    );
    expect(page.decisions.map((decision) => decision.sourceDocumentId)).toEqual(
      [PAIR],
    );
    expect(
      page.supplements?.map(
        (supplement) => supplement.document.sourceDocumentId,
      ),
    ).toEqual([REASONS]);
  });

  test("a thesis the record states is the judgment's headnote", async () => {
    const detailXml = await fixture(`pl-ncourt-detail-${THESIS}.xml`);
    const detail = readPlNcourtDetail(detailXml);
    const thesis =
      detail?.type === "record"
        ? (detail.fields.get("thesis") ?? panic("the record states no thesis"))
        : panic("the record did not read");
    expect(thesis.length).toBeGreaterThan(20);
    const decision = built(
      assemblePlNcourtDecision({
        listingXml: rowXml({
          id: THESIS,
          signature: "III Ca 1999/18",
          courtId: "15151500",
        }),
        detailXml,
        contentXml: undefined,
      }),
    );
    expect(decision.textFields.headnote).toEqual({
      type: "present",
      text: thesis,
    });
  });

  test("an id the API answers not-found for keeps its listed row, unpublished, with the reason", async () => {
    const detailXml = await fixture(`pl-ncourt-detail-${GONE}.xml`);
    expect(readPlNcourtDetail(detailXml)?.type).toBe("not-found");
    const listingXml = rowXml({
      id: GONE,
      signature: "I C 24/15",
      date: "2018-03-22 01:00:00.0 CET",
      courtId: "15252000",
      type: "SENTENCE, REASON",
    });
    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(xml(detailXml)),
    );
    const outcome = await plNcourtAdapter.reconciliation.buildDecision({
      listingXml,
    });
    const decision =
      outcome.type === "built" ? outcome.decision : panic(outcome.type);
    expect(decision.sourceDocumentId).toBe(GONE);
    expect(decision.isListingOnly).toBe(true);
    expect(decision.caseNumber).toBe("I C 24/15");
    expect(decision.decisionDate).toBe("2018-03-22");
    expect(decision.metadata["detailStatus"]).toBe("publisher-not-found");
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts?.["listing"]).toBe(listingXml);
    expect(parts?.["detail"]).toBe(detailXml);
    expect(parts?.["document"]).toBeUndefined();
  });

  test("a document the API answers 404 for leaves the record stored without one", async () => {
    const listed = await listingOf("pl-ncourt-listing-signature.xml");
    const detailXml = await fixture(`pl-ncourt-detail-${PAIR}.xml`);
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) =>
      urlOf(input).pathname.endsWith("/judgement/content")
        ? await Promise.resolve(new Response("", { status: 404 }))
        : await Promise.resolve(xml(detailXml)),
    );
    const outcome = await plNcourtAdapter.reconciliation.buildDecision({
      listingXml: listed.fragments[0],
    });
    const decision =
      outcome.type === "built" ? outcome.decision : panic(outcome.type);
    // Not marked here: the write that stores no document decides that.
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.judges).toHaveLength(3);
    expect(decision.fulltext).toBeUndefined();
    expect(decision.metadata["documentStatus"]).toBe("publisher-404");

    // The status is kept in the envelope, so a replay states it too.
    const replayed = plNcourtAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: decision.sourceRawContentType ?? null,
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
    expect(
      replayed !== undefined && "type" in replayed && replayed.type === "parsed"
        ? replayed.result.metadata["documentStatus"]
        : undefined,
    ).toBe("publisher-404");
  });

  test("a server error or a rate-limit refusal fails the page; it is never read as a gone record", async () => {
    const listed = await listingOf("pl-ncourt-listing-signature.xml");
    const originalSleep = Bun.sleep;
    // The gate's fetch backs off between retries of a 5xx; nothing is live.
    Bun.sleep = async () => {
      // no-op
    };
    try {
      for (const status of [503, 429]) {
        const requests: string[] = [];
        globalThis.fetch = asFetchMock(
          async (input: string | URL | Request) => {
            requests.push(urlOf(input).pathname);
            return await Promise.resolve(new Response("", { status }));
          },
        );
        const failure = await rejectionOf(
          plNcourtAdapter.reconciliation.buildDecision({
            listingXml: listed.fragments[0],
          }),
        );
        expect(failure).toContain(`answered ${status}`);
        // A 5xx is retried, a rate-limit refusal is asked once.
        expect(requests.length).toBe(status === 429 ? 1 : 3);
      }
    } finally {
      Bun.sleep = originalSleep;
    }
  });

  test("the court is the one the record names, not the listing's", async () => {
    const detailXml = await fixture(`pl-ncourt-detail-${PAIR}.xml`);
    const decision = built(
      assemblePlNcourtDecision({
        listingXml: rowXml({
          id: PAIR,
          signature: "II Ca 236/18",
          courtId: "15050000",
        }),
        detailXml,
        contentXml: undefined,
      }),
    );
    expect(decision.court).toBe("Sąd Okręgowy w Świdnicy");
    expect(decision.metadata["courtId"]).toBe("15502000");
  });

  test("a court id the index does not name is stored as the record states it", async () => {
    const detailXml = (await fixture(`pl-ncourt-detail-${PAIR}.xml`)).replace(
      "<courtId>15502000</courtId>",
      "<courtId>15999999</courtId>",
    );
    const decision = built(
      assemblePlNcourtDecision({
        listingXml: rowXml({ id: PAIR, signature: "II Ca 236/18" }),
        detailXml,
        contentXml: undefined,
      }),
    );
    expect(decision.court).toBe("15999999");
    expect(decision.metadata["courtKnown"]).toBe(false);
  });
});

// ── Types ────────────────────────────────────────────────

describe("decision types", () => {
  // Each combination as the API lists it, beside the type SAOS stores for the
  // same judgment (recorded against 94 judgments both hold).
  test.each([
    ["SENTENCE, REASON", "wyrok"],
    ["SENTENCE", "wyrok"],
    ["DECISION, REASON", "postanowienie"],
    ["DECISION", "postanowienie"],
    ["REGULATION, REASON", "zarządzenie"],
    ["REGULATION, SENTENCE, REASON", "wyrok"],
    ["REGULATION, SENTENCE", "wyrok"],
    ["REASON", "uzasadnienie"],
  ])("%s is stored as %s", (type, expected) => {
    expect(plNcourtDecisionType(plNcourtComponents(type))).toBe(expected);
  });

  test("a hearing record alone names no ruling", () => {
    expect(plNcourtDecisionType(plNcourtComponents("OTHER"))).toBeUndefined();
    expect(plNcourtDecisionType(plNcourtComponents("RECORD"))).toBeUndefined();
  });
});

// ── SAOS ─────────────────────────────────────────────────

describe("the SAOS copy of a judgment", () => {
  test("keys the same as the judgment built from the API", async () => {
    const dump: unknown = JSON.parse(
      await fixture("pl-courts-dump-day.json.gz"),
    );
    const items = isRecord(dump) ? dump["items"] : undefined;
    const row = isUnknownArray(items)
      ? items.find((item) => isRecord(item) && item["id"] === 332_735)
      : undefined;
    const saosDetail: unknown = JSON.parse(
      await fixture("pl-courts-detail-common.json.gz"),
    );
    const detail = isRecord(saosDetail) ? saosDetail["data"] : undefined;
    const saos =
      isRecord(row) && isRecord(detail)
        ? buildPlDecision({
            listingItem: normalizeSaosDumpItem(row),
            detail: normalizeSaosDumpItem(detail),
            rawParts: { "listing-dump": JSON.stringify(row) },
          })
        : null;
    const official = await pairDecision();

    const saosKeys = plCommonCourtRulingKeys(
      saos ?? panic("the SAOS fixture did not build"),
    );
    expect(saosKeys).toHaveLength(1);
    expect(official.metadata["rulingKeys"]).toEqual(saosKeys);
  });

  test("a key needs the date and the type: a signature alone names no judgment", () => {
    expect(
      plCommonCourtRulingKeys({
        caseNumber: "II Ca 236/18",
        court: "Sąd Okręgowy w Świdnicy",
        decisionDate: undefined,
        decisionType: "postanowienie",
      }),
    ).toEqual([]);
  });
});

// ── Inventory ────────────────────────────────────────────

describe("fields the API adds later", () => {
  test("an element nothing here names is kept on the row, reported, and fails the inventory", async () => {
    const detailXml = (await fixture(`pl-ncourt-detail-${PAIR}.xml`)).replace(
      "</judgement>",
      "<courtOfFirstInstance>Sąd Rejonowy w Świdnicy</courtOfFirstInstance></judgement>",
    );
    const decision = built(
      assemblePlNcourtDecision({
        listingXml: rowXml({
          id: PAIR,
          signature: "II Ca 236/18",
          courtId: "15502000",
          rank: "1",
        }),
        detailXml,
        contentXml: (await fixture(`pl-ncourt-content-${PAIR}.xml.gz`)).replace(
          "<xPart ",
          '<xPart xSealed="true" ',
        ),
      }),
    );
    expect(decision.metadata["unmappedFields"]).toEqual({
      rank: "1",
      courtOfFirstInstance: "Sąd Rejonowy w Świdnicy",
      "xPart@xSealed": "true",
    });

    const { fields, listSourceFields } = plNcourtAdapter.sourceFields;
    const stated = await listSourceFields(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? panic("no envelope"),
    );
    const undeclared = stated.filter((field) => fields[field] === undefined);
    expect(undeclared.toSorted()).toEqual([
      "courtOfFirstInstance",
      "rank",
      "xPart@xSealed",
    ]);
  });

  test("every element the captured responses state is declared", async () => {
    const { fields, listSourceFields } = plNcourtAdapter.sourceFields;
    const decision = await pairDecision();
    const stated = await listSourceFields(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? panic("no envelope"),
    );
    expect(stated.filter((field) => fields[field] === undefined)).toEqual([]);
  });
});

// ── Document ─────────────────────────────────────────────

/**
 * The publisher's HTML is pretty-printed, and its indentation lands inside
 * some marks as spaces; the words and their order are what must agree.
 */
const withoutWhitespace = (text: string): string => text.replace(/\s+/gu, "");

describe("the document", () => {
  test.each([PAIR, LIST_DOC, TABLE_DOC])(
    "%s reads to the blocks and text the API's own HTML rendering reads to",
    async (id) => {
      const content = readPlNcourtContent(
        await fixture(`pl-ncourt-content-${id}.xml.gz`),
      );
      const serverHtml = await fixture(`pl-ncourt-content-${id}.html.gz`);
      const parse = (html: string) =>
        parsePlDecisionContent({
          caseNumber: id,
          ecli: undefined,
          court: "",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: undefined,
          documentUrl: undefined,
          content: html,
          keywords: [],
          statutes: [],
          documentId: id,
        });
      const ours = parse(content?.html ?? "");
      const theirs = parse(serverHtml);
      const shape = (blocks: typeof ours.documentAst.blocks) =>
        blocks.map((block) =>
          "role" in block ? `${block.type}:${String(block.role)}` : block.type,
        );
      expect(content?.unmappedMarkup).toEqual([]);
      expect(withoutWhitespace(ours.fulltext)).toBe(
        withoutWhitespace(theirs.fulltext),
      );
      expect(shape(ours.documentAst.blocks)).toEqual(
        shape(theirs.documentAst.blocks),
      );
    },
  );

  test("a superscript stays apart from the number it follows", () => {
    const content = readPlNcourtContent(
      "<xPart><xBlock><xText>art. 353<xSUPx>1</xSUPx> k.c.</xText></xBlock></xPart>",
    );
    expect(content?.html).toContain("353<sup> 1</sup>");
  });

  test("the root's attributes and every statute link are kept", async () => {
    const content = readPlNcourtContent(
      await fixture(`pl-ncourt-content-${PAIR}.xml.gz`),
    );
    expect(content?.attributes["xVolNmbr"]).toBe("000236");
    expect(content?.legalReferences.length).toBeGreaterThan(0);
    expect(
      content?.legalReferences.every((reference) => reference.isapId !== ""),
    ).toBe(true);
  });

  test("the parsed document is measured against the XML's own text", async () => {
    const content =
      readPlNcourtContent(
        await fixture(`pl-ncourt-content-${LIST_DOC}.xml.gz`),
      ) ?? panic("the document did not read");
    const blocks = parsePlDecisionContent({
      caseNumber: LIST_DOC,
      ecli: undefined,
      court: "",
      decisionDate: undefined,
      decisionType: undefined,
      sourceUrl: undefined,
      documentUrl: undefined,
      content: content.html,
      keywords: [],
      statutes: [],
      documentId: LIST_DOC,
    }).documentAst.blocks;
    const subject = { parser: "pl-ncourt", caseNumber: LIST_DOC };
    const codes = (checked: typeof blocks) =>
      validatePlNcourtDocument(subject, content, checked).issues.map(
        (issue) => issue.code,
      );
    expect(codes(blocks)).not.toContain("CONTENT_LOSS");
    // A rendering that lost half the document is caught by the XML, which
    // the parser's own check against that rendering could not do.
    expect(codes(blocks.slice(0, Math.floor(blocks.length / 2)))).toContain(
      "CONTENT_LOSS",
    );
  });

  test("bold and italic in the XML stay bold and italic in the document", async () => {
    const kinds = new Set<string>();
    const collect = (inlines: readonly { type: string }[]): void => {
      for (const inline of inlines) {
        kinds.add(inline.type);
        if ("children" in inline && Array.isArray(inline.children)) {
          collect(inline.children);
        }
      }
    };
    for (const id of [PAIR, LIST_DOC]) {
      const decision = built(
        assemblePlNcourtDecision({
          listingXml: rowXml({
            id,
            signature: "I C 1/15",
            courtId: "15502000",
          }),
          detailXml: await fixture(`pl-ncourt-detail-${PAIR}.xml`),
          contentXml: await fixture(`pl-ncourt-content-${id}.xml.gz`),
        }),
      );
      const ast = decision.documentAst;
      for (const block of "blocks" in ast ? ast.blocks : []) {
        if ("inlines" in block) {
          collect(block.inlines);
        }
      }
    }
    expect(kinds).toContain("bold");
    expect(kinds).toContain("italic");
  });

  test("anonymized spans stay marked", async () => {
    const decision = await pairDecision();
    const ast = decision.documentAst;
    const anonymized =
      "blocks" in ast
        ? ast.blocks.some(
            (block) =>
              "inlines" in block &&
              block.inlines.some(
                (inline) =>
                  inline.type === "text" && inline.anonymized === true,
              ),
          )
        : false;
    expect(anonymized).toBe(true);
  });
});

// ── Counts ───────────────────────────────────────────────

describe("counting a court", () => {
  test("a court id the API ignores answers the whole corpus, and is refused", async () => {
    const total = (await listingOf("pl-ncourt-total.xml")).total;
    const ignored = await fixture("pl-ncourt-court-15999999.xml");
    // Without the check, this answer counts the whole corpus as one court.
    expect(readPlNcourtListing(ignored)?.total).toBe(total);

    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(xml(ignored)),
    );
    const counted = await plNcourtCourtCount({
      courtId: "15999999",
      unfilteredTotal: total,
    });
    expect(Result.isError(counted)).toBe(true);
  });

  test("a court id the API applies is counted", async () => {
    const total = (await listingOf("pl-ncourt-total.xml")).total;
    const applied = await fixture("pl-ncourt-court-15502000.xml");
    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(xml(applied)),
    );
    const counted = await plNcourtCourtCount({
      courtId: "15502000",
      unfilteredTotal: total,
    });
    expect(Result.isOk(counted) ? counted.value.count : -1).toBe(
      readPlNcourtListing(applied)?.total ?? -2,
    );
    expect(Result.isOk(counted) ? counted.value.count : total).toBeLessThan(
      total,
    );
  });

  test("the census states every known court's count and what they leave of the total", async () => {
    const counted: string[] = [];
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const court = urlOf(input).searchParams.get("court");
      if (court === null) {
        return await Promise.resolve(
          xml('<judgements total="5000" results="0" offset="0" limit="0"/>'),
        );
      }
      counted.push(court);
      return await Promise.resolve(
        xml(
          `<judgements total="3" results="1" offset="0" limit="1"><judgement><id>x</id><courtId>${court}</courtId></judgement></judgements>`,
        ),
      );
    });
    const census = await plNcourtCensus();
    const value = Result.isOk(census) ? census.value : panic("no census");
    expect(value.courts).toHaveLength(counted.length);
    expect(new Set(counted).size).toBe(counted.length);
    expect(value.unattributed).toBe(5000 - 3 * counted.length);
  });

  test("the census refuses a court whose filter did not take, rather than count it", async () => {
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const court = urlOf(input).searchParams.get("court");
      return await Promise.resolve(
        xml(
          court === null
            ? '<judgements total="5000" results="0" offset="0" limit="0"/>'
            : '<judgements total="3" results="1" offset="0" limit="1"><judgement><id>x</id><courtId>15050000</courtId></judgement></judgements>',
        ),
      );
    });
    expect(Result.isError(await plNcourtCensus())).toBe(true);
  });

  test("the corpus total is the unfiltered listing's", async () => {
    const body = await fixture("pl-ncourt-total.xml");
    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(xml(body)),
    );
    expect(
      await plNcourtAdapter.getTotalCount(new AbortController().signal),
    ).toEqual({
      type: "count",
      total: readPlNcourtListing(body)?.total ?? panic("no total"),
    });
  });
});

// ── Crawl ────────────────────────────────────────────────

type WalkStub = {
  /** Listed rows by absolute offset, each its captured `<judgement>`. */
  rows: Map<number, string>;
  poisoned: ReadonlySet<number>;
  total: number;
  requests: string[];
  /** Rows the listing leaves out while still counting them. */
  withheld?: ReadonlySet<number>;
};

const urlOf = (input: string | URL | Request): URL => {
  if (typeof input === "string") {
    return new URL(input);
  }
  return input instanceof URL ? input : new URL(input.url);
};

/** Serve captured rows by offset; a window covering a poisoned one is a 404. */
const installWalkStub = (stub: WalkStub): void => {
  globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
    const url = urlOf(input);
    stub.requests.push(url.toString());
    const id = url.searchParams.get("id") ?? "";
    const fragment = [...stub.rows.values()].find((candidate) =>
      candidate.includes(`<id>${id}</id>`),
    );
    if (url.pathname.endsWith("/judgement/details")) {
      return await Promise.resolve(
        xml(recordFor(id, readPlNcourtListingRow(fragment ?? "") ?? {})),
      );
    }
    if (url.pathname.endsWith("/judgement/content")) {
      return await Promise.resolve(
        xml(`<xPart><xBlock><xText>${id}</xText></xBlock></xPart>`),
      );
    }
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    const window = Array.from({ length: limit }, (_, index) => offset + index);
    if (window.some((at) => stub.poisoned.has(at))) {
      return await Promise.resolve(new Response("", { status: 404 }));
    }
    const listed = window.flatMap((at) => {
      const found = stub.rows.get(at);
      return found === undefined || stub.withheld?.has(at) === true
        ? []
        : [found];
    });
    return await Promise.resolve(
      xml(
        `<judgements total="${stub.total}" results="${listed.length}" offset="${offset}" limit="${limit}">${listed.join("")}</judgements>`,
      ),
    );
  });
};

/** The rows around the poisoned offset, at the offsets they were captured at. */
const rowsAroundPoison = async (): Promise<Map<number, string>> => {
  const before = await listingOf("pl-ncourt-listing-165990.xml");
  const after = await listingOf("pl-ncourt-listing-165997.xml");
  return new Map([
    ...before.fragments.map(
      (fragment, index) => [165_990 + index, fragment] as const,
    ),
    ...after.fragments.map(
      (fragment, index) => [POISONED_OFFSET + 1 + index, fragment] as const,
    ),
  ]);
};

/** The id the unservable row is given once it is served, in the tests. */
const RECOVERED_ID = "150515150001006_II_K_000239_2015_Uz_2015-12-01_001";

/** The same rows with the unservable one served: a copy of its successor. */
const servableRows = async (): Promise<Map<number, string>> => {
  const rows = await rowsAroundPoison();
  const recovered = (rows.get(POISONED_OFFSET + 1) ?? "").replace(
    /<id>[^<]+<\/id>/u,
    () => `<id>${RECOVERED_ID}</id>`,
  );
  return new Map([...rows, [POISONED_OFFSET, recovered]]);
};

const idOf = (fragment: string | undefined): string =>
  normalizePlNcourtListingRow(readPlNcourtListingRow(fragment ?? "") ?? {})
    .id ?? "";

const fetchPage = async (cursor: string | null, signal?: AbortSignal) => {
  const page = await plNcourtAdapter.fetchPage(cursor, {}, signal);
  return Result.isOk(page) ? page.value : panic(page.error.message);
};

/** Walk from a cursor until the lane hands over to the tip. */
const walkToTip = async (start: string) => {
  let cursor: string | null = start;
  const decisions: IngestionResult[] = [];
  const cursors: string[] = [];
  for (let step = 0; step < 80; step += 1) {
    const page = await fetchPage(cursor);
    decisions.push(...page.decisions);
    cursor = page.nextCursor;
    cursors.push(cursor ?? "");
    if (cursor?.startsWith("tip:") === true) {
      break;
    }
  }
  return { decisions, cursors };
};

const SINCE = "2026-09-23";

const WALK_START = encodePlNcourtCursor({
  lane: "walk",
  since: SINCE,
  offset: 165_990,
  window: 12,
  anchor: "",
});

/** The walk's frozen set, as the quarantine scopes it. */
const WALK_QUERY = { sort: "signature-asc", publicationDateTo: SINCE };

describe("the walk", () => {
  test("lists only what was published before the day it began", async () => {
    const rows = await servableRows();
    const stub: WalkStub = {
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    };
    installWalkStub(stub);
    await fetchPage(WALK_START);
    const listing = new URL(
      stub.requests.find((request) => request.includes("/judgements?")) ??
        panic("no listing request"),
    );
    expect(listing.searchParams.get("publicationDateTo")).toBe(SINCE);
    expect(listing.searchParams.get("sort")).toBe("signature-asc");
  });

  test("a row published on or after that day means the bound was not applied", async () => {
    const rows = await servableRows();
    const late = (rows.get(165_990) ?? "").replace(
      /<publicationDate>[^<]+<\/publicationDate>/u,
      "<publicationDate>2026-09-23 18:40:07.0 CEST</publicationDate>",
    );
    installWalkStub({
      rows: new Map([...rows, [165_990, late]]),
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const page = await plNcourtAdapter.fetchPage(WALK_START, {}, undefined);
    expect(Result.isError(page) ? page.error.message : "").toContain(
      "publicationDateTo=2026-09-23",
    );
  });

  test("a page after a withdrawal rewinds instead of skipping what slid back", async () => {
    const rows = await servableRows();
    const offsets = [...rows.keys()].toSorted((left, right) => left - right);
    // Read the first full page, then withdraw a row the walk already passed.
    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const first = await fetchPage(
      encodePlNcourtCursor({
        lane: "walk",
        since: SINCE,
        offset: 165_990,
        window: PL_NCOURT_WINDOW,
        anchor: "",
      }),
    );
    // The window ran to the end, so continue from a mid-window anchor.
    expect(first.decisions.length).toBe(rows.size);
    const resumeAt = 165_995;
    const anchor = idOf(rows.get(resumeAt - 1));
    const shifted = new Map(
      offsets
        .filter((at) => at !== 165_991)
        .map((at, index) => [165_990 + index, rows.get(at) ?? ""] as const),
    );
    installWalkStub({
      rows: shifted,
      poisoned: new Set(),
      total: 166_001,
      requests: [],
    });
    const page = await fetchPage(
      encodePlNcourtCursor({
        lane: "walk",
        since: SINCE,
        offset: resumeAt,
        window: PL_NCOURT_WINDOW,
        anchor,
      }),
    );
    // Without the check, the row now at 165994 (read before as 165995's
    // predecessor slid into place) would be skipped; the lane steps back.
    expect(page.decisions).toEqual([]);
    expect(parsePlNcourtCursor(page.nextCursor)).toMatchObject({
      lane: "walk",
      offset: resumeAt - 200,
      anchor: "",
    });

    // With nothing withdrawn, the anchor is where it should be and the page
    // reads on from the offset, the anchor itself not read twice.
    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const steady = await fetchPage(
      encodePlNcourtCursor({
        lane: "walk",
        since: SINCE,
        offset: resumeAt,
        window: PL_NCOURT_WINDOW,
        anchor,
      }),
    );
    expect(steady.decisions[0]?.sourceDocumentId).toBe(
      idOf(rows.get(resumeAt)),
    );
  });

  test("an unservable row is isolated by halving, then kept as a quarantined audit row", async () => {
    const rows = await rowsAroundPoison();
    installWalkStub({
      rows,
      poisoned: new Set([POISONED_OFFSET]),
      total: 166_002,
      requests: [],
    });
    const { decisions, cursors } = await walkToTip(WALK_START);

    // Every captured row once, in order, and the unservable one in its place.
    const quarantineIndex = POISONED_OFFSET - 165_990;
    const ids = decisions.map((decision) => decision.sourceDocumentId ?? "");
    expect(ids.toSpliced(quarantineIndex, 1)).toEqual(
      [...rows.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([, fragment]) => idOf(fragment)),
    );
    const quarantine =
      decisions[quarantineIndex] ?? panic("no row at the unservable offset");
    const position = {
      query: WALK_QUERY,
      previous: { id: idOf(rows.get(POISONED_OFFSET - 1)), gap: 1 },
      next: { id: idOf(rows.get(POISONED_OFFSET + 1)), gap: 1 },
    };
    expect(quarantine.sourceDocumentId).toBe(plNcourtPositionId(position));
    expect(quarantine.isListingOnly).toBe(true);
    expect(quarantine.caseNumberIsPlaceholder).toBe(true);
    expect(quarantine.metadata["quarantine"]).toMatchObject({
      offset: POISONED_OFFSET,
      status: 404,
      previous: position.previous,
      next: position.next,
    });
    const stored = JSON.parse(
      decodeSourceRawEnvelope(quarantine.sourceRaw ?? "")?.["quarantine"] ??
        "{}",
    );
    expect(stored.previous.xml).toBe(rows.get(POISONED_OFFSET - 1));
    expect(stored.next.xml).toBe(rows.get(POISONED_OFFSET + 1));
    expect(cursors).toContain(
      encodePlNcourtCursor({
        lane: "walk",
        since: SINCE,
        offset: POISONED_OFFSET + 1,
        window: PL_NCOURT_WINDOW,
        anchor: "",
      }),
    );

    // The audit row replays to itself.
    const replayed = plNcourtAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(quarantine.sourceRaw ?? ""),
      contentType: quarantine.sourceRawContentType ?? null,
      caseNumber: quarantine.caseNumber,
      sourceDocumentId: quarantine.sourceDocumentId ?? null,
      language: quarantine.language,
      court: quarantine.court,
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: quarantine.sourceUrl ?? null,
      documentUrl: null,
      metadata: quarantine.metadata,
    });
    expect(
      replayed !== undefined && "type" in replayed && replayed.type === "parsed"
        ? replayed.result.rawHash
        : undefined,
    ).toBe(quarantine.rawHash);
  });

  test("a run of unservable rows gets one audit row each, the same on every walk", async () => {
    const rows = await rowsAroundPoison();
    const run = new Set([165_994, 165_995, 165_996, 165_997]);
    const walk = async () => {
      installWalkStub({
        rows: new Map([...rows].filter(([at]) => !run.has(at))),
        poisoned: run,
        total: 166_002,
        requests: [],
      });
      const { decisions } = await walkToTip(WALK_START);
      return decisions
        .filter((decision) =>
          (decision.sourceDocumentId ?? "").startsWith("ncourt-quarantine:"),
        )
        .map((decision) => decision.sourceDocumentId);
    };
    const first = await walk();
    expect(first).toHaveLength(run.size);
    expect(new Set(first).size).toBe(run.size);
    expect(await walk()).toEqual(first);
  });

  test("once the row is served, it names its audit row as a repair alias", async () => {
    const rows = await rowsAroundPoison();
    installWalkStub({
      rows: await servableRows(),
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const { decisions } = await walkToTip(WALK_START);
    const served = decisions.find(
      (decision) => decision.sourceDocumentId === RECOVERED_ID,
    );
    expect(served?.sourceDocumentIdRepairAliases).toContain(
      plNcourtPositionId({
        query: WALK_QUERY,
        previous: { id: idOf(rows.get(POISONED_OFFSET - 1)), gap: 1 },
        next: { id: idOf(rows.get(POISONED_OFFSET + 1)), gap: 1 },
      }),
    );
  });

  test("a listed row with no usable id is kept under its content, and found again once it has one", async () => {
    const rows = await servableRows();
    const listed = rows.get(165_992) ?? panic("no row");
    const withoutId = listed.replace(/<id>[^<]+<\/id>/u, "");
    const oversized = listed.replace(
      /<id>[^<]+<\/id>/u,
      () => `<id>${"x".repeat(400)}</id>`,
    );
    for (const broken of [withoutId, oversized]) {
      installWalkStub({
        rows: new Map([...rows, [165_992, broken]]),
        poisoned: new Set(),
        total: 166_002,
        requests: [],
      });
      const { decisions } = await walkToTip(WALK_START);
      // Without it, the window advances past the row and nothing holds it.
      expect(decisions).toHaveLength(rows.size);
      const kept =
        decisions[165_992 - 165_990] ?? panic("no row at the broken offset");
      expect(kept.sourceDocumentId).toStartWith("ncourt-listed:");
      expect(kept.isListingOnly).toBe(true);
      expect(kept.metadata["detailStatus"]).toBe("publisher-id-unavailable");
      expect(decodeSourceRawEnvelope(kept.sourceRaw ?? "")?.["listing"]).toBe(
        broken,
      );
      const signature =
        readPlNcourtListingRow(listed)?.["signature"] ??
        panic("the row states no signature");
      expect(kept.caseNumber).toBe(signature);
    }

    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const { decisions } = await walkToTip(WALK_START);
    const recovered = decisions.find(
      (decision) => decision.sourceDocumentId === idOf(listed),
    );
    const quarantined = assemblePlNcourtDecision({
      listingXml: withoutId,
      detailXml: undefined,
      contentXml: undefined,
    });
    expect(recovered?.sourceDocumentIdRepairAliases).toContain(
      quarantined.type === "built"
        ? quarantined.decision.sourceDocumentId
        : panic("not kept"),
    );
  });

  test("a listed row with an id but no court is kept under its id, unpublished", async () => {
    const rows = await servableRows();
    const listed = rows.get(165_992) ?? panic("no row");
    const courtless = listed.replace(/<courtId>[^<]+<\/courtId>/u, "");
    installWalkStub({
      rows: new Map([...rows, [165_992, courtless]]),
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    // The record states no court either.
    const stubbed = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        return url.searchParams.get("id") === idOf(listed) &&
          url.pathname.endsWith("/judgement/details")
          ? await Promise.resolve(
              xml(
                `<judgement id="${idOf(listed)}"><signature>X</signature></judgement>`,
              ),
            )
          : await stubbed(input, init);
      },
    );
    const { decisions } = await walkToTip(WALK_START);
    const kept = decisions.find(
      (decision) => decision.sourceDocumentId === idOf(listed),
    );
    expect(kept?.isListingOnly).toBe(true);
    expect(kept?.metadata["detailStatus"]).toBe("listing-metadata-incomplete");
  });

  test("a window listing fewer rows than its count promises fails the page", async () => {
    const rows = await servableRows();
    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
      withheld: new Set([165_999, 166_000, 166_001]),
    });
    const page = await plNcourtAdapter.fetchPage(
      encodePlNcourtCursor({
        lane: "walk",
        since: SINCE,
        offset: 165_997,
        window: 10,
        anchor: "",
      }),
      {},
    );
    expect(Result.isError(page) ? page.error.message : "").toContain(
      "listed 2 rows at offset 165997 of a count of 166002",
    );
  });

  test("an abort mid-window resumes at the first row not read", async () => {
    const rows = await servableRows();
    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const controller = new AbortController();
    let documents = 0;
    const stubbed = globalThis.fetch;
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await stubbed(input, init);
        if (urlOf(input).pathname.endsWith("/judgement/content")) {
          documents += 1;
          if (documents === 2) {
            controller.abort();
          }
        }
        return response;
      },
    );
    const page = await fetchPage(
      encodePlNcourtCursor({
        lane: "walk",
        since: SINCE,
        offset: 165_990,
        window: 6,
        anchor: "",
      }),
      controller.signal,
    );
    expect(page.decisions).toHaveLength(2);
    expect(parsePlNcourtCursor(page.nextCursor)).toMatchObject({
      lane: "walk",
      offset: 165_992,
      anchor: idOf(rows.get(165_991)),
    });

    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const resumed = await fetchPage(page.nextCursor);
    expect(resumed.decisions[0]?.sourceDocumentId).toBe(
      idOf(rows.get(165_992)),
    );
  });

  test("a cursor round-trips, and one that does not parse restarts the walk rather than skipping", () => {
    const tip = {
      lane: "tip",
      from: "2026-09-19",
      to: "2026-09-23",
      offset: 37,
      window: 50,
      anchor: "151015150000503_I_1@C_001047_2015_Uz_2015-10-16_001",
    } as const;
    expect(parsePlNcourtCursor(encodePlNcourtCursor(tip))).toEqual(tip);
    expect(parsePlNcourtCursor("offset:1927900")).toMatchObject({
      lane: "walk",
      offset: 0,
      window: PL_NCOURT_WINDOW,
    });
    expect(parsePlNcourtCursor("walk:2026-09-23:5:0:")).toMatchObject({
      offset: 0,
    });
  });
});

describe("the tip", () => {
  /** The captured tip rows, their count what the page holds. */
  const tipPage = async (): Promise<string> =>
    (await fixture("pl-ncourt-listing-tip.xml")).replace(
      /total="\d+"/u,
      'total="10"',
    );

  test("a lap lists closed days only, from where the walk stopped to today", async () => {
    const body = await tipPage();
    const requests: URL[] = [];
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      requests.push(urlOf(input));
      return await Promise.resolve(
        urlOf(input).pathname.endsWith("/judgements")
          ? xml(body)
          : new Response("", { status: 503 }),
      );
    });
    await plNcourtAdapter.fetchPage(
      encodePlNcourtCursor({
        lane: "tip",
        from: "2026-09-20",
        to: "2026-09-20",
        offset: 0,
        window: PL_NCOURT_WINDOW,
        anchor: "",
      }),
      {},
    );
    const listing = requests[0] ?? panic("no request");
    expect(listing.searchParams.get("publicationDateFrom")).toBe("2026-09-20");
    expect(listing.searchParams.get("publicationDateTo")).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });

  test("the walk hands over at the day it began, and waits for it to close", async () => {
    const rows = await servableRows();
    installWalkStub({
      rows,
      poisoned: new Set(),
      total: 166_002,
      requests: [],
    });
    const { cursors } = await walkToTip(WALK_START);
    expect(parsePlNcourtCursor(cursors.at(-1) ?? null)).toEqual({
      lane: "tip",
      from: SINCE,
      to: SINCE,
      offset: 0,
      window: PL_NCOURT_WINDOW,
      anchor: "",
    });
  });

  test("the tip refuses rows published outside its days: the filter did not apply", async () => {
    const body = await tipPage();
    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(xml(body)),
    );
    const page = await plNcourtAdapter.fetchPage(
      encodePlNcourtCursor({
        lane: "tip",
        from: "2026-09-22",
        to: "2026-09-22",
        offset: 0,
        window: PL_NCOURT_WINDOW,
        anchor: "",
      }),
      {},
    );
    expect(
      readPlNcourtListing(body)?.rows.some(
        (row) => (plNcourtDay(row.publicationDate) ?? "") < "2026-09-22",
      ),
    ).toBe(true);
    expect(Result.isError(page)).toBe(true);
  });

  test("a quiet cycle on the day the last lap ended makes no request and keeps its cursor", async () => {
    const body = await tipPage();
    const requests: string[] = [];
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      requests.push(urlOf(input).toString());
      return await Promise.resolve(
        urlOf(input).pathname.endsWith("/judgements")
          ? xml(body)
          : xml(recordFor(urlOf(input).searchParams.get("id") ?? "", {})),
      );
    });
    const today = new Date().toISOString().slice(0, 10);
    const parked = encodePlNcourtCursor({
      lane: "tip",
      from: today,
      to: today,
      offset: 0,
      window: PL_NCOURT_WINDOW,
      anchor: "",
    });
    const quiet = await fetchPage(parked);
    expect(requests).toHaveLength(0);
    expect(quiet.decisions).toEqual([]);
    expect(quiet.nextCursor).toBe(parked);
  });
});

describe("a page answered by something other than the API's XML", () => {
  test("fails the page", async () => {
    globalThis.fetch = asFetchMock(
      async () =>
        await Promise.resolve(
          new Response("<html><body>Request unsuccessful.</body></html>", {
            headers: { "Content-Type": "text/html" },
          }),
        ),
    );
    expect(Result.isError(await plNcourtAdapter.fetchPage(null, {}))).toBe(
      true,
    );
  });
});

// ── Reconciliation ───────────────────────────────────────

describe("a judgment date", () => {
  test("lists every row, the one the API cannot serve as its quarantine", async () => {
    const day = await listingOf("pl-ncourt-listing-day.xml");
    const rows = new Map(
      day.fragments.map((fragment, index) => [index, fragment] as const),
    );
    installWalkStub({
      rows,
      poisoned: new Set([3]),
      total: day.fragments.length,
      requests: [],
    });
    const page = await plNcourtAdapter.reconciliation.listSlicePage({
      slice: "2018-03-22",
      page: 0,
    });
    const quarantineId = plNcourtPositionId({
      query: {
        dateFrom: "2018-03-22",
        dateTo: "2018-03-22",
        sort: "signature-asc",
      },
      previous: { id: idOf(rows.get(2)), gap: 1 },
      next: { id: idOf(rows.get(4)), gap: 1 },
    });
    expect(page.items.map((item) => item.identity)).toEqual(
      day.fragments.map((fragment, index) => ({
        type: "document" as const,
        sourceDocumentId: index === 3 ? quarantineId : idOf(fragment),
      })),
    );
    const outcome = await plNcourtAdapter.reconciliation.buildDecision(
      page.items[3]?.payload,
    );
    expect(
      outcome.type === "built" ? outcome.decision.sourceDocumentId : undefined,
    ).toBe(quarantineId);
  });

  test("a page listing fewer rows than its count promises is refused", async () => {
    const day = await listingOf("pl-ncourt-listing-day.xml");
    installWalkStub({
      rows: new Map(
        day.fragments.map((fragment, index) => [index, fragment] as const),
      ),
      poisoned: new Set(),
      total: 12,
      requests: [],
    });
    const failure = await rejectionOf(
      plNcourtAdapter.reconciliation.listSlicePage({
        slice: "2018-03-22",
        page: 0,
      }),
    );
    expect(failure).toContain("listed 10 rows at offset 0 of a count of 12");
  });

  test("a row dated another day means the filter did not apply", async () => {
    // Its count agrees with its rows, so only the dates can give it away.
    const other = (await fixture("pl-ncourt-listing-1000.xml")).replace(
      /total="\d+"/u,
      'total="10"',
    );
    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(xml(other)),
    );
    const failure = await rejectionOf(
      plNcourtAdapter.reconciliation.listSlicePage({
        slice: "2018-03-22",
        page: 0,
      }),
    );
    expect(failure).toContain("dateFrom=2018-03-22");
  });
});
