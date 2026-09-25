/**
 * What this adapter makes of the payloads rozhodnuti.justice.cz actually
 * serves.
 *
 * Driven from recorded captures rather than from objects written here: the
 * questions are what the publisher states and what the row keeps, and a
 * hand-built payload only ever states what its author already knew to look
 * for. The synthetic fixture in `case-law-enrolled-fixtures.ts` is the
 * complement — it fills every field so the conformance suites can exercise
 * every disposition, which no single real decision does.
 */

import { panic } from "better-result";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assembleCzRegionalDecision,
  czRegionalAdapter,
  czRegionalEnvelopeWithChain,
  czRegionalListingIdentity,
  isCzRegionalApiItem,
  readCzRegionalChain,
  readCzRegionalDocument,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import type {
  CzRegionalApiItem,
  CzRegionalBuildResult,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { parseRegionalDecision } from "@/api/handlers/case-law/ingestion/parsers/cz-regional";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import type { UnpersistableDecisionField } from "@/api/lib/errors/tagged-errors";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const readFixture = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

/** The listing rows of a recorded day page. */
const listingItems = async (name: string): Promise<CzRegionalApiItem[]> => {
  const page = JSON.parse(await readFixture(name));
  const items = isRecord(page) ? page["items"] : undefined;
  return isUnknownArray(items)
    ? items.filter(isCzRegionalApiItem)
    : panic(`${name} holds no listing items`);
};

const itemByDocket = async (
  name: string,
  docket: string,
): Promise<CzRegionalApiItem> =>
  (await listingItems(name)).find(
    (candidate) => candidate.jednaciCislo === docket,
  ) ?? panic(`${name} lists no ${docket}`);

const LISTING = "cz-regional-listing.json.gz";
const MINISTRY_LISTING = "cz-regional-ministry-listing.json.gz";
const DISTRICT_DOCUMENT = "cz-regional-finaldoc-district.json.gz";
const APPELLATE_DOCUMENT = "cz-regional-finaldoc-appellate.json.gz";
const CHAIN = "cz-regional-chain.json.gz";

const DISTRICT_DOCKET = "18 C 130/2024-27";
const APPELLATE_DOCKET = "26 Co 43/2025-49";
/** The ministry's own administrative record, listed in the court feed. */
const MINISTRY_DOCKET = "0 OINS 9/2018";

/**
 * A recorded document with one metadata key replaced, for the two cases the
 * captures do not contain: this publisher's criminal order, and the ministry
 * record's court code on a payload the day page links.
 */
const documentWithMetadata = async (
  name: string,
  overrides: Record<string, unknown>,
): Promise<string> => {
  const payload = JSON.parse(await readFixture(name));
  const metadata = isRecord(payload) ? payload["metadata"] : undefined;
  return JSON.stringify({
    ...(isRecord(payload) ? payload : {}),
    metadata: { ...(isRecord(metadata) ? metadata : {}), ...overrides },
  });
};

type BuiltFrom = {
  listing: string;
  docket: string;
  document?: string | undefined;
  chain?: string | undefined;
};

/** The decision the adapter builds from recorded payloads, without I/O. */
const build = async ({
  listing,
  docket,
  document,
  chain,
}: BuiltFrom): Promise<IngestionResult> => {
  const built = assembleCzRegionalDecision({
    item: await itemByDocket(listing, docket),
    document:
      document === undefined
        ? null
        : readCzRegionalDocument(await readFixture(document)),
    chain:
      chain === undefined
        ? null
        : readCzRegionalChain(await readFixture(chain)),
  });
  return built.type === "built"
    ? built.decision
    : panic(`${docket} did not build: ${built.type}`);
};

describe("the stored payload is an envelope of every response read", () => {
  test("a crawled row keeps the listing row beside the document", async () => {
    const decision = await build({
      listing: LISTING,
      docket: APPELLATE_DOCKET,
      document: APPELLATE_DOCUMENT,
    });

    expect(decision.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(Object.keys(parts ?? {}).toSorted()).toEqual([
      "document",
      "listing",
    ]);
    // The listing row is the only surface stating these in words, so the part
    // has to carry them verbatim rather than only in the fields read off it.
    expect(JSON.parse(parts?.["listing"] ?? "null")).toMatchObject({
      autor: "JUDr. Dana Mazáková",
      klicovaSlova: ["společné jmění manželů"],
      zminenaUstanoveni: ["§ 741 z. č. 89/2012 Sb."],
    });
  });

  test("a row without its document keeps the listing row alone", async () => {
    const decision = await build({
      listing: LISTING,
      docket: APPELLATE_DOCKET,
    });

    expect(
      Object.keys(decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? {}),
    ).toEqual(["listing"]);
    expect(decision.isListingOnly).toBe(true);
  });

  test("the chain pass adds its part to what is already stored", async () => {
    const crawled = await build({
      listing: LISTING,
      docket: DISTRICT_DOCKET,
      document: DISTRICT_DOCUMENT,
    });
    const parts = decodeSourceRawEnvelope(crawled.sourceRaw ?? "") ?? {};

    const reparsed = await czRegionalAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(
        czRegionalEnvelopeWithChain(parts, await readFixture(CHAIN)),
      ),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: crawled.caseNumber,
      sourceDocumentId: crawled.sourceDocumentId ?? null,
      language: crawled.language,
      court: crawled.court,
      ecli: crawled.ecli ?? null,
      decisionDate: crawled.decisionDate ?? null,
      decisionType: crawled.decisionType ?? null,
      sourceUrl: crawled.sourceUrl ?? null,
      documentUrl: crawled.documentUrl ?? null,
      metadata: crawled.metadata,
    });

    expect(reparsed?.type).toBe("parsed");
    const decision = reparsed?.type === "parsed" ? reparsed.result : crawled;
    expect(
      Object.keys(
        decodeSourceRawEnvelope(decision.sourceRaw ?? "") ?? {},
      ).toSorted(),
    ).toEqual(["chain", "document", "listing"]);
    // The affecting document's own id is the one thing the forward edge in
    // the other decision's payload never states.
    expect(decision.metadata["affectingDocs"]).toEqual([
      {
        uuid: "e53d0e6b-949a-44b1-8224-5a3d63a27571",
        caseNumber: {
          senate: 26,
          registry: "Co",
          index: 43,
          year: 2025,
          pageNumber: 49,
        },
        courtCode: "KSHK",
        affectedDate: "2025-03-11",
        affectedTypes: ["CONFIRM"],
      },
    ]);
  });

  test("a payload stored before the envelope is reported, not guessed at", async () => {
    // What every row written by the previous adapter holds: the document
    // payload alone, under the publisher's own media type. The listing row
    // that keyed it was never kept, so it cannot be rebuilt.
    const rejected = await czRegionalAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(await readFixture(DISTRICT_DOCUMENT)),
      contentType: "application/json",
      caseNumber: "18 C 130/2024",
      sourceDocumentId: "e21716f9-8855-4a85-a7e6-9af23622661b",
      language: "cs",
      court: "Okresní soud v Hradci Králové",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });

    expect(rejected).toMatchObject({
      type: "rejected",
      rejection: "unsupported-content",
    });
  });
});

describe("what the publisher states reaches the row", () => {
  test("the document's structured metadata is stored beside the listing's", async () => {
    const decision = await build({
      listing: LISTING,
      docket: APPELLATE_DOCKET,
      document: APPELLATE_DOCUMENT,
    });

    expect(decision.caseNumber).toBe("26 Co 43/2025");
    expect(decision.sheetNumber).toBe("49");
    expect(decision.ecli).toBe("ECLI:CZ:KSHK:2025:26.Co.43.2025.1");
    expect(decision.decisionDate).toBe("2025-03-11");
    expect(decision.sourceDocumentId).toBe(
      "e53d0e6b-949a-44b1-8224-5a3d63a27571",
    );
    expect(decision.metadata).toMatchObject({
      courtCode: "KSHK",
      caseNumberParts: {
        senate: 26,
        registry: "Co",
        index: 43,
        year: 2025,
        pageNumber: 49,
      },
      caseResultType: ["POTVRZENI"],
      publishedDate: "2025-06-11",
      decisionTypeRaw: "JUDGEMENT",
    });
  });

  test("the judge the document names is the row's rapporteur", async () => {
    const decision = await build({
      listing: LISTING,
      docket: APPELLATE_DOCKET,
      document: APPELLATE_DOCUMENT,
    });

    expect(decision.judges).toEqual([
      { role: "rapporteur", nameAsPrinted: "Dana Mazáková" },
    ]);
    // How that one judge sat is the court's own word for it and stays on the
    // verbatim blob rather than becoming a role of its own.
    expect(decision.metadata["solver"]).toMatchObject({
      function: "předsedkyně senátu",
    });
  });

  test("the listing's judge stands in where no document was read", async () => {
    const decision = await build({
      listing: LISTING,
      docket: DISTRICT_DOCKET,
    });

    expect(decision.judges).toEqual([
      { role: "rapporteur", nameAsPrinted: "Eva Tabetová" },
    ]);
  });

  test("the publisher's own relation graph becomes cited cases", async () => {
    const decision = await build({
      listing: LISTING,
      docket: APPELLATE_DOCKET,
      document: APPELLATE_DOCUMENT,
    });

    expect(decision.publisherCitedCases).toEqual(["18 C 130/2024"]);
    // The relation kind has nowhere to go on a list of case numbers, so the
    // typed edge is kept beside it.
    expect(decision.metadata["affectedDocs"]).toMatchObject([
      { courtCode: "OSHK", affectedTypes: ["CONFIRM"] },
    ]);
  });

  test("the document's anonymization spans survive into the AST", async () => {
    const decision = await build({
      listing: LISTING,
      docket: DISTRICT_DOCKET,
      document: DISTRICT_DOCUMENT,
    });

    const flattened = JSON.stringify(decision.documentAst);
    expect(flattened).toContain('"anonymized":true');
  });
});

describe("a document the parser cannot read", () => {
  // A text run carrying markup nested deeper than the validator's recursive
  // text walk reaches: the structured parse fails while the publisher's own
  // plain-text rendering is still there.
  const NESTING = 20_000;
  const unreadableText = `${"<span>".repeat(NESTING)}Soud rozhodl${"</span>".repeat(NESTING)}`;

  test("keeps the publisher's plain text and reports the parse", async () => {
    const verdict = [
      {
        texts: [{ text: unreadableText, anonStyle: "NONE" }],
        styleLocalId: 1,
        tableCellInfo: null,
      },
    ];
    expect(() =>
      parseRegionalDecision({
        caseNumber: "18 C 130/2024",
        ecli: undefined,
        court: "Okresní soud",
        decisionDate: undefined,
        decisionType: "rozsudek",
        sourceUrl: undefined,
        header: [],
        verdict,
        justification: [],
        information: [],
        styles: [],
        verdictText: "Soud rozhodl",
        justificationText: "",
      }),
    ).toThrow(RangeError);

    const payload: unknown = JSON.parse(await readFixture(DISTRICT_DOCUMENT));
    const document = readCzRegionalDocument(
      JSON.stringify({ ...(isRecord(payload) ? payload : {}), verdict }),
    );
    expect(document.parsed).not.toBeNull();
    const verdictText = document.parsed?.verdictText ?? "";
    expect(verdictText.length).toBeGreaterThan(0);

    const logs = installRecordingLogger();
    const analytics = installRecordingAnalytics();
    try {
      const built = assembleCzRegionalDecision({
        item: await itemByDocket(LISTING, DISTRICT_DOCKET),
        document,
        chain: null,
      });

      expect(built.type).toBe("built");
      expect(built.type === "built" ? built.decision.fulltext : "").toContain(
        verdictText.trim(),
      );
      expect(
        logs
          .at("ERROR")
          .filter(
            (record) =>
              record.message === "case_law.ingestion.document_parse_failed",
          )
          .map((record) => record.attributes),
      ).toEqual([
        expect.objectContaining({
          adapterKey: "cz-regional",
          documentId: "18 C 130/2024",
          "error.type": "RangeError",
        }),
      ]);
      expect(analytics.exceptions()).toHaveLength(1);
    } finally {
      analytics.restore();
      logs.restore();
    }
  });
});

describe("records no court decided are refused at the boundary", () => {
  test("the listing row is neither keyed nor built", async () => {
    const item = await itemByDocket(MINISTRY_LISTING, MINISTRY_DOCKET);

    // The publisher states the court as "not entered" and the identifier as
    // its own ministry reference, which is not an ECLI.
    expect(item.soud).toBe("(nezadán)");
    expect(item.ecli).not.toMatch(/^ECLI:/u);

    expect(czRegionalListingIdentity(item)).toEqual({
      type: "unidentifiable",
    });
    expect(
      assembleCzRegionalDecision({ item, document: null, chain: null }).type,
    ).toBe("unkeyable");
  });

  test("a document stating no court code is refused too", async () => {
    const built = assembleCzRegionalDecision({
      item: await itemByDocket(LISTING, APPELLATE_DOCKET),
      document: readCzRegionalDocument(
        await documentWithMetadata(APPELLATE_DOCUMENT, { courtCode: "NONE" }),
      ),
      chain: null,
    });

    expect(built.type).toBe("unkeyable");
  });
});

describe("the decision type is the publisher's enum in the local language", () => {
  test("the criminal order the API answers to is mapped", async () => {
    const built = assembleCzRegionalDecision({
      item: await itemByDocket(LISTING, APPELLATE_DOCKET),
      document: readCzRegionalDocument(
        await documentWithMetadata(APPELLATE_DOCUMENT, { type: "ORDER_T" }),
      ),
      chain: null,
    });

    expect(built.type === "built" && built.decision.decisionType).toBe(
      "trestní příkaz",
    );
    // The synthesized heading is keyed on the same local word, so a type the
    // map missed would leave the document without its own title.
    expect(
      JSON.stringify(
        built.type === "built" ? built.decision.documentAst : null,
      ),
    ).toContain("TRESTNÍ PŘÍKAZ");
  });
});

/**
 * The document payload's metadata is validated only as a record, and the
 * publisher sends `null` for a key it leaves empty. The three keys a row is
 * built from are read at the boundary: `null` is no value, and any other shape
 * is refused as the field it is rather than left to a bare `TypeError`.
 */
describe("document metadata the publisher sends null or reshaped", () => {
  const assembleWith = async (
    overrides: Record<string, unknown>,
  ): Promise<CzRegionalBuildResult> =>
    assembleCzRegionalDecision({
      item: await itemByDocket(LISTING, APPELLATE_DOCKET),
      document: readCzRegionalDocument(
        await documentWithMetadata(APPELLATE_DOCUMENT, overrides),
      ),
      chain: null,
    });

  const builtWith = async (
    overrides: Record<string, unknown>,
  ): Promise<IngestionResult> => {
    const built = await assembleWith(overrides);
    return built.type === "built"
      ? built.decision
      : panic(`did not build: ${built.type}`);
  };

  const expectRefusedAs = async (
    overrides: Record<string, unknown>,
    field: UnpersistableDecisionField,
  ): Promise<void> => {
    const thrown = await assembleWith(overrides).then(
      () => panic("expected the build to be refused"),
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(UnpersistableDecisionFieldError);
    expect(errorTag(thrown)).toBe("UnpersistableDecisionFieldError");
    expect(
      thrown instanceof UnpersistableDecisionFieldError
        ? thrown.field
        : undefined,
    ).toBe(field);
  };

  test.each([
    ["first", { firstName: null, lastName: "Mazáková" }, "Mazáková"],
    ["last", { firstName: "Dana", lastName: null }, "Dana"],
  ])(
    "a solver with a null %s name keeps the part it states",
    async (_part, solver, printed) => {
      const decision = await builtWith({ solver });

      expect(decision.judges).toEqual([
        { role: "rapporteur", nameAsPrinted: printed },
      ]);
    },
  );

  test("a solver with no name part names no judge", async () => {
    const decision = await builtWith({
      solver: { firstName: null, lastName: null },
    });

    expect(decision.judges).toBeUndefined();
  });

  test.each([
    ["a number", 7],
    ["a list", ["Dana", "Mazáková"]],
    ["a record with a non-string name", { firstName: 7, lastName: "M" }],
  ])(
    "a solver sent as %s is refused as a judge name",
    async (_shape, solver) => {
      await expectRefusedAs(
        { solver },
        UNPERSISTABLE_DECISION_FIELDS.JUDGE_NAME,
      );
    },
  );

  test("null affectedDocs states no cited cases", async () => {
    const decision = await builtWith({ affectedDocs: null });

    expect(decision.publisherCitedCases).toBeUndefined();
  });

  test.each([
    ["an object", { caseNumber: { senate: 18 } }],
    ["a list holding null", [null]],
    ["a list holding a string", ["18 C 130/2024"]],
  ])(
    "affectedDocs sent as %s is refused as publisher citations",
    async (_shape, affectedDocs) => {
      await expectRefusedAs(
        { affectedDocs },
        UNPERSISTABLE_DECISION_FIELDS.PUBLISHER_CITATIONS,
      );
    },
  );

  test("a relation with a null case number cites nothing", async () => {
    const decision = await builtWith({
      affectedDocs: [{ caseNumber: null, courtCode: "OSHK" }],
    });

    expect(decision.publisherCitedCases).toBeUndefined();
  });

  test.each([
    ["a partial docket", { senate: 18 }],
    ["a string", "18 C 130/2024"],
  ])(
    "a relation case number sent as %s is refused as publisher citations",
    async (_shape, caseNumber) => {
      await expectRefusedAs(
        { affectedDocs: [{ caseNumber, courtCode: "OSHK" }] },
        UNPERSISTABLE_DECISION_FIELDS.PUBLISHER_CITATIONS,
      );
    },
  );

  test("a null court code is a court's document", async () => {
    const built = await assembleWith({ courtCode: null });

    expect(built.type).toBe("built");
  });

  test.each([
    ["a number", 7],
    ["an object", { code: "NONE" }],
  ])(
    "a court code sent as %s is refused as a court code",
    async (_shape, courtCode) => {
      await expectRefusedAs(
        { courtCode },
        UNPERSISTABLE_DECISION_FIELDS.COURT_CODE,
      );
    },
  );
});

describe("the crawl keeps a refused row as its listing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  /** Crawl one day page whose district document carries `districtMetadata`. */
  const crawlDay = async ({
    cursor,
    withAppellate,
    districtMetadata,
  }: {
    cursor: string;
    withAppellate: boolean;
    districtMetadata: Record<string, unknown>;
  }): Promise<Awaited<ReturnType<typeof czRegionalAdapter.fetchPage>>> => {
    const district = await itemByDocket(LISTING, DISTRICT_DOCKET);
    const appellate = await itemByDocket(LISTING, APPELLATE_DOCKET);
    const bodies = new Map([
      [
        district.odkaz ?? panic("the district row links no document"),
        await documentWithMetadata(DISTRICT_DOCUMENT, districtMetadata),
      ],
      [
        appellate.odkaz ?? panic("the appellate row links no document"),
        await readFixture(APPELLATE_DOCUMENT),
      ],
    ]);
    const listing = JSON.stringify({
      items: withAppellate ? [district, appellate] : [district],
      totalPages: 1,
      pageNumber: 0,
    });
    globalThis.fetch = asFetchMock(
      async (input: string) =>
        await Promise.resolve(
          new Response(bodies.get(input) ?? listing, {
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    return await czRegionalAdapter.fetchPage(cursor, {});
  };

  test("a refused row is stored listing-only beside the rest of the page", async () => {
    const page = await crawlDay({
      cursor: "2025-06-11:0",
      withAppellate: true,
      districtMetadata: { courtCode: 7 },
    });

    const decisions = page.unwrap().decisions;
    expect(
      decisions.map(({ caseNumber, isListingOnly }) => ({
        caseNumber,
        isListingOnly,
      })),
    ).toEqual([
      { caseNumber: "18 C 130/2024", isListingOnly: true },
      { caseNumber: "26 Co 43/2025", isListingOnly: undefined },
    ]);
    // The raw listing row is what a later replay or reconciliation rebuilds it
    // from, so the listing-only row carries it and nothing else.
    expect(
      Object.keys(decodeSourceRawEnvelope(decisions[0]?.sourceRaw ?? "") ?? {}),
    ).toEqual(["listing"]);
  });

  test("holds a row whose document read fails and reports the read", async () => {
    const district = await itemByDocket(LISTING, DISTRICT_DOCKET);
    const appellate = await itemByDocket(LISTING, APPELLATE_DOCKET);
    const listing = JSON.stringify({
      items: [district, appellate],
      totalPages: 1,
      pageNumber: 0,
    });
    globalThis.fetch = asFetchMock(async (input: string) => {
      // The district document never answers; the appellate one answers with
      // a body that is not JSON.
      if (input === district.odkaz) {
        throw new TypeError("fetch failed");
      }
      return await Promise.resolve(
        new Response(
          input === appellate.odkaz ? "<html>maintenance</html>" : listing,
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    const logs = installRecordingLogger();
    try {
      const page = await czRegionalAdapter.fetchPage("2025-06-11:0", {});

      expect(
        page.unwrap().decisions.map(({ caseNumber, isListingOnly }) => ({
          caseNumber,
          isListingOnly,
        })),
      ).toEqual([
        { caseNumber: "18 C 130/2024", isListingOnly: true },
        { caseNumber: "26 Co 43/2025", isListingOnly: true },
      ]);
      expect(
        logs
          .at("WARN")
          .filter(
            (record) =>
              record.message === "case_law.ingestion.detail_fetch_failed",
          )
          .map((record) => ({
            caseNumber: record.attributes?.["documentId"],
            errorType: record.attributes?.["error.type"],
            grade: record.attributes?.["failure.grade"],
          }))
          .toSorted((left, right) =>
            String(left.caseNumber) < String(right.caseNumber) ? -1 : 1,
          ),
      ).toEqual([
        {
          caseNumber: "18 C 130/2024",
          errorType: "TypeError",
          grade: "transient",
        },
        {
          caseNumber: "26 Co 43/2025",
          errorType: "SyntaxError",
          grade: "transient",
        },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("a caller's abort during a document read ends the page as a cancellation", async () => {
    const district = await itemByDocket(LISTING, DISTRICT_DOCKET);
    const listing = JSON.stringify({
      items: [district],
      totalPages: 1,
      pageNumber: 0,
    });
    const controller = new AbortController();
    globalThis.fetch = asFetchMock(async (input: string) => {
      if (input === district.odkaz) {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      }
      return await Promise.resolve(
        new Response(listing, {
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const outcome = await czRegionalAdapter
      .fetchPage("2025-06-11:0", {}, controller.signal)
      .then(
        (result) =>
          result.isErr() && result.error.cause instanceof DOMException
            ? result.error.cause.name
            : "completed",
        () => "rejected",
      );

    // The page reports the caller's cancellation, as a cancelled listing
    // request does, and stores no row.
    expect(outcome).toBe("AbortError");
  });

  test("a page whose read budget passes mid-batch keeps what it read and advances, page after page", async () => {
    const district = await itemByDocket(LISTING, DISTRICT_DOCKET);
    const appellate = await itemByDocket(LISTING, APPELLATE_DOCKET);
    const others = (await listingItems(LISTING)).filter(
      ({ jednaciCislo }) =>
        jednaciCislo !== DISTRICT_DOCKET && jednaciCislo !== APPELLATE_DOCKET,
    );
    // The two rows whose documents the publisher serves open the page, so
    // the first batch reads them.
    const items = [district, appellate, ...others];
    expect(items.length).toBeGreaterThan(2 * 15);
    const listing = JSON.stringify({ items, totalPages: 2, pageNumber: 0 });
    const documents = new Map([
      [district.odkaz, await readFixture(DISTRICT_DOCUMENT)],
      [appellate.odkaz, await readFixture(APPELLATE_DOCUMENT)],
    ]);

    // The pipeline's page signal: started before the page, firing after the
    // page's own budget would.
    const pageSignal = AbortSignal.timeout(100_000);
    // The page's own budget, passed by the test where its timer would pass.
    let budget = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
      (milliseconds) => {
        if (milliseconds <= 60_000) {
          return originalTimeout(milliseconds);
        }
        budget = new AbortController();
        return budget.signal;
      },
    );

    let listingRequests = 0;
    let documentRequests = 0;
    let budgetPassesAt = 0;
    globalThis.fetch = asFetchMock(async (input: string) => {
      if (input.includes("/api/finaldoc/")) {
        documentRequests += 1;
        if (documentRequests === budgetPassesAt) {
          const reason = new DOMException("page budget", "TimeoutError");
          budget.abort(reason);
          throw reason;
        }
        const body = documents.get(input);
        return await Promise.resolve(
          body === undefined
            ? new Response("gone", { status: 404 })
            : new Response(body, {
                headers: { "Content-Type": "application/json" },
              }),
        );
      }
      listingRequests += 1;
      // The first listing request fails and is retried, spending listing time.
      return await Promise.resolve(
        listingRequests === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(listing, {
              headers: { "Content-Type": "application/json" },
            }),
      );
    });
    try {
      // The budget passes on the fifth read of the second batch.
      budgetPassesAt = 15 + 5;
      const first = (
        await czRegionalAdapter.fetchPage("2025-06-11:0", {}, pageSignal)
      ).unwrap();
      const firstRequests = documentRequests;

      expect(listingRequests).toBe(2);
      // No batch starts after the one the budget interrupted.
      expect(firstRequests).toBe(2 * 15);
      expect(first.nextCursor).toBe("2025-06-11:1");
      const [readDistrict, readAppellate, ...rest] = first.decisions;
      expect([
        readDistrict?.isListingOnly,
        readAppellate?.isListingOnly,
      ]).toEqual([undefined, undefined]);
      expect(rest.length).toBeGreaterThan(2 * 15);
      expect(rest.every(({ isListingOnly }) => isListingOnly === true)).toBe(
        true,
      );

      // The next page's budget passes on its very first read.
      budgetPassesAt = firstRequests + 1;
      const second = (
        await czRegionalAdapter.fetchPage(first.nextCursor, {}, pageSignal)
      ).unwrap();

      expect(documentRequests - firstRequests).toBeLessThanOrEqual(15);
      expect(second.nextCursor).toBe("2025-06-12:0");
      expect(second.decisions).toHaveLength(first.decisions.length);
      expect(
        second.decisions
          .slice(15)
          .every(({ isListingOnly }) => isListingOnly === true),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 60_000);

  test("a page whose read budget passes before its listing arrives holds the cursor", async () => {
    const district = await itemByDocket(LISTING, DISTRICT_DOCKET);
    const listing = JSON.stringify({
      items: [district],
      totalPages: 1,
      pageNumber: 0,
    });
    const pageSignal = AbortSignal.timeout(100_000);
    let budget = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
      (milliseconds) => {
        if (milliseconds <= 60_000) {
          return originalTimeout(milliseconds);
        }
        budget = new AbortController();
        return budget.signal;
      },
    );
    let listingRequests = 0;
    globalThis.fetch = asFetchMock(async (input: string) => {
      if (input.includes("/api/finaldoc/")) {
        return await Promise.resolve(new Response("gone", { status: 404 }));
      }
      listingRequests += 1;
      if (listingRequests === 1) {
        const reason = new DOMException("page budget", "TimeoutError");
        budget.abort(reason);
        throw reason;
      }
      return await Promise.resolve(
        new Response(listing, {
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    try {
      const page = await czRegionalAdapter.fetchPage(
        "2025-06-11:0",
        {},
        pageSignal,
      );

      // Nothing was listed, so there is nothing to move past.
      expect(page.isErr()).toBe(true);
      expect(listingRequests).toBe(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 30_000);

  test("a day of refused rows is not an empty day to gap-skip past", async () => {
    // Thirty empty days in a row would make an empty day skip a week ahead.
    const page = await crawlDay({
      cursor: "2025-06-11:0:30",
      withAppellate: false,
      districtMetadata: { courtCode: 7 },
    });

    expect(page.unwrap().nextCursor).toBe("2025-06-12:0");
  });

  test("an assembly failure other than a refusal halts the page", async () => {
    // The first serialization of the district listing row fails as a defect
    // would; a listing-only fallback would serialize it again and succeed.
    const stringify = JSON.stringify.bind(JSON);
    let failed = false;
    spyOn(JSON, "stringify").mockImplementation(
      (value: unknown, replacer?: undefined, space?: string | number) => {
        if (
          !failed &&
          isRecord(value) &&
          value["jednaciCislo"] === DISTRICT_DOCKET
        ) {
          failed = true;
          throw new Error("assembly defect");
        }
        return stringify(value, replacer, space);
      },
    );

    const page = await crawlDay({
      cursor: "2025-06-11:0",
      withAppellate: true,
      districtMetadata: {},
    });

    expect(failed).toBe(true);
    expect(page.isErr()).toBe(true);
  });
});
