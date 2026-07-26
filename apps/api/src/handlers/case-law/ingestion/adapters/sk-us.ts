/**
 * Slovak Constitutional Court (Ústavný súd SR) adapter.
 *
 * Fetches decisions from the ustavnysud.sk REST API, a
 * Liferay DXP headless service. ~52,000 decisions from 1993
 * to present.
 *
 * Search: POST /o/v1/dms/search (no auth)
 * PDFs:   GET  /docDownload/{documentId} (no auth)
 *
 * Both endpoints are open. The search endpoint previously sat
 * behind an OAuth2 client_credentials application whose
 * credentials the court shipped in its own JavaScript bundle;
 * that application has since been removed, and the token
 * endpoint now answers `invalid_client` for it. Send no
 * `Authorization` header at all: the endpoint rejects a
 * request carrying one it cannot verify, so a stale token is
 * worse than none.
 *
 * The Liferay DMS search endpoint has an internal pagination
 * cap (~3,000 results per query). To access the full archive,
 * we window queries by year and paginate within each window.
 *
 * Cursor format: "YYYY:offset" (e.g. "1993:0", "2020:1500").
 * Legacy cursors (plain offset like "3060") are migrated
 * to the current year on first use.
 */

import { Result, panic } from "better-result";

import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSION,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type {
  EmptyAst,
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  INGESTION_USER_AGENT,
  adapterCatch,
  hashContent,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseSkDecisionPdf } from "@/api/handlers/case-law/ingestion/parsers/sk-courts";
import { FetchBoundaryError } from "@/api/lib/errors/tagged-errors";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { isRecord } from "@/api/lib/type-guards";

// ── Constants ─────────────────────────────────────────────

const BASE_URL = "https://www.ustavnysud.sk";
const SEARCH_URL = `${BASE_URL}/o/v1/dms/search`;
const DOC_DOWNLOAD_URL = `${BASE_URL}/docDownload`;

const PAGE_SIZE = 10;

/** First year with decisions in the API. */
const FIRST_YEAR = 1993;

/**
 * Fields to request from the search API. Empty array
 * returns all fields including the built-in `documentId`.
 * Listing specific fields causes `documentId` to be
 * omitted (Liferay DMS quirk), so we request everything.
 */
const FIELDS_TO_RETURN: string[] = [];

// ── Cursor helpers ──────────────────────────────────────────

type YearCursor = { year: number; offset: number };

const parseCursor = (cursor: string | null): YearCursor => {
  if (!cursor) {
    return { year: FIRST_YEAR, offset: 0 };
  }

  // New format: "YYYY:offset"
  const match = /^(?<year>\d{4}):(?<offset>\d+)$/u.exec(cursor);
  const { year, offset } = match?.groups ?? {};
  if (year && offset) {
    return {
      year: Number.parseInt(year, 10),
      offset: Number.parseInt(offset, 10),
    };
  }

  // Legacy format: plain offset number (e.g. "3060").
  // The global offset is meaningless with year-windowed queries.
  // Restart from FIRST_YEAR to backfill the full 1993–present
  // archive (~52k decisions, takes a few hours to crawl through).
  const legacyOffset = Number.parseInt(cursor, 10);
  if (!Number.isNaN(legacyOffset)) {
    return { year: FIRST_YEAR, offset: 0 };
  }

  return { year: FIRST_YEAR, offset: 0 };
};

const encodeCursor = (c: YearCursor): string => `${c.year}:${c.offset}`;

// ── Search API types ─────────────────────────────────────

type SearchDocument = {
  documentId?: string;
  mkDocumentType?: string;
  mkRSAPNumberOfFile?: string;
  mkRVPNumberOfFile?: string;
  mkECLI?: string;
  mkDateOfDecision?: string;
  mkDateOfLegalForce?: string;
  mkPublicationDate?: string;
  mkFormOfDecision?: string;
  mkTypeOfDecision?: string[];
  mkTypeOfProceeding?: string;
  mkTypeOfNegotiation?: string[];
  mkDecisionInTermsOf?: string[];
  mkResultOfNegotiation?: string[];
  mkCause?: string[];
  mkJudgeReporter?: string;
  mkDifferentView?: string[];
  mkWordRegister?: string[];
  mkMaterialRegister?: string[];
  mkComplainedLegalRegulation?: string | string[];
  mkFileReference?: string[];
  mkReferences?: string[];
  mkTypeOfProposer?: string;
  mkAffectedLegalRegulation?: string;
  mkUnderage?: string;
  mkIncludeToZnaU?: boolean;
  mkEntryDate?: string;
  mkFormOfEntry?: string;
  mkTypeOfEntry?: string;
};

type SearchResponse = {
  documents: SearchDocument[];
  numFound: number;
};

/**
 * Validate only the response envelope. Individual document
 * field validation is too brittle: the Liferay DMS API adds
 * fields and changes types without notice (e.g. returning
 * USSR_DECISION alongside USSR_DECISION_MK items). Since all
 * metadata lands in JSONB, strict per-field validation adds
 * no safety — it just causes the entire page to be rejected.
 */
const isSearchResponse = (value: unknown): value is SearchResponse =>
  isRecord(value) &&
  Array.isArray(value["documents"]) &&
  value["documents"].every(isRecord) &&
  typeof value["numFound"] === "number";

// ── Date parsing ─────────────────────────────────────────

/**
 * Parse the API's date format "MM/DD/YYYY HH:mm:ss" to
 * ISO "YYYY-MM-DD".
 */
const parseApiDate = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const groups = /^(?<month>\d{2})\/(?<day>\d{2})\/(?<year>\d{4})/u.exec(
    raw,
  )?.groups;
  if (!groups?.["month"] || !groups["day"] || !groups["year"]) {
    return undefined;
  }
  return `${groups["year"]}-${groups["month"]}-${groups["day"]}`;
};

// ── PDF download ─────────────────────────────────────────

const fetchPdfBytes = async (
  documentId: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> => {
  try {
    const response = await fetchWithTimeout(
      `${DOC_DOWNLOAD_URL}/${documentId}`,
      {
        headers: { "User-Agent": INGESTION_USER_AGENT },
        signal,
        timeoutMs: 30_000,
      },
    );
    if (!response.ok) {
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
};

// ── Item parsing ─────────────────────────────────────────

const dedupe = (arr: readonly string[] | undefined): string[] =>
  arr ? [...new Set(arr)] : [];

const parseDocument = async (
  doc: SearchDocument,
  signal?: AbortSignal,
): Promise<IngestionResult | null> => {
  const caseNumber = doc.mkRSAPNumberOfFile;
  if (!caseNumber || !doc.documentId) {
    return null;
  }

  const decisionDate = parseApiDate(doc.mkDateOfDecision);
  const decisionType = doc.mkFormOfDecision?.toLowerCase();
  const ecli = doc.mkECLI;
  const court = "Ústavný súd SR";

  // Fetch and parse PDF
  const pdfBytes = await fetchPdfBytes(doc.documentId, signal);

  let documentAst: DocumentAst | EmptyAst = EMPTY_AST;
  let fulltext: string | undefined;

  if (pdfBytes) {
    try {
      const parsed = await parseSkDecisionPdf({
        pdfBytes,
        caseNumber,
        ecli,
        court,
        decisionDate,
        decisionType,
        sourceSystem: "ustavnysud.sk",
      });
      documentAst = parsed.documentAst;
      fulltext = parsed.fulltext;
    } catch {
      // Parser failed; keep empty AST
    }
  }

  const rawHash = hashContent(JSON.stringify(doc));

  return {
    caseNumber,
    ecli,
    court,
    country: "SVK",
    language: "sk",
    decisionDate,
    decisionType,
    fulltext,
    sourceUrl: `${DOC_DOWNLOAD_URL}/${doc.documentId}`,
    documentUrl: `${DOC_DOWNLOAD_URL}/${doc.documentId}`,
    metadata: {
      caseNumber,
      ecli,
      court,
      decisionDate,
      decisionType,
      documentId: doc.documentId,
      documentType: doc.mkDocumentType,
      rvpNumber: doc.mkRVPNumberOfFile,
      judge: doc.mkJudgeReporter,
      typeOfDecision: dedupe(doc.mkTypeOfDecision),
      typeOfProceeding: doc.mkTypeOfProceeding,
      typeOfNegotiation: dedupe(doc.mkTypeOfNegotiation),
      legalBasis: dedupe(doc.mkDecisionInTermsOf),
      result: dedupe(doc.mkResultOfNegotiation),
      cause: dedupe(doc.mkCause),
      dissentingOpinion: dedupe(doc.mkDifferentView),
      wordRegister: dedupe(doc.mkWordRegister),
      materialRegister: dedupe(doc.mkMaterialRegister),
      challengedLegislation: (() => {
        if (Array.isArray(doc.mkComplainedLegalRegulation)) {
          return doc.mkComplainedLegalRegulation;
        }
        if (doc.mkComplainedLegalRegulation) {
          return [doc.mkComplainedLegalRegulation];
        }
        return undefined;
      })(),
      legalForceDate: parseApiDate(doc.mkDateOfLegalForce),
      publicationDate: parseApiDate(doc.mkPublicationDate),
      references: doc.mkReferences,
      fileReference: doc.mkFileReference,
      typeOfProposer: doc.mkTypeOfProposer,
      affectedLegalRegulation: doc.mkAffectedLegalRegulation,
      underage: doc.mkUnderage,
      includeToZnaU: doc.mkIncludeToZnaU,
      entryDate: parseApiDate(doc.mkEntryDate),
      formOfEntry: doc.mkFormOfEntry,
      typeOfEntry: doc.mkTypeOfEntry,
    },
    rawHash,
    parserVersion: PARSER_VERSION,
    documentAst,
    sourceRaw: JSON.stringify(doc),
    sourceRawBytes: pdfBytes,
    sourceRawContentType: pdfBytes ? "application/pdf" : "application/json",
  };
};

// ── Search helper ───────────────────────────────────────

/** HTTP statuses that mean "authenticate", which this adapter cannot. */
const AUTH_FAILURE_STATUSES = new Set([401, 403]);

const isAuthFailure = (error: unknown): boolean =>
  error instanceof FetchBoundaryError &&
  error.status !== undefined &&
  AUTH_FAILURE_STATUSES.has(error.status);

const executeSearch = async (
  year: number,
  offset: number,
  signal?: AbortSignal,
): Promise<SearchResponse | null> => {
  const response = await fetchWithTimeout(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": INGESTION_USER_AGENT,
    },
    body: JSON.stringify({
      docType: "USSR_DECISION_MK",
      start: offset,
      pageSize: PAGE_SIZE,
      searchFilter: {
        filterNameValue: [
          {
            type: "DATE_RANGE",
            fieldName: "mkDateOfDecision",
            fieldValue: {
              FROM: `${year}-01-01`,
              TO: `${year}-12-31`,
            },
          },
        ],
      },
      facetFilter: { facetFilterNameValue: [] },
      facets: [],
      fieldsToReturn: FIELDS_TO_RETURN,
      clustering: false,
    }),
    signal,
    timeoutMs: ADAPTER_TIMEOUT.REQUEST,
  });

  if (!response.ok) {
    // A 401/403 here means the court put the endpoint back behind
    // authentication. There is no credential to refresh — the adapter
    // needs a real one — so surface it rather than retrying blind.
    throw new FetchBoundaryError({
      url: SEARCH_URL,
      status: response.status,
      statusText: response.statusText,
      message: `SK ÚS search failed: ${response.status}`,
    });
  }

  if (response.status === 204) {
    return null;
  }

  const data = await response.json();
  if (!isSearchResponse(data)) {
    const preview = JSON.stringify(data).slice(0, 200);
    panic(`SK ÚS search returned an invalid payload: ${preview}`);
  }

  return data;
};

// ── Adapter ──────────────────────────────────────────────

export const skUsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_US,
  name: "ustavnysud.sk",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 500,
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,

  async getTotalCount(_signal) {
    return await Promise.resolve(null);
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const { year, offset } = parseCursor(cursor);
        const currentYear = new Date().getFullYear();

        let data: SearchResponse | null;
        try {
          data = await executeSearch(year, offset, signal);
        } catch (error) {
          if (error instanceof DOMException) {
            throw error;
          }
          // A 401/403 is the court putting the endpoint back behind
          // authentication, not a flaky request. There is no credential
          // to refresh, so an identical second attempt can only fail the
          // same way: surface it instead of doubling the traffic.
          if (isAuthFailure(error)) {
            throw error;
          }
          // One retry: the DMS search is intermittently flaky under
          // load. An abort is not retried (handled above).
          data = await executeSearch(year, offset, signal);
        }

        // 204 / empty search for this year window.
        // Advance to next year if available.
        if (!data || data.documents.length === 0) {
          if (year < currentYear) {
            // Move to next year
            return {
              decisions: [],
              nextCursor: encodeCursor({ year: year + 1, offset: 0 }),
            };
          }
          // Current year exhausted; park at current offset
          return {
            decisions: [],
            nextCursor: encodeCursor({ year, offset }),
          };
        }

        const decisions: IngestionResult[] = [];

        for (const doc of data.documents) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- sequential per-document PDF download/parse, rate-limited via Bun.sleep below
            const result = await parseDocument(doc, signal);
            if (result) {
              decisions.push(result);
            }
          } catch (error) {
            if (error instanceof DOMException) {
              throw error;
            }
            continue;
          }

          // Rate limit between PDF downloads
          // oxlint-disable-next-line no-await-in-loop -- deliberate crawl delay between sequential PDF downloads from the court server
          await Bun.sleep(300);
        }

        const nextOffset = offset + PAGE_SIZE;
        const hasMore =
          data.documents.length >= PAGE_SIZE && nextOffset < data.numFound;

        if (hasMore) {
          return {
            decisions,
            nextCursor: encodeCursor({ year, offset: nextOffset }),
          };
        }

        // Year exhausted — advance to next year or park
        if (year < currentYear) {
          return {
            decisions,
            nextCursor: encodeCursor({ year: year + 1, offset: 0 }),
          };
        }

        // Current year exhausted; park at current offset so the
        // pipeline's stagnation detection stops the cycle cleanly
        // instead of rewinding and reprocessing already-seen pages.
        return {
          decisions,
          nextCursor: encodeCursor({ year, offset }),
        };
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_US, cursor),
    });
  },
};
