/**
 * Supremo Tribunal Federal (Brazil) adapter: acórdãos and decisões
 * monocráticas from the court's jurisprudence search.
 *
 * jurisprudencia.stf.jus.br answers Elasticsearch DSL at one endpoint and
 * wraps the engine's answer in `result`. Four of its properties decide the
 * design:
 *
 * **`from + size` stops at 10 000 and a query returns at most 250 records.**
 * The crawl therefore never pages by offset: it pages with `search_after`
 * over a total order. `[julgamento_data, processo_numero]` is not unique, and
 * `dg_unique` is the tiebreaker that makes it one. `_id` and the `.keyword`
 * sorts are refused by the publisher.
 *
 * **Every record carries `dg_atualizado_em`, the time the publisher last
 * wrote it.** That is what makes a set fixed. The historical sweep pages each
 * month of judgment dates restricted to records written before a boundary
 * day taken once when the sweep starts. A record written after the boundary
 * leaves the swept set, and a new record never enters it, so the set can only
 * shrink while `search_after` walks it: nothing can slide past the cursor
 * (rule 19). Whatever left the set or arrived after the boundary is the
 * frontier's, which begins at the boundary day itself.
 *
 * **`hits.total.value` is exact** (`track_total_hits`). Because the swept set
 * only shrinks, every record still in it when a month's walk ends was in it
 * throughout and was passed by the cursor: the walk must have seen at least
 * as many records as the final count states. Fewer is a skipped record, and
 * the month restarts (rule 14). The same check runs over a frontier day and
 * is telemetry only there; completeness past the frontier is the
 * reconciliation ledger's.
 *
 * **The frontier is a day of `dg_atualizado_em`, not a window.** A day is
 * collected once, after it has closed with a day of margin: the publisher
 * writes in Brasília time, which the engine reads as UTC, and indexes in
 * nightly batches. A cycle on which no day closed sends no request and
 * returns the cursor it was given.
 *
 * Reconciliation slices are a month of judgment dates within one base
 * (`2020-03-acordaos`, `2020-03-decisoes`): a busy month of decisões alone
 * approaches 7 300 records, so the two bases together could pass the offset
 * ceiling that slice listing pages within. The 209 records without a judgment
 * date are the `0000-00-<base>` slices. The coverage count is the slice's
 * `hits.total.value`; a listing whose pages do not add up to it is refused.
 *
 * Full text: the record's own `inteiro_teor_texto` (acórdãos) or
 * `decisao_texto` (decisões). Where it is absent, which is most acórdãos
 * judged before 2010, the PDF behind `inteiro_teor_url` is read through an
 * exact origin allowlist (rule 21). Acórdão PDFs redirect from
 * portal.stf.jus.br to redir.stf.jus.br, which has answered automated clients
 * with an AWS WAF challenge (HTTP 202, `x-amzn-waf-action: challenge`) since
 * it was first probed; that is stored as a typed reason on a listing-only row
 * (rule 20), never as a document.
 *
 * Súmulas share the endpoint but not the record shape (no process number, a
 * different identity spelling) and are not decisions of a case; they are out
 * of this adapter. Informativos are bulletins, not decisions.
 */
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  DECISION_DOCKET_GRAMMARS,
  formatDecisionDocket,
} from "@stll/api-contract/decision-docket-grammar";
import { sha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceTotalCount,
  SyncPage,
  UnreadListedItem,
  UnreadOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readBodyBytes,
  readPublisher,
  readPublisherRedirect,
  readPublisherText,
  unreadPublisherError,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { publisherTarget } from "@/api/handlers/case-law/ingestion/adapters/publisher-target";
import { adapterCatch } from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  parseBrStfPdf,
  parseBrStfText,
} from "@/api/handlers/case-law/ingestion/parsers/br-stf";
import type {
  BrStfDocumentIdentity,
  BrStfParsedDocument,
  BrStfTextField,
} from "@/api/handlers/case-law/ingestion/parsers/br-stf";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  presentTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  READ_OUTCOME_METADATA_KEY,
  type ReadOutcome,
  type StoredReadOutcome,
} from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

const KEY = ADAPTER_KEYS.BR_STF;
const MANIFEST = ADAPTER_MANIFESTS[KEY];

const SEARCH_URL = "https://jurisprudencia.stf.jus.br/api/search/search";
const DECISION_PAGE_ORIGIN = "https://jurisprudencia.stf.jus.br";
const PORTAL_ORIGIN = "https://portal.stf.jus.br";
const PORTAL_HOST = "portal.stf.jus.br";
const PAGINATOR_ORIGIN = "https://redir.stf.jus.br";
const PAGINATOR_PATH = "/paginadorpub/paginador.jsp";

/** The bases this adapter reads, in the order their slices sort. */
export const BR_STF_BASES = ["acordaos", "decisoes"] as const;
export type BrStfBase = (typeof BR_STF_BASES)[number];

const isBrStfBase = (value: unknown): value is BrStfBase =>
  BR_STF_BASES.some((base) => base === value);

/** The decision type each base holds, as the court names it. */
const DECISION_TYPE_BY_BASE = {
  acordaos: "acórdão",
  decisoes: "decisão monocrática",
} as const satisfies Record<BrStfBase, string>;

/** The field that carries the decision's own text in each base. */
const TEXT_FIELD_BY_BASE = {
  acordaos: "inteiro_teor_texto",
  decisoes: "decisao_texto",
} as const satisfies Record<BrStfBase, BrStfTextField>;

/**
 * Records one crawl page lists. Each may cost up to two PDF requests behind
 * the same gate, so a page is at most 1 + 2 × this many requests; the page
 * timeout below is sized against that at the gate's interval.
 */
const CRAWL_PAGE_SIZE = 20;
const CRAWL_PAGE_TIMEOUT_MS = 4 * 60_000;

/** Records one reconciliation page lists; the publisher answers at most 250. */
const SLICE_PAGE_SIZE = 100;

/** The deepest `from + size` the engine serves. */
const OFFSET_CEILING = 10_000;

/** Empty months or days one `fetchPage` steps over before it banks progress. */
const MAX_EMPTY_WINDOWS_PER_PAGE = 24;

/**
 * Days a frontier day waits after it ends before it is collected. The
 * publisher stamps Brasília wall time, read as UTC, and writes in batches.
 */
const FRONTIER_LAG_DAYS = 1;

const UNDATED_WINDOW = "undated";
const UNDATED_SLICE_MONTH = "0000-00";
const FIRST_MONTH = MANIFEST.dateRange.fromInclusive.slice(0, 7);

const BASES_FILTER = { terms: { base: [...BR_STF_BASES] } } as const;
const PROCESS_NUMBER_SORT = {
  processo_numero: { order: "asc", missing: 0 },
} as const;
const DATED_SORT = [
  { julgamento_data: "asc" },
  PROCESS_NUMBER_SORT,
  { dg_unique: "asc" },
] as const;
const UNDATED_SORT = [PROCESS_NUMBER_SORT, { dg_unique: "asc" }] as const;
const FRONTIER_SORT = [
  { dg_atualizado_em: "asc" },
  { dg_unique: "asc" },
] as const;

// ── Publisher boundary ───────────────────────────────────

/** A `search_after` key as the engine returns it in a hit's `sort`. */
type SortKey = readonly (number | string)[];

const sortKeySchema = v.pipe(
  v.array(
    v.union([
      v.pipe(v.number(), v.safeInteger()),
      v.pipe(v.string(), v.minLength(1)),
    ]),
  ),
  v.minLength(2),
  v.maxLength(3),
);

/** One record of a search answer, and where the walk resumes after it. */
export type BrStfListedHit = {
  /** The hit as stored: everything the engine answered but the query's own coordinates. */
  hit: Record<string, unknown>;
  sort: SortKey | undefined;
};

type BrStfSearchAnswer = {
  total: number;
  hits: BrStfListedHit[];
};

const searchAnswerSchema = v.looseObject({
  result: v.looseObject({
    hits: v.looseObject({
      total: v.looseObject({ value: v.number(), relation: v.literal("eq") }),
      hits: v.array(
        v.looseObject({ _source: v.record(v.string(), v.unknown()) }),
      ),
    }),
  }),
});

/**
 * The hit as stored. `sort` and `_score` are the query's coordinates for the
 * record, not the record: the sweep, the frontier and a slice listing sort
 * differently, and keeping them would rewrite every row each time a different
 * walk observed it.
 */
const storedHitOf = (hit: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(hit).filter(([key]) => key !== "sort" && key !== "_score"),
  );

/** Read a search answer strictly; anything else is a failure, not an empty page. */
export const readBrStfSearchAnswer = (
  raw: string,
): BrStfSearchAnswer | null => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  const answer = v.safeParse(searchAnswerSchema, parsed);
  if (!answer.success) {
    return null;
  }
  const { hits, total } = answer.output.result.hits;
  return {
    total: total.value,
    hits: hits.map((hit) => {
      const sort = v.safeParse(sortKeySchema, hit["sort"]);
      return {
        hit: storedHitOf(hit),
        sort: sort.success ? sort.output : undefined,
      };
    }),
  };
};

const searchError = (cursor: string | null, message: string) =>
  new AdapterFetchError({
    message: `STF search: ${message}`,
    adapterKey: KEY,
    cursor,
  });

type SearchBody = {
  query: unknown;
  sort?: unknown;
  size: number;
  from?: number;
  search_after?: SortKey;
};

const search = async (
  body: SearchBody,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<BrStfSearchAnswer, AdapterFetchError>> => {
  const target = publisherTarget(KEY, SEARCH_URL);
  if (Result.isError(target)) {
    return panic(target.error.message);
  }
  // A refused search is the source refusing the crawl, not one document; a
  // 429 rejects after this one request (rule 19a).
  const outcome = await readPublisherText(target.value, {
    adapterKey: KEY,
    fetchStage: "listing",
    timeout: { type: "idle", ms: ADAPTER_TIMEOUT.LIST },
    signal,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, track_total_hits: true }),
    redirect: "error",
    refusalScope: "source",
  });
  if (outcome.type !== "present") {
    return Result.err(
      unreadPublisherError({
        outcome,
        message: "STF search could not be read",
        adapterKey: KEY,
        cursor,
      }),
    );
  }
  const answer = readBrStfSearchAnswer(outcome.value);
  return answer === null
    ? Result.err(
        searchError(
          cursor,
          `answered no readable result: ${outcome.value.slice(0, 200)}`,
        ),
      )
    : Result.ok(answer);
};

// ── Document reads ───────────────────────────────────────

/** Why a listed record is stored without its decision text. */
export const BR_STF_DOCUMENT_MISSING = {
  /** The record names no document. */
  NO_DOCUMENT_URL: "no-document-url",
  /** The record's document link is not one of the publisher's document addresses. */
  URL_NOT_ALLOWED: "url-not-allowed",
  /** A redirect led somewhere other than the publisher's document paginator. */
  REDIRECT_NOT_ALLOWED: "redirect-not-allowed",
  /** The document host answered with a bot challenge instead of the file. */
  PUBLISHER_CHALLENGE: "publisher-challenge",
  /** The publisher stated the document does not exist (404 or 410). */
  ABSENT: "absent",
  /** The publisher served something that is not a PDF. */
  NOT_A_PDF: "not-a-pdf",
  /** The PDF could not be read, or holds no text layer. */
  UNREADABLE_PDF: "unreadable-pdf",
} as const;

export type BrStfDocumentMissing =
  (typeof BR_STF_DOCUMENT_MISSING)[keyof typeof BR_STF_DOCUMENT_MISSING];

type DocumentRequest =
  | { type: "direct"; url: string }
  | { type: "redirected"; url: string };

const DIGITS = /^\d{1,20}$/u;
const PROCESS_CLASS = /^[A-Za-z]{1,12}(?:-[A-Za-z]{1,12}){0,4}$/u;
const DOCUMENT_TYPE = /^[A-Z]{1,4}$/u;

const queryOf = (entries: Record<string, string>): string =>
  new URLSearchParams(entries).toString();

/**
 * The document request a record's `inteiro_teor_url` names, rebuilt from its
 * opaque identifiers on the publisher's own origin (rule 21). The records
 * spell the portal with `http:` as often as `https:`; neither scheme nor any
 * other part of the stated URL reaches the request.
 */
export const brStfDocumentRequestOf = (raw: string): DocumentRequest | null => {
  const parsed = URL.parse(raw);
  if (
    parsed === null ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.hostname !== PORTAL_HOST ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }
  const params = parsed.searchParams;
  switch (parsed.pathname) {
    case "/processos/downloadPeca.asp": {
      const id = params.get("id") ?? "";
      return DIGITS.test(id)
        ? {
            type: "direct",
            url: `${PORTAL_ORIGIN}/processos/downloadPeca.asp?${queryOf({ id, ext: ".pdf" })}`,
          }
        : null;
    }
    case "/jurisprudencia/obterInteiroTeor.asp": {
      const document = params.get("idDocumento");
      if (document !== null) {
        return DIGITS.test(document)
          ? {
              type: "redirected",
              url: `${PORTAL_ORIGIN}/jurisprudencia/obterInteiroTeor.asp?${queryOf({ idDocumento: document })}`,
            }
          : null;
      }
      const numero = params.get("numero") ?? "";
      const classe = params.get("classe") ?? "";
      return DIGITS.test(numero) && PROCESS_CLASS.test(classe)
        ? {
            type: "redirected",
            url: `${PORTAL_ORIGIN}/jurisprudencia/obterInteiroTeor.asp?${queryOf({ numero, classe })}`,
          }
        : null;
    }
    default:
      return null;
  }
};

/** The paginator address a portal redirect names, rebuilt, or null. */
export const brStfPaginatorUrlOf = (
  location: string,
  base: string,
): string | null => {
  const parsed = URL.parse(location, base);
  if (
    parsed === null ||
    parsed.origin !== PAGINATOR_ORIGIN ||
    parsed.pathname !== PAGINATOR_PATH
  ) {
    return null;
  }
  const docTP = parsed.searchParams.get("docTP") ?? "";
  const docID = parsed.searchParams.get("docID") ?? "";
  return DOCUMENT_TYPE.test(docTP) && DIGITS.test(docID)
    ? `${PAGINATOR_ORIGIN}${PAGINATOR_PATH}?${queryOf({ docTP, docID })}`
    : null;
};

/** What one record's document read established. */
type DocumentRead =
  | { type: "read"; url: string; bytes: Uint8Array }
  /** Terminal: the row is stored listing-only with this reason. */
  | {
      type: "missing";
      reason: BrStfDocumentMissing;
      url: string | undefined;
      outcome?: StoredReadOutcome | undefined;
    }
  /** The publisher neither served the document nor said it is gone. */
  | { type: "unread"; url: string; outcome: UnreadOutcome };

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46];
const WAF_ACTION_HEADER = "x-amzn-waf-action";
const DOCUMENT_TIMEOUT = { type: "idle", ms: 60_000 } as const;

const documentReadOptions = (signal: AbortSignal | undefined) => ({
  adapterKey: KEY,
  fetchStage: "document" as const,
  expectedContentType: "pdf" as const,
  timeout: DOCUMENT_TIMEOUT,
  signal,
});

const unreadOf = (
  url: string,
  outcome: Exclude<ReadOutcome<unknown>, { type: "present" }>,
): DocumentRead => {
  switch (outcome.type) {
    case "absent":
      return {
        type: "missing",
        reason: BR_STF_DOCUMENT_MISSING.ABSENT,
        url,
        outcome: { type: "absent", evidence: outcome.evidence },
      };
    case "refused":
    case "unavailable":
      return { type: "unread", url, outcome };
    default:
      outcome satisfies never;
      return panic(`Unhandled read outcome: ${JSON.stringify(outcome)}`);
  }
};

/** Read the file a final document address serves. */
const readDocumentAt = async (
  url: string,
  signal: AbortSignal | undefined,
): Promise<DocumentRead> => {
  const target = publisherTarget(KEY, url);
  if (Result.isError(target)) {
    return {
      type: "missing",
      reason: BR_STF_DOCUMENT_MISSING.URL_NOT_ALLOWED,
      url,
    };
  }
  const outcome = await readPublisher(target.value, {
    ...documentReadOptions(signal),
    redirect: "error",
  });
  if (outcome.type !== "present") {
    return unreadOf(url, outcome);
  }
  if (outcome.value.headers.get(WAF_ACTION_HEADER) !== null) {
    await outcome.value.body?.cancel();
    return {
      type: "missing",
      reason: BR_STF_DOCUMENT_MISSING.PUBLISHER_CHALLENGE,
      url,
    };
  }
  const bytes = await readBodyBytes(outcome, signal);
  if (bytes.type !== "present") {
    return unreadOf(url, bytes);
  }
  return PDF_SIGNATURE.every((byte, index) => bytes.value[index] === byte)
    ? { type: "read", url, bytes: bytes.value }
    : { type: "missing", reason: BR_STF_DOCUMENT_MISSING.NOT_A_PDF, url };
};

/**
 * The portal's acórdão address answers with a redirect to the paginator that
 * serves the file. The redirect is read by hand so its target can be held to
 * the paginator origin before anything follows it (rule 21).
 */
const readRedirectedDocument = async (
  url: string,
  signal: AbortSignal | undefined,
): Promise<DocumentRead> => {
  const target = publisherTarget(KEY, url);
  if (Result.isError(target)) {
    return {
      type: "missing",
      reason: BR_STF_DOCUMENT_MISSING.URL_NOT_ALLOWED,
      url,
    };
  }
  const answered = await readPublisherRedirect(target.value, {
    ...documentReadOptions(signal),
    timeout: { type: "headers", ms: ADAPTER_TIMEOUT.REQUEST },
  });
  switch (answered.type) {
    case "redirect":
      break;
    // The portal served something itself rather than pointing at the file.
    case "present":
      await answered.value.body?.cancel();
      return {
        type: "missing",
        reason: BR_STF_DOCUMENT_MISSING.NOT_A_PDF,
        url,
      };
    case "absent":
    case "refused":
    case "unavailable":
      return unreadOf(url, answered);
    default:
      answered satisfies never;
      return panic(`Unhandled portal answer: ${JSON.stringify(answered)}`);
  }
  const { location } = answered;
  const paginator =
    location === null ? null : brStfPaginatorUrlOf(location, target.value);
  return paginator === null
    ? {
        type: "missing",
        reason: BR_STF_DOCUMENT_MISSING.REDIRECT_NOT_ALLOWED,
        url,
      }
    : await readDocumentAt(paginator, signal);
};

const readRecordDocument = async (
  statedUrl: string | undefined,
  signal: AbortSignal | undefined,
): Promise<DocumentRead> => {
  if (statedUrl === undefined) {
    return {
      type: "missing",
      reason: BR_STF_DOCUMENT_MISSING.NO_DOCUMENT_URL,
      url: undefined,
    };
  }
  const request = brStfDocumentRequestOf(statedUrl);
  if (request === null) {
    return {
      type: "missing",
      reason: BR_STF_DOCUMENT_MISSING.URL_NOT_ALLOWED,
      url: statedUrl,
    };
  }
  switch (request.type) {
    case "direct":
      return await readDocumentAt(request.url, signal);
    case "redirected":
      return await readRedirectedDocument(request.url, signal);
    default:
      request satisfies never;
      return panic(`Unhandled document request: ${JSON.stringify(request)}`);
  }
};

// ── The record ───────────────────────────────────────────

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const isoDateOf = (value: unknown): string | undefined => {
  const text = stringOf(value);
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return undefined;
  }
  const date = Result.try({
    try: () => Temporal.PlainDate.from(text, { overflow: "reject" }).toString(),
    catch: String,
  });
  return Result.isOk(date) ? date.value : undefined;
};

/**
 * The record's fields kept out of `metadata.stfRecord`: the decision text,
 * which is the document, and the HTML renderings of fields whose plain text
 * the record also states. Both stay verbatim in the stored hit.
 */
const RECORD_FIELDS_KEPT_IN_RAW = new Set([
  "inteiro_teor_texto",
  "decisao_texto",
  "documental_observacao_html",
  "documental_acordao_mesmo_sentido_lista_html",
  "documental_decisao_mesmo_sentido_lista_html",
]);

const recordMetadataOf = (
  source: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !RECORD_FIELDS_KEPT_IN_RAW.has(key),
    ),
  );

/** How the stored docket was read from the record. */
export const BR_STF_DOCKET_SOURCE = {
  /** The record's title, which names the incident ("ARE 1624555 AgR"). */
  TITLE: "titulo",
  /** The class and number alone, where the grammar refused the title. */
  CLASS_AND_NUMBER: "class-and-number",
  /** No spelling the grammar reads: the title is stored as published. */
  UNRECOGNISED: "unrecognised",
} as const;

type BrStfDocket = {
  caseNumber: string;
  reading: {
    source: (typeof BR_STF_DOCKET_SOURCE)[keyof typeof BR_STF_DOCKET_SOURCE];
    asPublished: string | null;
  };
};

/**
 * The record's docket in the grammar's formatted form. A title the grammar
 * refuses falls back to the class and number the record states apart, and a
 * record whose spellings the grammar reads none of keeps its title verbatim
 * and says so: the refusal is a typed outcome, never a silent default.
 */
export const brStfDocketOf = (
  source: Record<string, unknown>,
): BrStfDocket | undefined => {
  const grammar = DECISION_DOCKET_GRAMMARS.BRA;
  const title =
    stringOf(source["titulo"]) ?? stringOf(source["processo_codigo_completo"]);
  const titled = title === undefined ? null : grammar.parse(title);
  if (titled !== null) {
    return {
      caseNumber: formatDecisionDocket(titled),
      reading: {
        source: BR_STF_DOCKET_SOURCE.TITLE,
        asPublished: title ?? null,
      },
    };
  }
  const className = stringOf(
    source["processo_classe_processual_unificada_classe_sigla"],
  );
  const number = source["processo_numero"];
  const classAndNumber =
    className === undefined || typeof number !== "number"
      ? undefined
      : `${className} ${number}`;
  const classed =
    classAndNumber === undefined ? null : grammar.parse(classAndNumber);
  if (classed !== null) {
    return {
      caseNumber: formatDecisionDocket(classed),
      reading: {
        source: BR_STF_DOCKET_SOURCE.CLASS_AND_NUMBER,
        asPublished: title ?? null,
      },
    };
  }
  const published = title ?? classAndNumber;
  return published === undefined
    ? undefined
    : {
        caseNumber: published,
        reading: {
          source: BR_STF_DOCKET_SOURCE.UNRECOGNISED,
          asPublished: published,
        },
      };
};

/** The judges a record names, in the roles it names them. */
const judgesOf = (source: Record<string, unknown>): DecisionJudgeInput[] => {
  const named: DecisionJudgeInput[] = [];
  const add = (role: DecisionJudgeInput["role"], value: unknown) => {
    const name = stringOf(value)?.trim();
    if (
      name !== undefined &&
      !named.some(
        (judge) => judge.role === role && judge.nameAsPrinted === name,
      )
    ) {
      named.push({ role, nameAsPrinted: name });
    }
  };
  add("rapporteur", source["relator_processo_nome"]);
  add("rapporteur", source["relator_acordao_nome"]);
  add("rapporteur", source["relator_decisao_nome"]);
  add("presiding", source["presidente_nome"]);
  return named;
};

/** The publisher's own page for a record. */
const decisionPageOf = (id: string): string =>
  `${DECISION_PAGE_ORIGIN}/pages/search/${encodeURIComponent(id)}/false`;

/** The decision's text as the record or its document gave it. */
export type BrStfDocument =
  | { type: "inline"; field: BrStfTextField; text: string }
  | { type: "pdf"; url: string; bytes: Uint8Array }
  | {
      type: "missing";
      reason: BrStfDocumentMissing;
      url: string | undefined;
      outcome?: StoredReadOutcome | undefined;
    }
  /** Neither served nor stated gone: the pipeline decides what it costs. */
  | { type: "unread"; url: string; outcome: UnreadOutcome };

/** The inline text a record carries for its base, if any. */
export const brStfInlineTextOf = (
  base: BrStfBase,
  source: Record<string, unknown>,
): BrStfDocument | undefined => {
  const field = TEXT_FIELD_BY_BASE[base];
  const text = stringOf(source[field]);
  return text === undefined ? undefined : { type: "inline", field, text };
};

type AssembleOptions = {
  hit: Record<string, unknown>;
  document: BrStfDocument;
};

type AssembleOutcome =
  | { type: "built"; decision: IngestionResult }
  | { type: "unkeyable"; reason: string };

const parsedDocumentOf = async (
  document: BrStfDocument,
  identity: BrStfDocumentIdentity,
): Promise<
  | { type: "parsed"; parsed: BrStfParsedDocument }
  | { type: "missing"; reason: BrStfDocumentMissing }
  | { type: "none" }
> => {
  switch (document.type) {
    case "inline":
      return {
        type: "parsed",
        parsed: parseBrStfText(document.text, document.field, identity),
      };
    case "pdf": {
      const parsed = await Result.tryPromise({
        try: async () => await parseBrStfPdf(document.bytes, identity),
        catch: String,
      });
      return Result.isOk(parsed) && parsed.value.fulltext.length > 0
        ? { type: "parsed", parsed: parsed.value }
        : { type: "missing", reason: BR_STF_DOCUMENT_MISSING.UNREADABLE_PDF };
    }
    case "missing":
    case "unread":
      return { type: "none" };
    default:
      document satisfies never;
      return panic(`Unhandled STF document: ${JSON.stringify(document)}`);
  }
};

type ParsedDocumentOutcome = Awaited<ReturnType<typeof parsedDocumentOf>>;

type DocumentReadRecord = {
  documentRead: {
    status: "missing" | "unread";
    reason: string;
    url: string | null;
  };
  outcome: StoredReadOutcome | undefined;
};

/**
 * Why a row carries no decision text, as stored: the typed reason, the address
 * it was read from, and the stored read outcome where the reason has one.
 */
const documentReadOf = (
  document: BrStfDocument,
  read: ParsedDocumentOutcome,
): DocumentReadRecord | undefined => {
  switch (document.type) {
    case "inline":
      return undefined;
    case "pdf":
      return read.type === "missing"
        ? {
            documentRead: {
              status: "missing",
              reason: read.reason,
              url: document.url,
            },
            outcome: undefined,
          }
        : undefined;
    case "missing":
      return {
        documentRead: {
          status: "missing",
          reason: document.reason,
          url: document.url ?? null,
        },
        outcome: document.outcome,
      };
    // The stored outcome of an unread document is the pipeline's to write.
    case "unread":
      return {
        documentRead: {
          status: "unread",
          reason: document.outcome.type,
          url: document.url,
        },
        outcome: undefined,
      };
    default:
      document satisfies never;
      return panic(`Unhandled STF document: ${JSON.stringify(document)}`);
  }
};

/**
 * One decision from the responses already in hand. No I/O beyond reading the
 * PDF bytes given: the crawl and the reconciliation walk reach this with the
 * same hit, so neither can key or enrich a row differently from the other.
 */
export const assembleBrStfDecision = async ({
  document,
  hit,
}: AssembleOptions): Promise<AssembleOutcome> => {
  const id = hit["_id"];
  const source = hit["_source"];
  if (typeof id !== "string" || !isPersistableSourceDocumentId(id)) {
    return { type: "unkeyable", reason: "the hit states no persistable _id" };
  }
  if (!isRecord(source) || !isBrStfBase(source["base"])) {
    return {
      type: "unkeyable",
      reason: "the hit's _source names no read base",
    };
  }
  const base = source["base"];
  const docket = brStfDocketOf(source);
  const caseNumber = docket?.caseNumber ?? id;
  const decisionType = DECISION_TYPE_BY_BASE[base];
  const decisionDate = isoDateOf(source["julgamento_data"]);
  const sourceUrl = decisionPageOf(id);
  const statedDocumentUrl = stringOf(source["inteiro_teor_url"]);
  const documentUrl =
    statedDocumentUrl === undefined
      ? undefined
      : brStfDocumentRequestOf(statedDocumentUrl)?.url;
  const court = MANIFEST.publisher;
  const identity: BrStfDocumentIdentity = {
    title: stringOf(source["titulo"]),
    caseNumber,
    court,
    decisionDate,
    decisionType,
    sourceUrl,
    documentUrl,
  };
  const read = await parsedDocumentOf(document, identity);
  const parsed = read.type === "parsed" ? read.parsed : undefined;
  const unreadDocument = documentReadOf(document, read);

  const { sourceRaw, sourceRawObjects } = storedRawOf(hit, document);
  const aliases = aliasesOf(id, source);
  const judges = judgesOf(source);

  return {
    type: "built",
    decision: plainTextIngestionResult({
      caseNumber,
      ...(docket === undefined ? { caseNumberIsPlaceholder: true } : {}),
      sourceDocumentId: id,
      ...(aliases.length === 0 ? {} : { sourceDocumentIdAliases: aliases }),
      court,
      country: MANIFEST.country,
      language: "pt",
      ...(decisionDate === undefined ? {} : { decisionDate }),
      decisionType,
      ...(parsed === undefined
        ? { isListingOnly: true }
        : { fulltext: parsed.fulltext }),
      sourceUrl,
      ...(documentUrl === undefined ? {} : { documentUrl }),
      ...(judges.length === 0 ? {} : { judges }),
      textFields: textFieldsOf(source),
      metadata: checkedDecisionMetadata({
        caseNumber,
        decisionType,
        ...(decisionDate === undefined
          ? {
              decisionDateAvailability: {
                status: "not-published-by-source",
              },
            }
          : { decisionDate }),
        stfRecord: recordMetadataOf(source),
        docketReading: docket?.reading ?? {
          source: BR_STF_DOCKET_SOURCE.UNRECOGNISED,
          asPublished: null,
        },
        // Brazil has no ECLI, and the record states none.
        ecliAvailability: { status: "not_published" },
        ...documentReadMetadataOf(unreadDocument),
      }),
      rawHash: sourceFingerprint({
        sourceRaw,
        ...(sourceRawObjects === undefined ? {} : { sourceRawObjects }),
      }),
      parserVersion: PARSER_VERSIONS[KEY],
      documentAst: parsed?.documentAst ?? EMPTY_AST,
      sourceRaw,
      ...(sourceRawObjects === undefined ? {} : { sourceRawObjects }),
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    }),
  };
};

/**
 * The raw envelope: the hit, and the PDF with where it came from when one was
 * read. Every walk hands its hit in with its own sort coordinates; the row
 * keeps the record alone, so a record read by another walk hashes the same.
 */
const storedRawOf = (hit: Record<string, unknown>, document: BrStfDocument) => {
  const pdf = document.type === "pdf" ? document : undefined;
  const parts: SourceRawParts = {
    hit: JSON.stringify(storedHitOf(hit)),
    ...(pdf === undefined
      ? {}
      : {
          provenance: JSON.stringify({
            document: { url: pdf.url, sha256: sha256Hex(pdf.bytes) },
          }),
        }),
  };
  return {
    sourceRaw: encodeSourceRawEnvelope(parts),
    sourceRawObjects:
      pdf === undefined
        ? undefined
        : { document: { bytes: pdf.bytes, contentType: "application/pdf" } },
  };
};

/** The other exact identity a record states, where it differs from `_id`. */
const aliasesOf = (id: string, source: Record<string, unknown>): string[] => {
  const dgUnique = stringOf(source["dg_unique"]);
  return dgUnique !== undefined &&
    dgUnique !== id &&
    isPersistableSourceDocumentId(dgUnique)
    ? [dgUnique]
    : [];
};

/**
 * The ementa is the court's own syllabus of the judgment; a thesis is the
 * binding statement a repercussão geral judgment fixes.
 */
const textFieldsOf = (source: Record<string, unknown>) => {
  const ementa = stringOf(source["ementa_texto"]);
  const thesis = stringOf(source["documental_tese_texto"]);
  return {
    ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    ...(ementa === undefined ? {} : { headnote: presentTextField(ementa) }),
    ...(thesis === undefined
      ? {}
      : { legalSentence: presentTextField(thesis) }),
  };
};

const documentReadMetadataOf = (record: DocumentReadRecord | undefined) => ({
  ...(record === undefined ? {} : { documentRead: record.documentRead }),
  ...(record?.outcome === undefined
    ? {}
    : { [READ_OUTCOME_METADATA_KEY]: record.outcome }),
});

/** What fetching and assembling one listed hit produced. */
type BuildOutcome =
  | AssembleOutcome
  /** The document was neither served nor stated gone; the pipeline decides. */
  | { type: "unread"; item: UnreadListedItem };

/** Read a hit's document where the record carries no text, then assemble. */
export const buildBrStfDecision = async (
  hit: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BuildOutcome> => {
  const source = hit["_source"];
  const base = isRecord(source) ? source["base"] : undefined;
  if (!isRecord(source) || !isBrStfBase(base)) {
    return {
      type: "unkeyable",
      reason: "the hit's _source names no read base",
    };
  }
  const inline = brStfInlineTextOf(base, source);
  if (inline !== undefined) {
    return await assembleBrStfDecision({ hit, document: inline });
  }
  const read = await readRecordDocument(
    stringOf(source["inteiro_teor_url"]),
    signal,
  );
  switch (read.type) {
    case "read":
      return await assembleBrStfDecision({
        hit,
        document: { type: "pdf", url: read.url, bytes: read.bytes },
      });
    case "missing":
      return await assembleBrStfDecision({ hit, document: read });
    case "unread": {
      const listed = await assembleBrStfDecision({ hit, document: read });
      if (listed.type === "unkeyable") {
        return listed;
      }
      const { decision } = listed;
      const sourceDocumentId =
        decision.sourceDocumentId ?? panic("an assembled STF row has an id");
      return {
        type: "unread",
        item: {
          listing: { ...decision, sourceDocumentId, isListingOnly: true },
          outcome: read.outcome,
        },
      };
    }
    default:
      read satisfies never;
      return panic(`Unhandled STF document read: ${JSON.stringify(read)}`);
  }
};

// ── Crawl cursor ─────────────────────────────────────────

const CURSOR_VERSION = 1;

/**
 * Where the crawl is.
 *
 * `boundary` and `frontier` are UTC days of `dg_atualizado_em`: the sweep
 * holds records written before `boundary`, and the frontier has collected
 * every day before `frontier`. `seen` counts the records the current window's
 * walk has passed, which is what the window's final count is checked against.
 */
export type BrStfCursor =
  | {
      v: typeof CURSOR_VERSION;
      phase: "sweep";
      boundary: string;
      /** `YYYY-MM` of judgment dates, or `undated`. */
      window: string;
      after?: SortKey | undefined;
      seen: number;
    }
  | {
      v: typeof CURSOR_VERSION;
      phase: "frontier";
      frontier: string;
      after?: SortKey | undefined;
      seen: number;
    };

const isoDay = v.pipe(v.string(), v.isoDate());
const cursorSchema = v.variant("phase", [
  v.strictObject({
    v: v.literal(CURSOR_VERSION),
    phase: v.literal("sweep"),
    boundary: isoDay,
    window: v.union([
      v.pipe(v.string(), v.regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)),
      v.literal(UNDATED_WINDOW),
    ]),
    after: v.optional(sortKeySchema),
    seen: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.strictObject({
    v: v.literal(CURSOR_VERSION),
    phase: v.literal("frontier"),
    frontier: isoDay,
    after: v.optional(sortKeySchema),
    seen: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
]);

export const encodeBrStfCursor = (cursor: BrStfCursor): string =>
  JSON.stringify(cursor);

const todayUtc = (now: Temporal.Instant): Temporal.PlainDate =>
  now.toZonedDateTimeISO("UTC").toPlainDate();

/**
 * The cursor a crawl starts from: the first month, with the boundary the day
 * before today so the still-live day is the frontier's.
 */
export const initialBrStfCursor = (now: Temporal.Instant): BrStfCursor => ({
  v: CURSOR_VERSION,
  phase: "sweep",
  boundary: todayUtc(now).subtract({ days: 1 }).toString(),
  window: FIRST_MONTH,
  seen: 0,
});

// A cursor this adapter did not write is refused: restarting would re-fetch
// the whole collection.
export const parseBrStfCursor = (
  cursor: string | null,
  now: Temporal.Instant,
): Result<BrStfCursor, AdapterFetchError> =>
  cursor === null
    ? Result.ok(initialBrStfCursor(now))
    : Result.try({
        try: (): BrStfCursor => v.parse(cursorSchema, JSON.parse(cursor)),
        catch: adapterCatch(KEY, cursor),
      });

const nextMonth = (month: string): string =>
  Temporal.PlainYearMonth.from(month).add({ months: 1 }).toString();

/** The sweep window after `window`, or null once the undated records are done. */
const nextSweepWindow = (window: string, boundary: string): string | null => {
  if (window === UNDATED_WINDOW) {
    return null;
  }
  const next = nextMonth(window);
  return next > boundary.slice(0, 7) ? UNDATED_WINDOW : next;
};

const updatedBefore = (day: string) => ({
  range: { dg_atualizado_em: { lt: `${day}T00:00:00` } },
});

const sweepQuery = (window: string, boundary: string): SearchBody => {
  if (window === UNDATED_WINDOW) {
    return {
      query: {
        bool: {
          filter: [BASES_FILTER, updatedBefore(boundary)],
          must_not: [{ exists: { field: "julgamento_data" } }],
        },
      },
      sort: UNDATED_SORT,
      size: CRAWL_PAGE_SIZE,
    };
  }
  return {
    query: {
      bool: {
        filter: [
          BASES_FILTER,
          {
            range: {
              julgamento_data: {
                gte: `${window}-01`,
                lt: `${nextMonth(window)}-01`,
              },
            },
          },
          updatedBefore(boundary),
        ],
      },
    },
    sort: DATED_SORT,
    size: CRAWL_PAGE_SIZE,
  };
};

const frontierQuery = (day: string): SearchBody => ({
  query: {
    bool: {
      filter: [
        BASES_FILTER,
        {
          range: {
            dg_atualizado_em: {
              gte: `${day}T00:00:00`,
              lt: `${Temporal.PlainDate.from(day).add({ days: 1 }).toString()}T00:00:00`,
            },
          },
        },
      ],
    },
  },
  sort: FRONTIER_SORT,
  size: CRAWL_PAGE_SIZE,
});

/** Whether a frontier day has closed, with the lag the publisher's clock needs. */
export const brStfFrontierDayClosed = (
  day: string,
  now: Temporal.Instant,
): boolean =>
  Temporal.PlainDate.compare(
    Temporal.PlainDate.from(day).add({ days: 1 + FRONTIER_LAG_DAYS }),
    todayUtc(now),
  ) <= 0;

type Collected = Pick<
  SyncPage,
  "decisions" | "itemBuildFailures" | "unreadItems"
>;

const collectHits = async (
  hits: readonly BrStfListedHit[],
  signal: AbortSignal | undefined,
): Promise<Collected> => {
  const decisions: IngestionResult[] = [];
  const unreadItems: UnreadListedItem[] = [];
  let itemBuildFailures = 0;
  for (const { hit } of hits) {
    const captured = await buildPlainTextItem({
      adapterKey: KEY,
      rawListing: JSON.stringify(hit),
      decisionOf: (outcome) => {
        switch (outcome.type) {
          case "built":
            return outcome.decision;
          case "unread":
            return outcome.item.listing;
          case "unkeyable":
            return undefined;
          default:
            outcome satisfies never;
            return panic("Unhandled STF build outcome");
        }
      },
      build: async () => await buildBrStfDecision(hit, signal),
    });
    if (captured.type === "item_build_failed") {
      itemBuildFailures += 1;
      decisions.push(captured.decision);
      continue;
    }
    const built = captured.value;
    switch (built.type) {
      case "built":
        decisions.push(built.decision);
        break;
      case "unread":
        unreadItems.push(built.item);
        break;
      case "unkeyable":
        // ES always states `_id`; a hit without one is a contract change,
        // reported rather than stored under an invented identity.
        logger.warn("case_law.ingestion.br_stf_unkeyable_hit", {
          adapterKey: KEY,
          reason: built.reason,
        });
        break;
      default:
        built satisfies never;
        panic("Unhandled STF build outcome");
    }
  }
  return {
    decisions,
    ...(itemBuildFailures === 0
      ? {}
      : {
          itemBuildFailures: {
            type: "item_build_failed" as const,
            count: itemBuildFailures,
          },
        }),
    ...(unreadItems.length === 0 ? {} : { unreadItems }),
  };
};

type WindowStep =
  | { type: "page"; hits: BrStfListedHit[]; after: SortKey }
  | { type: "end"; hits: BrStfListedHit[]; total: number; seen: number };

/**
 * One request inside a window: a full page continues after its last hit, a
 * short page ends the window. A full page whose last hit carries no sort key
 * cannot be continued from, which is a failure, never an ending (rule 14).
 */
const stepWindow = async ({
  body,
  after,
  seen,
  cursor,
  signal,
}: {
  body: SearchBody;
  after: SortKey | undefined;
  seen: number;
  cursor: string;
  signal: AbortSignal | undefined;
}): Promise<Result<WindowStep, AdapterFetchError>> => {
  const answer = await search(
    after === undefined ? body : { ...body, search_after: after },
    cursor,
    signal,
  );
  if (Result.isError(answer)) {
    return answer;
  }
  const { hits, total } = answer.value;
  if (hits.length < body.size) {
    return Result.ok({ type: "end", hits, total, seen: seen + hits.length });
  }
  const last = hits.at(-1)?.sort;
  return last === undefined
    ? Result.err(
        searchError(cursor, "a full page ended on a hit with no sort key"),
      )
    : Result.ok({ type: "page", hits, after: last });
};

const sweepPage = async (
  start: Extract<BrStfCursor, { phase: "sweep" }>,
  signal: AbortSignal | undefined,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  let position = start;
  for (let step = 0; step < MAX_EMPTY_WINDOWS_PER_PAGE; step += 1) {
    const cursor = encodeBrStfCursor(position);
    const stepped = await stepWindow({
      body: sweepQuery(position.window, position.boundary),
      after: position.after,
      seen: position.seen,
      cursor,
      signal,
    });
    if (Result.isError(stepped)) {
      return stepped;
    }
    const outcome = stepped.value;
    if (outcome.type === "page") {
      return Result.ok({
        ...(await collectHits(outcome.hits, signal)),
        nextCursor: encodeBrStfCursor({
          ...position,
          after: outcome.after,
          seen: position.seen + outcome.hits.length,
        }),
        sourceUrl: SEARCH_URL,
      });
    }
    // The swept set only shrinks, so every record still in it was passed:
    // fewer seen than counted is a skipped record, and the month is walked
    // again from its start.
    const next: BrStfCursor =
      outcome.seen < outcome.total
        ? {
            v: CURSOR_VERSION,
            phase: "sweep",
            boundary: position.boundary,
            window: position.window,
            seen: 0,
          }
        : nextSweepPosition(position);
    if (outcome.seen < outcome.total) {
      logger.warn("case_law.ingestion.br_stf_window_short", {
        adapterKey: KEY,
        window: position.window,
        reported: outcome.total,
        collected: outcome.seen,
        action: "restart",
      });
    }
    if (outcome.hits.length > 0 || next.phase !== "sweep" || signal?.aborted) {
      return Result.ok({
        ...(await collectHits(outcome.hits, signal)),
        nextCursor: encodeBrStfCursor(next),
        sourceUrl: SEARCH_URL,
      });
    }
    position = next;
  }
  return Result.ok({
    decisions: [],
    nextCursor: encodeBrStfCursor(position),
    sourceUrl: SEARCH_URL,
  });
};

const nextSweepPosition = (
  position: Extract<BrStfCursor, { phase: "sweep" }>,
): BrStfCursor => {
  const window = nextSweepWindow(position.window, position.boundary);
  return window === null
    ? {
        v: CURSOR_VERSION,
        phase: "frontier",
        frontier: position.boundary,
        seen: 0,
      }
    : {
        v: CURSOR_VERSION,
        phase: "sweep",
        boundary: position.boundary,
        window,
        seen: 0,
      };
};

const frontierPage = async (
  start: Extract<BrStfCursor, { phase: "frontier" }>,
  now: Temporal.Instant,
  signal: AbortSignal | undefined,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  let position = start;
  for (let step = 0; step < MAX_EMPTY_WINDOWS_PER_PAGE; step += 1) {
    // A day still open costs nothing: the cursor comes back as it was given.
    if (!brStfFrontierDayClosed(position.frontier, now)) {
      return Result.ok({
        decisions: [],
        nextCursor: encodeBrStfCursor(position),
      });
    }
    const cursor = encodeBrStfCursor(position);
    const stepped = await stepWindow({
      body: frontierQuery(position.frontier),
      after: position.after,
      seen: position.seen,
      cursor,
      signal,
    });
    if (Result.isError(stepped)) {
      return stepped;
    }
    const outcome = stepped.value;
    if (outcome.type === "page") {
      return Result.ok({
        ...(await collectHits(outcome.hits, signal)),
        nextCursor: encodeBrStfCursor({
          ...position,
          after: outcome.after,
          seen: position.seen + outcome.hits.length,
        }),
        sourceUrl: SEARCH_URL,
      });
    }
    // Past the sweep, completeness is the reconciliation ledger's: a short
    // day is reported and the frontier moves on (rule 19).
    if (outcome.seen < outcome.total) {
      logger.warn("case_law.ingestion.br_stf_window_short", {
        adapterKey: KEY,
        window: position.frontier,
        reported: outcome.total,
        collected: outcome.seen,
        action: "advance",
      });
    }
    const next: BrStfCursor = {
      v: CURSOR_VERSION,
      phase: "frontier",
      frontier: Temporal.PlainDate.from(position.frontier)
        .add({ days: 1 })
        .toString(),
      seen: 0,
    };
    if (outcome.hits.length > 0 || signal?.aborted) {
      return Result.ok({
        ...(await collectHits(outcome.hits, signal)),
        nextCursor: encodeBrStfCursor(next),
        sourceUrl: SEARCH_URL,
      });
    }
    position = next;
  }
  return Result.ok({
    decisions: [],
    nextCursor: encodeBrStfCursor(position),
  });
};

/** One crawl page at `now`; the adapter passes the wall clock. */
export const fetchBrStfPage = async (
  cursor: string | null,
  now: Temporal.Instant,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const position = parseBrStfCursor(cursor, now);
  if (Result.isError(position)) {
    return position;
  }
  switch (position.value.phase) {
    case "sweep":
      return await sweepPage(position.value, signal);
    case "frontier":
      return await frontierPage(position.value, now, signal);
    default:
      position.value satisfies never;
      return panic(`Unhandled STF cursor: ${String(cursor)}`);
  }
};

// ── Reconciliation ───────────────────────────────────────

const SLICE_PATTERN = /^(?<month>\d{4}-\d{2})-(?<base>acordaos|decisoes)$/u;

export const brStfSlice = (month: string, base: BrStfBase): string =>
  `${month}-${base}`;

export const parseBrStfSlice = (
  slice: string,
): { month: string; base: BrStfBase } | null => {
  const groups = SLICE_PATTERN.exec(slice)?.groups;
  const month = groups?.["month"];
  const base = groups?.["base"];
  if (month === undefined || !isBrStfBase(base)) {
    return null;
  }
  if (month === UNDATED_SLICE_MONTH) {
    return { month, base };
  }
  const valid = Result.try({
    try: () => Temporal.PlainYearMonth.from(month).toString() === month,
    catch: () => false,
  }).unwrapOr(false);
  return valid && month >= FIRST_MONTH ? { month, base } : null;
};

const FIRST_SLICE = brStfSlice(UNDATED_SLICE_MONTH, "acordaos");

const sliceOf = (now: Date): string =>
  brStfSlice(
    Temporal.Instant.fromEpochMilliseconds(now.getTime())
      .toZonedDateTimeISO("UTC")
      .toPlainDate()
      .toString()
      .slice(0, 7),
    "decisoes",
  );

const nextSlice = (slice: string): string | null => {
  const parsed = parseBrStfSlice(slice);
  if (parsed === null) {
    return null;
  }
  if (parsed.base === "acordaos") {
    return brStfSlice(parsed.month, "decisoes");
  }
  const month =
    parsed.month === UNDATED_SLICE_MONTH
      ? FIRST_MONTH
      : nextMonth(parsed.month);
  const next = brStfSlice(month, "acordaos");
  return next > sliceOf(new Date()) ? null : next;
};

const previousSlice = (slice: string): string | null => {
  const parsed = parseBrStfSlice(slice);
  if (parsed === null) {
    return null;
  }
  if (parsed.base === "decisoes") {
    return brStfSlice(parsed.month, "acordaos");
  }
  if (parsed.month === UNDATED_SLICE_MONTH) {
    return null;
  }
  return parsed.month === FIRST_MONTH
    ? brStfSlice(UNDATED_SLICE_MONTH, "decisoes")
    : brStfSlice(
        Temporal.PlainYearMonth.from(parsed.month)
          .subtract({ months: 1 })
          .toString(),
        "decisoes",
      );
};

/** Three months of both bases: acórdãos are published weeks after judgment. */
const TIP_WINDOW_SLICES = 6;

const sliceQuery = (month: string, base: BrStfBase) => {
  const baseFilter = { term: { base } };
  return month === UNDATED_SLICE_MONTH
    ? {
        query: {
          bool: {
            filter: [baseFilter],
            must_not: [{ exists: { field: "julgamento_data" } }],
          },
        },
        sort: UNDATED_SORT,
      }
    : {
        query: {
          bool: {
            filter: [
              baseFilter,
              {
                range: {
                  julgamento_data: {
                    gte: `${month}-01`,
                    lt: `${nextMonth(month)}-01`,
                  },
                },
              },
            ],
          },
        },
        sort: DATED_SORT,
      };
};

export const brStfListingIdentity = (
  hit: Record<string, unknown>,
): ListingIdentity => {
  const id = hit["_id"];
  return typeof id === "string" && isPersistableSourceDocumentId(id)
    ? { type: "document", sourceDocumentId: id }
    : { type: "unidentifiable" };
};

/**
 * One page of a slice's listing. The pages must add up to the count the
 * publisher states for the slice, so what the ledger records as reported is
 * the publisher's own `hits.total.value`; a listing that moved under the walk
 * is refused rather than recorded short.
 */
const listBrStfSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const parsed = parseBrStfSlice(slice);
  if (parsed === null) {
    return await Promise.reject(
      searchError(slice, `not a month and base: ${slice}`),
    );
  }
  const answer = await search(
    {
      ...sliceQuery(parsed.month, parsed.base),
      from: page * SLICE_PAGE_SIZE,
      size: SLICE_PAGE_SIZE,
    },
    slice,
    signal,
  );
  if (Result.isError(answer)) {
    return await Promise.reject(answer.error);
  }
  const { hits, total } = answer.value;
  if (total > OFFSET_CEILING) {
    return await Promise.reject(
      searchError(
        slice,
        `slice reports ${total} records, past the ${OFFSET_CEILING} the publisher pages`,
      ),
    );
  }
  const expected = Math.max(
    0,
    Math.min(SLICE_PAGE_SIZE, total - page * SLICE_PAGE_SIZE),
  );
  if (hits.length !== expected) {
    return await Promise.reject(
      searchError(
        slice,
        `page ${page} listed ${hits.length} of the ${expected} its count of ${total} states`,
      ),
    );
  }
  return {
    items: hits.map(({ hit }) => ({
      identity: brStfListingIdentity(hit),
      payload: hit,
    })),
    totalPages: Math.ceil(total / SLICE_PAGE_SIZE),
  };
};

const buildBrStfFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload)) {
    return { type: "unkeyable" };
  }
  const built = await buildBrStfDecision(payload, signal);
  switch (built.type) {
    case "built":
      return { type: "built", decision: built.decision };
    case "unkeyable":
      return { type: "unkeyable" };
    // A detail-less row would make the identity held while its document
    // stayed unread, taking it out of every later reconciliation.
    case "unread":
      return { type: "detail-unavailable" };
    default:
      built satisfies never;
      return panic(`Unhandled STF build: ${JSON.stringify(built)}`);
  }
};

const brStfTotalCount = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const answer = await search(
    { query: { bool: { filter: [BASES_FILTER] } }, size: 0 },
    null,
    signal,
  );
  if (Result.isOk(answer)) {
    return sourceTotalRead(answer.value.total);
  }
  return answer.error.httpStatus === undefined
    ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
    : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
};

// ── Declarations ─────────────────────────────────────────

const RECORD = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});
const STF_RECORD = RECORD("stfRecord");
const DOCUMENT = {
  disposition: "stored",
  target: { type: "document" },
} as const satisfies SourceFieldDisposition;
const IDENTITY = {
  disposition: "stored",
  target: { type: "identity" },
} as const satisfies SourceFieldDisposition;
const HTML_TWIN = excludedSourceField(
  "an HTML rendering of the *_texto field beside it, which metadata stores as text; the markup stays verbatim in the stored hit",
);

/** Every field a hit states across both bases, hit envelope included. */
const SOURCE_FIELDS = [
  "_id",
  "_index",
  "_ignored",
  "acompanhamento_processual_url",
  "acordao_ata",
  "base",
  "colac_numero",
  "colac_pagina",
  "decisao_texto",
  "dg_atualizado_em",
  "dg_unique",
  "dje_url",
  "documental_acordao_mesmo_sentido_is_secundario",
  "documental_acordao_mesmo_sentido_lista_html",
  "documental_acordao_mesmo_sentido_lista_texto",
  "documental_assunto_texto",
  "documental_decisao_mesmo_sentido_is_secundario",
  "documental_decisao_mesmo_sentido_lista_html",
  "documental_decisao_mesmo_sentido_lista_texto",
  "documental_doutrina_texto",
  "documental_indexacao_texto",
  "documental_jurisprudencia_citada_texto",
  "documental_legislacao_citada_texto",
  "documental_observacao_html",
  "documental_observacao_texto",
  "documental_publicacao_lista_texto",
  "documental_tese_tema_texto",
  "documental_tese_texto",
  "documental_tese_tipo",
  "ementa_texto",
  "externo_seq_objeto_incidente",
  "id",
  "inteiro_teor_texto",
  "inteiro_teor_url",
  "is_colac",
  "is_decisao_presidencia",
  "is_processo_antigo",
  "is_questao_ordem",
  "is_repercussao_geral",
  "is_repercussao_geral_admissibilidade",
  "is_repercussao_geral_merito",
  "julgamento_data",
  "julgamento_is_sessao_virtual",
  "ministro_facet",
  "ods_onu",
  "old_seq_colac",
  "old_seq_repercussao_geral",
  "old_seq_sjur",
  "orgao_julgador",
  "partes_lista_texto",
  "presidente_nome",
  "procedencia_geografica_completo",
  "procedencia_geografica_pais_extenso",
  "procedencia_geografica_pais_sigla",
  "procedencia_geografica_uf_extenso",
  "procedencia_geografica_uf_sigla",
  "processo_classe_processual_unificada_classe_sigla",
  "processo_classe_processual_unificada_extenso",
  "processo_classe_processual_unificada_incidente_sigla",
  "processo_classe_processual_unificada_sigla",
  "processo_codigo_completo",
  "processo_numero",
  "publicacao_data",
  "relator_acordao_nome",
  "relator_decisao_nome",
  "relator_processo_nome",
  "republicacao_data",
  "revisor_processo_nome",
  "titulo",
] as const;

type BrStfSourceField = (typeof SOURCE_FIELDS)[number];

const BR_STF_SOURCE_FIELDS = {
  _id: IDENTITY,
  _index: excludedSourceField(
    "the name of the search index generation that served the hit; corpus-wide, not a fact about the decision",
  ),
  _ignored: excludedSourceField(
    "the search engine's list of fields it did not index for this hit; index bookkeeping, not publisher data",
  ),
  acompanhamento_processual_url: STF_RECORD,
  acordao_ata: STF_RECORD,
  base: STF_RECORD,
  colac_numero: STF_RECORD,
  colac_pagina: STF_RECORD,
  decisao_texto: DOCUMENT,
  dg_atualizado_em: STF_RECORD,
  dg_unique: IDENTITY,
  dje_url: STF_RECORD,
  documental_acordao_mesmo_sentido_is_secundario: STF_RECORD,
  documental_acordao_mesmo_sentido_lista_html: HTML_TWIN,
  documental_acordao_mesmo_sentido_lista_texto: STF_RECORD,
  documental_assunto_texto: STF_RECORD,
  documental_decisao_mesmo_sentido_is_secundario: STF_RECORD,
  documental_decisao_mesmo_sentido_lista_html: HTML_TWIN,
  documental_decisao_mesmo_sentido_lista_texto: STF_RECORD,
  documental_doutrina_texto: STF_RECORD,
  documental_indexacao_texto: STF_RECORD,
  documental_jurisprudencia_citada_texto: STF_RECORD,
  documental_legislacao_citada_texto: STF_RECORD,
  documental_observacao_html: HTML_TWIN,
  documental_observacao_texto: STF_RECORD,
  documental_publicacao_lista_texto: STF_RECORD,
  documental_tese_tema_texto: STF_RECORD,
  documental_tese_texto: {
    disposition: "stored",
    target: { type: "textField", key: "legalSentence" },
  },
  documental_tese_tipo: STF_RECORD,
  ementa_texto: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  externo_seq_objeto_incidente: STF_RECORD,
  id: IDENTITY,
  inteiro_teor_texto: DOCUMENT,
  inteiro_teor_url: STF_RECORD,
  is_colac: STF_RECORD,
  is_decisao_presidencia: STF_RECORD,
  is_processo_antigo: STF_RECORD,
  is_questao_ordem: STF_RECORD,
  is_repercussao_geral: STF_RECORD,
  is_repercussao_geral_admissibilidade: STF_RECORD,
  is_repercussao_geral_merito: STF_RECORD,
  julgamento_data: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  julgamento_is_sessao_virtual: STF_RECORD,
  ministro_facet: STF_RECORD,
  ods_onu: STF_RECORD,
  old_seq_colac: STF_RECORD,
  old_seq_repercussao_geral: STF_RECORD,
  old_seq_sjur: STF_RECORD,
  orgao_julgador: STF_RECORD,
  partes_lista_texto: STF_RECORD,
  presidente_nome: STF_RECORD,
  procedencia_geografica_completo: STF_RECORD,
  procedencia_geografica_pais_extenso: STF_RECORD,
  procedencia_geografica_pais_sigla: STF_RECORD,
  procedencia_geografica_uf_extenso: STF_RECORD,
  procedencia_geografica_uf_sigla: STF_RECORD,
  processo_classe_processual_unificada_classe_sigla: STF_RECORD,
  processo_classe_processual_unificada_extenso: STF_RECORD,
  processo_classe_processual_unificada_incidente_sigla: STF_RECORD,
  processo_classe_processual_unificada_sigla: STF_RECORD,
  processo_codigo_completo: STF_RECORD,
  processo_numero: STF_RECORD,
  publicacao_data: STF_RECORD,
  relator_acordao_nome: STF_RECORD,
  relator_decisao_nome: STF_RECORD,
  relator_processo_nome: STF_RECORD,
  republicacao_data: STF_RECORD,
  revisor_processo_nome: STF_RECORD,
  titulo: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
} as const satisfies Record<BrStfSourceField, SourceFieldDisposition>;

/** What a stored envelope's hit states: its own keys and its record's. */
const listBrStfSourceFields = ({ hit }: SourceRawParts): readonly string[] => {
  const parsed: unknown = JSON.parse(hit ?? "{}");
  if (!isRecord(parsed)) {
    return [];
  }
  const source = parsed["_source"];
  return [
    ...Object.keys(parsed).filter((key) => key !== "_source"),
    ...(isRecord(source) ? Object.keys(source) : []),
  ];
};

const SOURCE_SURFACES = [
  "search-hit",
  "record-detail",
  "decision-document",
  "decision-page",
  "process-page",
  "gazette-page",
] as const;

const BR_STF_SOURCE_SURFACES = {
  "search-hit": storedSourceSurface("hit"),
  "record-detail": excludedSourceSurface(
    "GET /api/search/get/<id> answers the same _source the search hit carries, field for field",
  ),
  "decision-document": storedSourceSurface("document"),
  "decision-page": excludedSourceSurface(
    "the search page at /pages/search/<id> is a client rendering of the same record",
  ),
  "process-page": excludedSourceSurface(
    "acompanhamento_processual_url is the case's docket history across all its decisions, not this decision",
  ),
  "gazette-page": excludedSourceSurface(
    "dje_url lists the case's gazette issues; the publication the decision appeared in is stated on the record",
  ),
} as const satisfies Record<
  (typeof SOURCE_SURFACES)[number],
  | ReturnType<typeof storedSourceSurface>
  | ReturnType<typeof excludedSourceSurface>
>;

export const brStfAdapter = defineSourceAdapter({
  key: KEY,
  documentStage: "inline",
  language: "pt",
  minRequestIntervalMs: publisherRequestIntervalMs(KEY),
  pageTimeoutMs: CRAWL_PAGE_TIMEOUT_MS,
  sourceSurfaces: { surfaces: BR_STF_SOURCE_SURFACES },
  sourceFields: {
    status: "declared",
    fields: BR_STF_SOURCE_FIELDS,
    listSourceFields: listBrStfSourceFields,
  },
  fetchPage: async (cursor, _config, signal) =>
    await fetchBrStfPage(cursor, Temporal.Now.instant(), signal),
  getTotalCount: brStfTotalCount,
  reconciliation: {
    firstSlice: FIRST_SLICE,
    sliceOf,
    nextSlice,
    previousSlice,
    tipWindowDays: TIP_WINDOW_SLICES,
    // The record's identity and content; the index generation and the
    // walk's own sort coordinates are not part of it.
    revisionOf: (payload) =>
      isRecord(payload)
        ? { id: payload["_id"], source: payload["_source"] }
        : payload,
    listSlicePage: listBrStfSlicePage,
    buildDecision: buildBrStfFromPayload,
  },
});
