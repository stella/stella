/**
 * What the row keeps from the Cellar branch notice, and the two query shapes
 * that reach it.
 *
 * Driven from the committed captures of one decision in two languages. That
 * pairing is the point: a row is one expression, and the tests below are what
 * hold the notice to being read per expression rather than per work.
 */

import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import JSZip from "jszip";

import type { DocumentStageObservation } from "@stll/legal-atlas/document-fetch-diagnostics";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
} from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildListingQuery,
  buildDecision,
  ecjRawParts,
  fetchNotice,
  euEcjAdapter,
  refreshEcjStoredFormex,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import type { EcjSparqlBinding } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { PublisherRateLimitRefusalError } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { parseFormexBibliography } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-formex-bibliography";
import { parseEcjNotice } from "@/api/handlers/case-law/ingestion/parsers/eu-ecj-notice";
import {
  classifyObservation,
  resolveExistingDecisionPolicy,
} from "@/api/handlers/case-law/ingestion/pipeline/decision-existing";
import type { ExistingDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import { createSafeId } from "@/api/lib/branded-types";
import { splitStoredDecisionTextMetadata } from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { caseLawProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { parsePrimaryReferenceType } from "@/api/lib/legal-search/decision-primary-reference";
import { withDocumentStageWindow } from "@/api/lib/legal-search/document-stage-observation";
import {
  sanitizeResult,
  partialObservationFromMetadata,
} from "@/api/lib/legal-search/ingestion-normalization";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  decodeSourceRawEnvelope,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/lib/legal-search/ingestion-types";
import type { StoredRawReparseInput } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock, asTestRaw } from "@/api/tests/helpers/test-tool-set";

const CELEX = "62022CJ0128";
const EXPRESSION = "cc021804-9350-11ee-8aa6-01aa75ed71a1.0011";

const gunzipText = async (url: URL): Promise<string> =>
  new TextDecoder().decode(Bun.gunzipSync(await Bun.file(url).bytes()));

const noticeEn = await gunzipText(
  new URL("__fixtures__/eu-ecj-notice-en.xml.gz", import.meta.url),
);
const noticeEl = await gunzipText(
  new URL("__fixtures__/eu-ecj-notice-el.xml.gz", import.meta.url),
);
const documentEn = await gunzipText(
  new URL(
    `../parsers/__fixtures__/eu-ecj/${CELEX}.en.html.gz`,
    import.meta.url,
  ),
);
const formexEn = await gunzipText(
  new URL(
    `../parsers/__fixtures__/eu-ecj/${CELEX}.en.fmx.xml.gz`,
    import.meta.url,
  ),
);

const binding = {
  ecli: { type: "literal", value: "ECLI:EU:C:2023:951" },
  date: { type: "literal", value: "2023-12-05" },
  celex: { type: "literal", value: CELEX },
  type: {
    type: "uri",
    value: "http://publications.europa.eu/ontology/cdm#judgement",
  },
  language: {
    type: "uri",
    value: "http://publications.europa.eu/resource/authority/language/ENG",
  },
  manifestation: {
    type: "uri",
    value: `http://publications.europa.eu/resource/cellar/${EXPRESSION}.05`,
  },
} as const satisfies EcjSparqlBinding;

const reparse = euEcjAdapter.reparseStoredRaw;
if (!reparse) {
  throw new TypeError("Expected eu-ecj to implement reparseStoredRaw");
}

const storedFrom = (
  raw: string,
  overrides: Partial<StoredRawReparseInput> = {},
): StoredRawReparseInput => ({
  raw: new TextEncoder().encode(raw),
  contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  caseNumber: "C-128/22",
  sourceDocumentId: `${CELEX}:en`,
  language: "en",
  court: "",
  ecli: binding.ecli.value,
  decisionDate: binding.date.value,
  decisionType: "judgment",
  sourceUrl: `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${CELEX}`,
  documentUrl: `https://publications.europa.eu/resource/cellar/${EXPRESSION}.05`,
  metadata: { celex: CELEX },
  ...overrides,
});

const storedEnvelope = (notice: string | undefined): string =>
  encodeSourceRawEnvelope(
    ecjRawParts({
      binding: { ...binding },
      html: documentEn,
      notice,
      formex: formexEn,
    }),
  );

const decisionFrom = async (notice: string | undefined) => {
  const outcome = await reparse(storedFrom(storedEnvelope(notice)));
  if (outcome.type !== "parsed") {
    throw new TypeError(`Expected parsed, got ${outcome.type}`);
  }
  return outcome.result;
};

describe("notice publication outcomes", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;
  beforeEach(() => {
    Bun.sleep = async () => {};
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  test("a 500 notice rejects the item and a later attempt can build it", async () => {
    let noticeRequests = 0;
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      if (
        (input instanceof Request ? input.url : String(input)).includes(
          "/resource/celex/",
        )
      ) {
        noticeRequests += 1;
        return new Response(null, { status: noticeRequests === 1 ? 500 : 404 });
      }
      return new Response(documentEn, {
        headers: { "Content-Type": "application/xhtml+xml" },
      });
    });

    const initial = await Result.tryPromise({
      try: async () => buildDecision(binding, AbortSignal.timeout(5000)),
      catch: (error) => error,
    });
    expect(Result.isError(initial)).toBe(true);
    if (
      !Result.isError(initial) ||
      !(initial.error instanceof AdapterFetchError)
    ) {
      throw new TypeError("Expected a notice fetch failure");
    }
    expect(initial.error.message).toContain("Cellar notice HTTP 500");
    const retried = await buildDecision(binding, AbortSignal.timeout(5000));
    expect(noticeRequests).toBe(2);
    expect(retried?.fulltext?.length).toBeGreaterThan(100);
    expect(retried?.judges).toBeUndefined();
  });
  const readNotice = async (status: number) =>
    fetchNotice({
      celex: CELEX,
      languageUri: binding.language.value,
      signal: AbortSignal.timeout(1000),
      fetch: async () =>
        new Response(status === 200 ? noticeEn : null, { status }),
    });

  for (const status of [404, 410] as const) {
    test(`HTTP ${status} states the notice is not published`, async () => {
      expect((await readNotice(status)).unwrap()).toEqual({
        type: "not-published",
        status,
      });
    });
  }

  for (const status of [408, 429, 500, 502, 503, 504]) {
    test(`HTTP ${status} propagates a notice read failure`, async () => {
      const result = await readNotice(status);
      expect(Result.isError(result)).toBe(true);
      if (!Result.isError(result)) {
        throw new TypeError("Expected a notice read failure");
      }
      expect(result.error).toBeInstanceOf(AdapterFetchError);
      expect(result.error.message).toContain(`Cellar notice HTTP ${status}`);
    });
  }

  test.each([400, 401, 403, 405, 422])(
    "HTTP %s is a terminal notice refusal",
    async (status) => {
      expect((await readNotice(status)).unwrap()).toEqual({
        type: "refused",
        status,
      });
    },
  );

  test.each([400, 401, 403, 405, 422])(
    "a notice refusal %s retains the row and a later publication changes its hash",
    async (status) => {
      let noticeStatus: number = status;
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/resource/celex/")) {
          return new Response(noticeStatus === 200 ? noticeEn : null, {
            status: noticeStatus,
          });
        }
        return new Response(documentEn, {
          headers: { "Content-Type": "application/xhtml+xml" },
        });
      });
      const refused = await buildDecision(binding, AbortSignal.timeout(5000));
      expect(refused?.fulltext?.length).toBeGreaterThan(100);
      expect(refused?.judges).toBeUndefined();
      expect(
        decodeSourceRawEnvelope(refused?.sourceRaw ?? "")?.["notice-state"],
      ).toBe(`notice:refused:${status}`);
      noticeStatus = 404;
      const absent = await buildDecision(binding, AbortSignal.timeout(5000));
      expect(refused?.rawHash).not.toBe(absent?.rawHash);
      noticeStatus = 200;
      const present = await buildDecision(binding, AbortSignal.timeout(5000));
      expect(present?.rawHash).not.toBe(refused?.rawHash);
      expect(present?.judges?.length).toBeGreaterThan(0);
      if (!refused) {
        throw new TypeError("Expected a refused-notice decision");
      }
      const replayed = await reparse(storedFrom(refused.sourceRaw ?? ""));
      expect(replayed.type).toBe("parsed");
      if (replayed.type === "parsed") {
        expect(replayed.result.rawHash).toBe(refused.rawHash);
        expect(replayed.result.observationDetail).toBe("secondary-refused");
      }
    },
  );

  test.each([400, 401, 403, 404, 410, 408, 429, 500, 503])(
    "a Formex HTTP %s permits only terminal reads and later content changes the hash",
    async (status) => {
      let formexStatus: number = status;
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/resource/celex/")) {
          return new Response(noticeEn, {
            headers: { "Content-Type": "application/xml" },
          });
        }
        if (url.endsWith("/DOC_1")) {
          return new Response(formexStatus === 200 ? formexEn : null, {
            status: formexStatus,
            headers: { "Content-Type": "application/xml" },
          });
        }
        return new Response(documentEn, {
          headers: { "Content-Type": "application/xhtml+xml" },
        });
      });
      const initial = buildDecision(binding, AbortSignal.timeout(5000));
      if ([408, 429, 500, 503].includes(status)) {
        const outcome = await Result.tryPromise({
          try: async () => initial,
          catch: (error) => error,
        });
        expect(Result.isError(outcome)).toBe(true);
        if (!Result.isError(outcome)) {
          throw new TypeError("Expected a Formex fetch failure");
        }
        expect(outcome.error).toBeInstanceOf(
          status === 429 ? PublisherRateLimitRefusalError : AdapterFetchError,
        );
      } else {
        const incomplete = await initial;
        expect(incomplete?.metadata["formexCelex"]).toBeUndefined();
        const incompleteParts = decodeSourceRawEnvelope(
          incomplete?.sourceRaw ?? "",
        );
        expect(incompleteParts?.["formex-state"]).toBe(
          [404, 410].includes(status)
            ? "formex:gone"
            : `formex:refused:${status}`,
        );
        formexStatus = 200;
        const complete = await buildDecision(
          binding,
          AbortSignal.timeout(5000),
        );
        expect(complete?.fulltext).toBe(incomplete?.fulltext);
        expect(complete?.metadata["formexCelex"]).toBeDefined();
        expect(complete?.rawHash).not.toBe(incomplete?.rawHash);
        if (!incomplete) {
          throw new TypeError("Expected an incomplete Formex decision");
        }
        const replayed = await reparse(storedFrom(incomplete.sourceRaw ?? ""));
        expect(replayed.type).toBe("parsed");
        if (replayed.type === "parsed") {
          expect(replayed.result.rawHash).toBe(incomplete.rawHash);
          expect(replayed.result.observationDetail).toBe(
            [404, 410].includes(status) ? "complete" : "secondary-refused",
          );
        }
        const repeated = await buildDecision(
          binding,
          AbortSignal.timeout(5000),
        );
        expect(repeated?.rawHash).toBe(complete?.rawHash);
        formexStatus = 404;
        const gone = await buildDecision(binding, AbortSignal.timeout(5000));
        if (![404, 410].includes(status)) {
          expect(gone?.rawHash).not.toBe(incomplete.rawHash);
        }
      }
    },
  );

  const storedDecision = (result: IngestionResult) =>
    ({
      id: createSafeId<"caseLawDecision">(),
      caseNumber: result.caseNumber,
      caseNumberType: parsePrimaryReferenceType(result.caseNumberType),
      citationKey: null,
      country: result.country,
      decisionDate: result.decisionDate ?? null,
      sourceDocumentId: result.sourceDocumentId ?? null,
      ecli: result.ecli ?? null,
      metadata: result.metadata,
      sourceHash: result.rawHash,
      sourceObservedAt: new Date("2026-10-01T00:00:00Z"),
      sourceObservationHash: result.rawHash,
      redactedAt: null,
      corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
      contentHash: "stored-complete-document",
      textS3Key: "stored/text",
      normalizedS3Key: "stored/normalized",
      astS3Key: "stored/ast",
      sourceRawS3Key: "stored/raw",
      sourceRawContentType: result.sourceRawContentType ?? null,
      sourceUrl: result.sourceUrl ?? null,
      hasStoredDocument: true,
    }) satisfies ExistingDecision;

  test.each(["notice", "formex"] as const)(
    "a refused %s observation preserves complete metadata and raw; complete reads enrich earlier refusals",
    async (refusedPart) => {
      let status = 200;
      globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/resource/celex/")) {
          const noticeStatus = refusedPart === "notice" ? status : 200;
          return new Response(noticeStatus === 200 ? noticeEn : null, {
            status: noticeStatus,
          });
        }
        if (url.endsWith("/DOC_1")) {
          const formexStatus = refusedPart === "formex" ? status : 200;
          return new Response(formexStatus === 200 ? formexEn : null, {
            status: formexStatus,
          });
        }
        return new Response(documentEn, {
          headers: { "Content-Type": "application/xhtml+xml" },
        });
      });
      const read = async () => {
        const result = await buildDecision(binding, AbortSignal.timeout(5000));
        if (result === undefined) {
          throw new TypeError("Expected a decision from the captured HTML");
        }
        return sanitizeResult(result);
      };
      const complete = await read();
      expect(complete.metadata["noticeCelex"]).toBeDefined();
      expect(complete.metadata["publisherCaseNumber"]).toBeDefined();
      expect(complete.metadata["formexCelex"]).toBeDefined();
      expect(
        decodeSourceRawEnvelope(complete.sourceRaw ?? "")?.["notice"],
      ).toBeDefined();
      expect(
        decodeSourceRawEnvelope(complete.sourceRaw ?? "")?.["formex"],
      ).toBeDefined();
      const existing = storedDecision(complete);
      const persisted = { ...existing, sourceRaw: complete.sourceRaw };
      const before = structuredClone(persisted);
      status = 403;
      const refused = await read();
      expect(refused.rawHash).not.toBe(complete.rawHash);
      const refusedParts = decodeSourceRawEnvelope(refused.sourceRaw ?? "");
      expect(refusedParts?.[refusedPart]).toBeUndefined();
      expect(refusedParts?.[`${refusedPart}-state`]).toBe(
        `${refusedPart}:refused:403`,
      );
      expect(partialObservationFromMetadata(refused.metadata).detail).toBe(
        "secondary-refused",
      );
      expect(
        partialObservationFromMetadata(refused.metadata).detail ===
          "listing-only",
      ).toBe(false);
      const projection = deriveCorpusIndexProjectionDescriptor(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
        caseLawProjectionInputFromCanonical({
          documentId: createSafeId<"caseLawDecision">(),
          sourceId: createSafeId<"caseLawSource">(),
          jurisdiction: refused.country,
          language: refused.language,
          documentType: "judgment",
          contentHash: "refused-secondary-with-complete-primary-text",
          redactedAt: null,
          caseNumber: refused.caseNumber,
          identifiers: [],
          court: refused.court,
          courtId: null,
          decisionDate: refused.decisionDate ?? null,
          ecli: refused.ecli ?? null,
          metadata: refused.metadata,
          sourceDescriptor: null,
        }),
      );
      expect(projection.action).toBe("upsert");
      const observations: DocumentStageObservation[] = [];
      await withDocumentStageWindow({
        source: ADAPTER_KEYS.EU_ECJ,
        now: () => 0,
        observe: (event) => {
          observations.push(event);
        },
        fetchPage: async () =>
          Result.ok({ decisions: [refused], nextCursor: null }),
      });
      expect(observations.at(-1)).toMatchObject({
        filled: 1,
        backlog: 0,
        failed: 0,
      });
      const shape = classifyObservation({ result: refused, existing });
      expect(shape.preservesExistingDetail).toBe(true);
      const writes: Record<string, unknown>[] = [];
      const tx = {
        select: () => ({
          from: (table: unknown) => {
            if (table === caseLawSources) {
              return {
                innerJoin: () => ({
                  where: () => ({
                    limit: () => ({
                      for: async () => [
                        {
                          sourceId: createSafeId<"caseLawSource">(),
                          sourceDescriptor: {},
                        },
                      ],
                    }),
                  }),
                }),
              };
            }
            expect(table).toBe(corpusIndexGenerations);
            return { where: () => ({ limit: async () => [] }) };
          },
        }),
        update: (table: unknown) => {
          expect(table).toBe(caseLawDecisions);
          return {
            set: (values: Record<string, unknown>) => {
              writes.push(values);
              Object.assign(persisted, values);
              return {
                where: () => ({ returning: async () => [{ id: existing.id }] }),
              };
            },
          };
        },
      };
      const scopedDb: ScopedDb = async (work) =>
        await work(asTestRaw<Transaction>(tx));
      const observedAt = new Date("2026-10-03T00:00:00Z");
      const outcome = await resolveExistingDecisionPolicy({
        scopedDb,
        existing,
        result: refused,
        shape,
        observedAt,
        observationOrder: 2n,
        refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
      });
      expect(outcome?.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
      expect(writes).toHaveLength(1);
      expect(Object.keys(writes.at(0) ?? {}).toSorted()).toEqual(
        [
          "sourceObservedAt",
          "sourceObservationOrder",
          "sourceObservationHash",
          "updatedAt",
        ].toSorted(),
      );
      expect(persisted.metadata).toEqual(before.metadata);
      expect(persisted.sourceRaw).toBe(before.sourceRaw);
      expect(persisted.sourceRawS3Key).toBe(before.sourceRawS3Key);
      expect(persisted.sourceHash).toBe(before.sourceHash);
      expect(persisted.decisionDate).toBe(before.decisionDate);
      expect(persisted.sourceObservationHash).toBe(refused.rawHash);
      expect(persisted.sourceObservedAt).toBe(observedAt);

      const partialExisting = storedDecision(refused);
      for (const stored of [existing, partialExisting]) {
        const listingOnly = sanitizeResult({
          ...refused,
          ...splitStoredDecisionTextMetadata(refused.metadata),
          observationDetail: "listing-only",
        });
        expect(
          classifyObservation({ result: listingOnly, existing: stored })
            .preservesExistingDetail,
        ).toBe(true);
      }

      expect(
        classifyObservation({ result: refused, existing: undefined })
          .preservesExistingDetail,
      ).toBe(false);
      expect(
        classifyObservation({ result: refused, existing: partialExisting })
          .preservesExistingDetail,
      ).toBe(false);
      status = 200;
      const enriched = await read();
      expect(enriched.metadata).toEqual(complete.metadata);
      expect(enriched.sourceRaw).toBe(complete.sourceRaw);
      expect(
        partialObservationFromMetadata(enriched.metadata).detail ===
          "listing-only",
      ).toBe(false);
      const enrichmentShape = classifyObservation({
        result: enriched,
        existing: partialExisting,
      });
      expect(enrichmentShape.preservesExistingDetail).toBe(false);
      expect(
        await resolveExistingDecisionPolicy({
          scopedDb,
          existing: partialExisting,
          result: enriched,
          shape: enrichmentShape,
          observedAt,
          observationOrder: 3n,
          refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
        }),
      ).toBeNull();

      for (const goneStatus of [404, 410]) {
        status = goneStatus;
        const gone = await read();
        expect(gone.rawHash).not.toBe(complete.rawHash);
        expect(
          partialObservationFromMetadata(gone.metadata).detail ===
            "listing-only",
        ).toBe(false);
        const goneShape = classifyObservation({ result: gone, existing });
        expect(goneShape.preservesExistingDetail).toBe(false);
        expect(
          gone.metadata[
            refusedPart === "notice" ? "noticeCelex" : "formexCelex"
          ],
        ).toBeUndefined();
        // Confirmed absence is authoritative: the pipeline proceeds to replace
        // metadata and raw, removing the notice or Formex content that is gone.
        expect(
          await resolveExistingDecisionPolicy({
            scopedDb,
            existing,
            result: gone,
            shape: goneShape,
            observedAt,
            observationOrder: 4n,
            refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
          }),
        ).toBeNull();
        expect(
          decodeSourceRawEnvelope(gone.sourceRaw ?? "")?.[refusedPart],
        ).toBeUndefined();
      }
      expect(writes).toHaveLength(1);
    },
  );

  test("a published notice retains its bytes", async () => {
    expect((await readNotice(200)).unwrap()).toEqual({
      type: "present",
      xml: noticeEn,
    });
  });

  test("Formex publication and content changes alter the source hash without changing fulltext", async () => {
    const decisions = [];
    for (const formex of [undefined, formexEn, `${formexEn}\n`, formexEn]) {
      const outcome = await reparse(
        storedFrom(
          encodeSourceRawEnvelope(
            ecjRawParts({
              binding,
              html: documentEn,
              notice: noticeEn,
              formex,
            }),
          ),
        ),
      );
      if (outcome.type !== "parsed") {
        throw new TypeError(`Expected parsed, got ${outcome.type}`);
      }
      decisions.push(outcome.result);
    }
    expect(new Set(decisions.map((decision) => decision.fulltext)).size).toBe(
      1,
    );
    expect(new Set(decisions.map((decision) => decision.rawHash)).size).toBe(3);
    expect(decisions.at(1)?.rawHash).toBe(decisions.at(3)?.rawHash);
  });

  test("notice publication and content changes alter the source hash", async () => {
    const absent = await decisionFrom(undefined);
    const present = await decisionFrom(noticeEn);
    const changed = await decisionFrom(noticeEn.replace("<NOTICE", "<NOTICE "));

    expect(present.fulltext).toBe(absent.fulltext);
    expect(changed.fulltext).toBe(present.fulltext);
    expect(present.rawHash).not.toBe(absent.rawHash);
    expect(changed.rawHash).not.toBe(present.rawHash);
    expect((await decisionFrom(noticeEn)).rawHash).toBe(present.rawHash);
  });
});

describe("the branch notice is read per expression", () => {
  test("the translated fields differ between two notices of one work", () => {
    const english = parseEcjNotice(noticeEn);
    const greek = parseEcjNotice(noticeEl);

    // Both notices are of the same work, so everything keyed on the work is
    // identical and everything the Office renders into the negotiated
    // language is not. A row storing its neighbour's notice would carry the
    // second column under the first row's identity.
    expect(english.celex).toEqual(greek.celex);
    expect(english.rapporteur).toEqual(greek.rapporteur);
    expect(english.caseIdentifier).toContain("Case C-128/22");
    expect(greek.caseIdentifier).toContain("Υπόθεση C-128/22");
    expect(greek.title).not.toEqual(english.title);
  });

  test("the court is read from the authority code, not the rendered label", () => {
    // `PREFLABEL` is translated, so a court read from it would file this one
    // judgment under twenty-four different courts.
    const greek = parseEcjNotice(noticeEl);

    expect(greek.courtCode).toContain("CJ");
  });

  test("retains every repeated work and expression value in source order", () => {
    const $ = cheerio.load(noticeEn, { xml: true });
    const work = $("NOTICE > WORK").first();
    const expression = $("NOTICE > EXPRESSION").first();
    const dossierEvent = work
      .find("WORK_PART_OF_DOSSIER > EMBEDDED_NOTICE > EVENT")
      .first();
    const appendCopy = (
      parent: cheerio.Cheerio<Element>,
      tag: string,
      update: (copy: cheerio.Cheerio<Element>) => void,
    ) => {
      const original = parent.children(tag).first();
      expect(original).toHaveLength(1);
      const copy = original.clone();
      update(copy);
      parent.append(copy);
    };

    appendCopy(work, "CASE-LAW_NATIONAL-JUDGEMENT", (copy) => {
      copy
        .children("VALUE")
        .text(
          "<national_judgement><p>Second referring court.</p></national_judgement>",
        );
    });
    appendCopy(work, "CASE-LAW_ORIGINATES_IN_COUNTRY", (copy) => {
      copy.children("IDENTIFIER").text("LUX");
      copy.children("PREFLABEL").text("Luxembourg");
    });
    appendCopy(work, "CASE-LAW_USES_PROCEDURE_LANGUAGE", (copy) => {
      copy.children("IDENTIFIER").text("FRA");
      copy.children("PREFLABEL").text("French");
    });
    appendCopy(
      work,
      "CASE-LAW_HAS_TYPE_PROCEDURE_CONCEPT_TYPE_PROCEDURE",
      (copy) => {
        copy.children("IDENTIFIER").text("APPEAL");
        copy.children("PREFLABEL").text("Appeal");
      },
    );
    appendCopy(work, "CASE-LAW_DELIVERED_BY_JUDGE", (copy) => {
      copy.find("AGENT_NAME > VALUE").first().text("Second Rapporteur");
    });
    appendCopy(work, "CASE-LAW_DELIVERED_BY_ADVOCATE-GENERAL", (copy) => {
      copy.find("AGENT_NAME > VALUE").first().text("Second Advocate General");
    });
    appendCopy(work, "VERSION", (copy) => {
      copy.children("VALUE").text("Second record version");
    });
    appendCopy(work, "WORK_DATE_DOCUMENT", (copy) => {
      copy.children("VALUE").text("2023-12-06");
    });
    appendCopy(expression, "EXPRESSION_TITLE", (copy) => {
      copy.children("VALUE").text("Second expression title");
    });
    appendCopy(expression, "EXPRESSION_CASE-LAW_IDENTIFIER_CASE", (copy) => {
      copy.children("VALUE").text("Second case identifier");
    });
    appendCopy(dossierEvent, "EVENT_CONTAINS_WORK", (copy) => {
      copy.find("SAMEAS URI IDENTIFIER").first().text("62000CJ0001");
      copy
        .find("SAMEAS")
        .append(
          "<URI><TYPE>celex</TYPE><IDENTIFIER>62000CJ0002</IDENTIFIER></URI>",
        );
    });
    const zip = $("NOTICE > MANIFESTATION").first().clone();
    zip.attr("manifestation-type", "zip");
    zip.children("MANIFESTATION_TYPE").children("VALUE").text("zip");
    zip.children("URI").children("VALUE").text("https://example.test/all.zip");
    $("NOTICE").append(zip);

    const facts = parseEcjNotice($.xml());

    expect(facts.nationalJudgment).toHaveLength(2);
    expect(facts.nationalJudgment[1]).toContain("Second referring court.");
    expect(facts.referringCountry.map(({ code }) => code)).toContain("LUX");
    expect(facts.procedureLanguage.map(({ code }) => code)).toContain("FRA");
    expect(facts.procedureType.map(({ code }) => code)).toContain("APPEAL");
    expect(facts.rapporteur).toContain("Second Rapporteur");
    expect(facts.advocateGeneral).toContain("Second Advocate General");
    expect(facts.recordVersion).toContain("Second record version");
    expect(facts.decisionDate).toEqual(["2023-12-05", "2023-12-06"]);
    expect(facts.title).toContain("Second expression title");
    expect(facts.caseIdentifier).toContain("Second case identifier");
    expect(facts.caseEventWorks).toContain("62000CJ0001");
    expect(facts.caseEventWorks).toContain("62000CJ0002");
    expect(facts.manifestations).toContainEqual({
      type: "zip",
      uri: "https://example.test/all.zip",
    });
  });
});

describe("stored Formex refresh", () => {
  const signal = new AbortController().signal;
  const refreshStored = (parts: Record<string, string>) =>
    storedFrom(encodeSourceRawEnvelope(parts));
  const response = (
    body: string | Uint8Array,
    status = 200,
    type = "application/xml",
  ) => new Response(body, { status, headers: { "content-type": type } });

  test("replaces only Formex while retaining unknown Unicode parts and rebuilding the decision", async () => {
    const before = {
      ...ecjRawParts({
        binding: { ...binding },
        html: documentEn,
        notice: noticeEn,
        formex: "<old-formex />",
      }),
      "future-part": "Zażółć gęślą jaźń 🧑🏽‍⚖️",
    };
    const outcome = await refreshEcjStoredFormex({
      stored: refreshStored(before),
      signal,
      fetchFormex: async () => response("<new-formex />"),
    });

    expect(outcome.type).toBe("refreshed");
    if (outcome.type !== "refreshed") {
      throw new TypeError(`Expected refreshed, got ${outcome.type}`);
    }
    expect(outcome.formexShape).toBe("xml");
    expect(outcome.bytes).toBe(
      new TextEncoder().encode("<new-formex />").byteLength,
    );
    const after = decodeSourceRawEnvelope(outcome.decision.sourceRaw ?? "");
    expect(after).not.toBeNull();
    expect(after?.["formex"]).toBe("<new-formex />");
    expect(after?.["future-part"]).toBe(before["future-part"]);
    for (const [key, value] of Object.entries(before)) {
      if (key !== "formex") {
        expect(after?.[key]).toBe(value);
      }
    }
    expect(outcome.decision.fulltext).not.toBe("");
  });

  test("a successful Formex refresh removes an earlier refusal marker", async () => {
    const outcome = await refreshEcjStoredFormex({
      stored: refreshStored({
        ...ecjRawParts({
          binding,
          html: documentEn,
          notice: noticeEn,
          formex: undefined,
        }),
        "formex-state": "formex:refused:403",
      }),
      signal,
      fetchFormex: async () => response(formexEn),
    });
    if (outcome.type !== "refreshed") {
      throw new TypeError(`Expected refreshed, got ${outcome.type}`);
    }
    const parts = decodeSourceRawEnvelope(outcome.decision.sourceRaw ?? "");
    expect(parts?.["formex"]).toBe(formexEn);
    expect(parts?.["formex-state"]).toBeUndefined();
    expect(outcome.decision.observationDetail).toBe("complete");
  });

  test("stores a fetched ZIP as the adapter's Formex archive shape", async () => {
    const archive = new JSZip();
    archive.file("FORMEX/main.xml", "<new-formex />");
    const bytes = await archive.generateAsync({ type: "uint8array" });
    const outcome = await refreshEcjStoredFormex({
      stored: refreshStored({
        ...ecjRawParts({
          binding: { ...binding },
          html: documentEn,
          notice: noticeEn,
          formex: "<old-formex />",
        }),
      }),
      signal,
      fetchFormex: async () => response(bytes, 200, "application/zip"),
    });

    expect(outcome.type).toBe("refreshed");
    if (outcome.type !== "refreshed") {
      throw new TypeError(`Expected refreshed, got ${outcome.type}`);
    }
    expect(outcome.formexShape).toBe("archive");
    expect(outcome.bytes).toBeGreaterThan(0);
    const after = decodeSourceRawEnvelope(outcome.decision.sourceRaw ?? "");
    expect(after?.["formex"]?.startsWith("formex-archive:")).toBe(true);
  });

  test("rejects a refreshed decision whose source identity differs from the stored row", async () => {
    const mismatched = await refreshEcjStoredFormex({
      stored: {
        ...refreshStored(
          ecjRawParts({
            binding: { ...binding },
            html: documentEn,
            notice: noticeEn,
            formex: "<old-formex />",
          }),
        ),
        sourceDocumentId: `${CELEX}:fr`,
      },
      signal,
      fetchFormex: async () => response("<new-formex />"),
    });
    expect(mismatched).toEqual({
      type: "write-rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
    });
  });

  test("returns typed outcomes for missing notice, missing manifestation, gone and exhausted responses", async () => {
    const withoutNotice = ecjRawParts({
      binding: { ...binding },
      html: documentEn,
      notice: undefined,
      formex: "<old-formex />",
    });
    expect(
      await refreshEcjStoredFormex({
        stored: refreshStored(withoutNotice),
        signal,
        fetchFormex: async () =>
          await Promise.reject(new Error("must not fetch")),
      }),
    ).toEqual({ type: "notice-missing" });

    const $notice = cheerio.load(noticeEn, { xml: true });
    $notice("NOTICE > MANIFESTATION").remove();
    expect(
      await refreshEcjStoredFormex({
        stored: refreshStored({
          ...ecjRawParts({
            binding: { ...binding },
            html: documentEn,
            notice: $notice.xml(),
            formex: "<old-formex />",
          }),
        }),
        signal,
        fetchFormex: async () =>
          await Promise.reject(new Error("must not fetch")),
      }),
    ).toEqual({ type: "formex-not-located" });

    for (const [status, expected] of [
      [404, "formex-gone"],
      [410, "formex-gone"],
      [403, "formex-refused"],
      [408, "retryable-exhausted"],
      [429, "retryable-exhausted"],
      [503, "retryable-exhausted"],
    ] as const) {
      const outcome = await refreshEcjStoredFormex({
        stored: refreshStored({
          ...ecjRawParts({
            binding: { ...binding },
            html: documentEn,
            notice: noticeEn,
            formex: "<old-formex />",
          }),
        }),
        signal,
        fetchFormex: async () => response("", status),
      });
      expect(outcome).toEqual(
        expected === "formex-refused"
          ? { type: expected, status }
          : { type: expected },
      );
    }

    const refusal = new PublisherRateLimitRefusalError({
      adapterKey: ADAPTER_KEYS.EU_ECJ,
      cursor: null,
      publisherKey: "cellar-eu",
      status: 429,
      cooldownUntilEpochMs: 1_800_000_000_000,
    });
    const rateLimited = await refreshEcjStoredFormex({
      stored: refreshStored({
        ...ecjRawParts({
          binding: { ...binding },
          html: documentEn,
          notice: noticeEn,
          formex: "<old-formex />",
        }),
      }),
      signal,
      fetchFormex: async () => await Promise.reject(refusal),
    });
    expect(rateLimited).toEqual({
      type: "rate-limited",
      publisherKey: "cellar-eu",
      status: 429,
      cooldownUntilEpochMs: 1_800_000_000_000,
    });
  });

  test("treats a stored archive as current without contacting Cellar", async () => {
    const currentFormex = `formex-archive:${encodeSourceRawEnvelope({
      "FORMEX/main.xml": Buffer.from("<current-formex />").toString("base64"),
    })}`;

    const outcome = await refreshEcjStoredFormex({
      stored: refreshStored({
        ...ecjRawParts({
          binding: { ...binding },
          html: documentEn,
          notice: undefined,
          formex: currentFormex,
        }),
      }),
      signal,
      fetchFormex: async () =>
        await Promise.reject(new Error("current row must not fetch")),
    });
    expect(outcome).toEqual({ type: "unchanged-already-current" });
  });
});

describe("what the notice adds to a stored row", () => {
  test("names the court outright instead of inferring it from the ECLI", async () => {
    const decision = await decisionFrom(noticeEn);

    expect(decision.court === "Court of Justice").toBe(true);
  });

  test("emits the rapporteur and the Advocate General as the bench", async () => {
    const decision = await decisionFrom(noticeEn);

    expect(
      Bun.deepEquals(decision.judges, [
        { role: DECISION_JUDGE_ROLE.RAPPORTEUR, nameAsPrinted: "Safjan" },
        {
          role: DECISION_JUDGE_ROLE.ADVOCATE_GENERAL,
          nameAsPrinted: "Emiliou",
        },
      ]),
    ).toBe(true);
  });

  test("keeps the publisher's own cited-works list", async () => {
    const decision = await decisionFrom(noticeEn);

    // The ground truth citation extraction is measured against, which is why
    // it is carried beside the row rather than stored on it.
    expect(
      decision.publisherCitedCases?.some((value) => value === "62015CJ0601"),
    ).toBe(true);
    expect(decision.publisherCitedCases?.length).toBeGreaterThan(40);
  });

  test("keeps both classification trees, the referral and the case file", async () => {
    const decision = await decisionFrom(noticeEn);

    expect(decision.metadata).toMatchObject({
      procedureLanguage: [{ code: "NLD", label: "Dutch" }],
      dossier: ["case:C-128/22"],
      publishedInReports: [true],
    });
    const directory = decision.metadata["caseLawDirectory"];
    expect(
      Array.isArray(directory) &&
        directory.some((value) =>
          Bun.deepEquals(value, {
            code: "1.09.03.02",
            label:
              "Restrictions justified on grounds of public policy, public security or public health",
          }),
        ),
    ).toBe(true);
    const directoryNew = decision.metadata["caseLawDirectoryNew"];
    expect(
      Array.isArray(directoryNew) &&
        directoryNew.some((value) =>
          Bun.deepEquals(value, {
            code: "4.06.01.02",
            label: "Crossing of external borders",
          }),
        ),
    ).toBe(true);
    expect(decision.metadata["nationalJudgment"]).toContainEqual(
      expect.stringContaining(
        "Nederlandstalige rechtbank van eerste aanleg Brussel",
      ),
    );
  });

  test("a row without one keeps its document and states no bench", async () => {
    // The notice is one request of three, and the Office does not serve one
    // for every work. An absent bench is not an empty one: the pipeline
    // replaces a decision's judges only where an observation carries the
    // field, so an empty list would erase what an earlier pass recovered.
    const decision = await decisionFrom(undefined);

    expect(decision.judges).toBeUndefined();
    expect(decision.publisherCitedCases).toBeUndefined();
    expect(decision.fulltext?.length).toBeGreaterThan(100);
  });
});

describe("the Formex bibliography", () => {
  test("states the docket and the court without a language", () => {
    // Both are rendered into the negotiated language by the notice, so this
    // is the only surface that states them the same way in all 24 rows.
    const bibliography = parseFormexBibliography(formexEn);

    expect(bibliography.caseNumber).toEqual(["C-128/22"]);
    expect(bibliography.author).toEqual(["CJ"]);
  });
});

describe("a row stored before the envelope", () => {
  test("re-parses from the bare manifestation it holds", async () => {
    // Every row this adapter wrote before it had an envelope holds the XHTML
    // and nothing else, under the content type of the day. Dropping that
    // reader would make the whole stored corpus unreplayable.
    const outcome = await reparse(
      storedFrom(documentEn, {
        contentType: "application/xhtml+xml; stella-storage=verbatim",
      }),
    );

    if (outcome.type !== "parsed") {
      throw new TypeError(`Expected parsed, got ${outcome.type}`);
    }
    expect(outcome.result.fulltext?.length).toBeGreaterThan(100);
    // Nothing the notice would have stated, because no notice was kept.
    expect(outcome.result.judges).toBeUndefined();
  });
});

describe("the listing query binds CELEX the way the endpoint answers", () => {
  test("binds the CELEX as a typed string literal", () => {
    // `cdm:resource_legal_id_celex` holds `xsd:string`-typed literals. A plain
    // literal is a different RDF term, so the endpoint answers 200 with no
    // rows and a decision it holds reads as one it never published.
    const query = buildListingQuery({
      dateFrom: "1952-01-01",
      dateTo: "2026-01-01",
      celexFilter: [CELEX],
    });

    expect(query).toContain(`VALUES ?celex { "${CELEX}"^^xsd:string }`);
    expect(query).toContain("PREFIX xsd:");
  });

  test("never filters an unbound CELEX through STR()", () => {
    // That shape puts the whole CELEX index inside the filter and the
    // endpoint stops answering, which is indistinguishable from an outage.
    const query = buildListingQuery({
      dateFrom: "1952-01-01",
      dateTo: "2026-01-01",
      celexFilter: [CELEX],
    });

    expect(query).not.toContain("STR(?celex)");
  });

  test("emits no CELEX clause when no CELEX was asked for", () => {
    // An empty clause would turn a lookup for named decisions into a sweep of
    // the whole corpus, so the date range has to be the only bound left.
    const query = buildListingQuery({
      dateFrom: "2024-01-01",
      dateTo: "2024-01-31",
    });

    expect(query).not.toContain("VALUES ?celex");
    expect(query).toContain('FILTER(STR(?date) >= "2024-01-01")');
  });
});

for (const candidate of [
  " https://example.org/manifestation?a=1&amp;b=2#part ",
  "https://example.org/%26amp%3B?a=1&b=2",
  "//example.org/manifestation",
  "/manifestation",
  "ftp://example.org/document",
  "data:text/plain,manifestation",
  "mailto:publisher@example.org",
]) {
  test(`notice manifestation URI provenance: ${candidate}`, async () => {
    const $ = cheerio.load(noticeEn, { xml: true });
    const manifestations = $("NOTICE > MANIFESTATION");
    expect(manifestations.length).toBeGreaterThan(0);
    manifestations.each((_, element) => {
      $(element).children("URI").children("VALUE").text(candidate);
    });
    const decision = await decisionFrom($.xml());
    const listed = decision.metadata["manifestations"];
    expect(Array.isArray(listed) ? listed.length : 0).toBe(
      manifestations.length,
    );
    if (candidate.trim().startsWith("https://")) {
      expect(
        Array.isArray(listed)
          ? listed.map((item: unknown) =>
              isRecord(item) ? item["uri"] : undefined,
            )
          : [],
      ).toEqual(
        Array.from({ length: manifestations.length }, () => candidate.trim()),
      );
      expect(decision.metadata["metadataUrlDiagnostics"]).toBeUndefined();
    } else {
      expect(
        Array.isArray(listed) &&
          listed.every(
            (item: unknown) => isRecord(item) && !Object.hasOwn(item, "uri"),
          ),
      ).toBe(true);
      expect(decision.metadata).toHaveProperty("metadataUrlDiagnostics", {
        entries: Array.from({ length: manifestations.length }, (_, index) => ({
          address: `manifestations[${index}].uri`,
          reason: candidate.startsWith("/") ? "invalid-url" : "unsafe-protocol",
        })),
        overflowCount: 0,
      });
    }
  });
}
