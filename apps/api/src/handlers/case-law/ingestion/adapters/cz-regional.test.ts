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
import { describe, expect, test } from "bun:test";

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
import type { CzRegionalApiItem } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

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
