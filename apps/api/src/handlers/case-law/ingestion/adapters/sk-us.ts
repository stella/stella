/**
 * Slovak Constitutional Court (Ústavný súd SR) adapter.
 *
 * Fetches decisions from the ustavnysud.sk REST API.
 * The API is a Liferay DXP headless service requiring
 * OAuth2 client_credentials authentication.
 *
 * Search: POST /o/v1/dms/search
 * Auth:   POST /o/oauth2/token (client_credentials)
 * PDFs:   GET  /docDownload/{documentId} (no auth)
 *
 * The client_id and client_secret are public credentials
 * embedded in the court's JavaScript bundle for anonymous
 * browser access. ~52,000 decisions from 1993 to present.
 *
 * Cursor format: offset number as string (e.g. "0", "10").
 */

import { Result } from "better-result";

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
import { isRecord } from "@/api/lib/type-guards";

// ── Constants ─────────────────────────────────────────────

const BASE_URL = "https://www.ustavnysud.sk";
const SEARCH_URL = `${BASE_URL}/o/v1/dms/search`;
const TOKEN_URL = `${BASE_URL}/o/oauth2/token`;
const DOC_DOWNLOAD_URL = `${BASE_URL}/docDownload`;

/**
 * Public OAuth2 client credentials embedded in the court's
 * JavaScript bundle. These are shipped to every browser
 * that visits the search page — not secret API keys.
 * Configurable via env vars for rotation without code change.
 */
// gitleaks:allow -- public credentials from court's JS bundle
const CLIENT_ID =
  process.env.SK_US_CLIENT_ID ?? "id-fab237c0-55ad-9fdf-9b9f-976eef3cbd9";
// gitleaks:allow -- public credentials from court's JS bundle
const CLIENT_SECRET =
  process.env.SK_US_CLIENT_SECRET ??
  "secret-579e7b79-b5b2-b22d-c1b3-204386e0447e";

const PAGE_SIZE = 10;

/**
 * Fields to request from the search API. Empty array
 * returns all fields including the built-in `documentId`.
 * Listing specific fields causes `documentId` to be
 * omitted (Liferay DMS quirk), so we request everything.
 */
const FIELDS_TO_RETURN: string[] = [];

// ── OAuth2 token management ──────────────────────────────

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | null = null;

const invalidateToken = (): void => {
  cachedToken = null;
};

const getToken = async (signal?: AbortSignal): Promise<string> => {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": INGESTION_USER_AGENT,
    },
    body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST)])
      : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
  });

  if (!response.ok) {
    throw new Error(`SK ÚS OAuth2 token failed: ${response.status}`);
  }

  const data = await response.json();
  if (!isTokenResponse(data)) {
    throw new Error("SK ÚS OAuth2 token returned an invalid payload");
  }

  // Cache with 30s safety margin
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };

  return data.access_token;
};

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

const isTokenResponse = (
  value: unknown,
): value is { access_token: string; expires_in: number } =>
  isRecord(value) &&
  typeof value.access_token === "string" &&
  typeof value.expires_in === "number";

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
  Array.isArray(value.documents) &&
  value.documents.every(isRecord) &&
  typeof value.numFound === "number";

// ── Date parsing ─────────────────────────────────────────

/**
 * Parse the API's date format "MM/DD/YYYY HH:mm:ss" to
 * ISO "YYYY-MM-DD".
 */
const parseApiDate = (raw: string | undefined): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return `${match[3]}-${match[1]}-${match[2]}`;
};

// ── PDF download ─────────────────────────────────────────

const fetchPdfBytes = async (
  documentId: string,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> => {
  try {
    const response = await fetch(`${DOC_DOWNLOAD_URL}/${documentId}`, {
      headers: { "User-Agent": INGESTION_USER_AGENT },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
};

// ── Item parsing ─────────────────────────────────────────

const dedupe = (arr: string[] | undefined): string[] =>
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

  // oxlint-disable-next-line no-untyped-updates/no-untyped-updates -- AST container
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
      challengedLegislation: Array.isArray(doc.mkComplainedLegalRegulation)
        ? doc.mkComplainedLegalRegulation
        : doc.mkComplainedLegalRegulation
          ? [doc.mkComplainedLegalRegulation]
          : undefined,
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

// ── Adapter ──────────────────────────────────────────────

export const skUsAdapter: SourceAdapter = {
  key: ADAPTER_KEYS.SK_US,
  name: "ustavnysud.sk",
  country: "SVK",
  language: "sk",
  minRequestIntervalMs: 500,
  pageTimeoutMs: 120_000,
  maxSyncPages: 10,

  // eslint-disable-next-line require-await -- no async work needed
  async getTotalCount(_signal) {
    return null;
  },

  async fetchPage(cursor, _config, signal) {
    return await Result.tryPromise({
      try: async () => {
        const offset = cursor ? Number.parseInt(cursor, 10) : 0;

        const executeSearch = async (): Promise<SearchResponse | null> => {
          const token = await getToken(signal);

          const response = await fetch(SEARCH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
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
                      FROM: null,
                      TO: new Date().toISOString().split("T")[0],
                    },
                  },
                ],
              },
              facetFilter: { facetFilterNameValue: [] },
              facets: [],
              fieldsToReturn: FIELDS_TO_RETURN,
              clustering: false,
            }),
            signal: signal
              ? AbortSignal.any([
                  signal,
                  AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
                ])
              : AbortSignal.timeout(ADAPTER_TIMEOUT.REQUEST),
          });

          if (!response.ok) {
            // 401/403 indicate token rejection; clear cache
            // so the retry gets a fresh token.
            if (response.status === 401 || response.status === 403) {
              invalidateToken();
            }
            throw new Error(`SK ÚS search failed: ${response.status}`);
          }

          // 204 = no results (empty search)
          if (response.status === 204) {
            return null;
          }

          const data = await response.json();
          if (!isSearchResponse(data)) {
            // Liferay sometimes returns 200 with an error body
            // when the token is stale. Invalidate and include a
            // preview so the logs show what actually came back.
            invalidateToken();
            const preview = JSON.stringify(data).slice(0, 200);
            throw new Error(
              `SK ÚS search returned an invalid payload: ${preview}`,
            );
          }

          return data;
        };

        let data: SearchResponse | null;
        try {
          data = await executeSearch();
        } catch (error) {
          if (error instanceof DOMException) {
            throw error; // Respect abort/timeout signals
          }
          // Retry once with a fresh token in case the first
          // attempt failed due to a stale/expired token.
          data = await executeSearch();
        }

        // 204 / empty search — park at current offset
        if (!data) {
          return { decisions: [], nextCursor: String(offset) };
        }
        const decisions: IngestionResult[] = [];

        for (const doc of data.documents) {
          try {
            const result = await parseDocument(doc, signal);
            if (result) {
              decisions.push(result);
            }
          } catch (error) {
            if (error instanceof DOMException) {
              throw error; // Re-throw abort/timeout
            }
            continue; // Skip failed items
          }

          // Rate limit between PDF downloads
          await Bun.sleep(300);
        }

        const nextOffset = offset + PAGE_SIZE;
        const hasMore =
          data.documents.length >= PAGE_SIZE && nextOffset < data.numFound;
        // Park one page back when exhausted; never null (null
        // restarts from offset 0).
        const nextCursor = hasMore
          ? String(nextOffset)
          : String(Math.max(0, offset));

        return { decisions, nextCursor };
      },
      catch: adapterCatch(ADAPTER_KEYS.SK_US, cursor),
    });
  },
};
