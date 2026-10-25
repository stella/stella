/**
 * Tribunal de Justiça do Distrito Federal e dos Territórios (TJDFT), through
 * the court's jurisprudence search (`jurisdf.tjdft.jus.br/api/v1/pesquisa`).
 *
 * Two bases are read: `acordaos` (panel judgments, including the appeal
 * panels of the special courts, subbase `acordaos-tr`) and `decisoes`
 * (monocratic and presidency decisions). `sumulas` is not: its 29 records
 * carry no date and no process number, so they fit neither the date slices
 * nor the docket contract, and `jurisprudencia-foco` is editorial commentary.
 *
 * Enumeration. The search has no sort and lists by judgment date
 * descending, an order new records can enter anywhere. So the crawl never
 * pages an open set: it pages one publication day of one base at a time (a
 * window that is closed once the day is over in Brasília), compares every
 * page's `hits.value` with the first page's, keeps the exact ids it listed,
 * and walks the window again from its first page when the count moved, a row
 * came back twice, or the distinct ids do not add up to the count (rules 14
 * and 19). The frontier starts at the last closed day and advances only over
 * days that have closed since; a cycle with no closed day sends no request.
 * History behind the frontier is the reconciliation walk's, over year, month
 * and day slices by era, each listed twice and counted only when both passes
 * name the same records under the same count (rules 15, 16 and 19).
 *
 * Coverage blind spot: records with no `dataPublicacao` match no window. On
 * 2026-10-25 that was 28,405 of 1,766,289 acórdãos and 401,220 of 1,750,162
 * decisões; the search offers no filter that selects them, so they are not
 * enumerated, and `getTotalCount` still counts them, so the gap shows.
 *
 * Detail. A listing page never carries `inteiroTeorHtml`; the court serves it
 * only to a one-record request, which is the request its own reader page
 * sends (by `uuid`). Each listed record is therefore read once more by its
 * exact id, and both responses are kept (rule 20).
 *
 * Secrecy. A record flagged `segredoJustica` is published with its parties
 * blanked but with its text. The pipeline has no withholding state an
 * adapter can set at ingestion, so such a record is not stored at all: a
 * listing row flagged secret is not detail-read, and a detail answer flagged
 * secret is not built. The crawl counts either against the window's total as
 * excluded, and reconciliation leaves it out of what a slice is measured
 * against.
 *
 * Blind spot: a decision that becomes secret after it was stored is not
 * withdrawn yet. The pipeline has no ingestion withdrawal path, so its stored
 * text, raw payload and projections stay as they were.
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
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  DecisionJudgeInput,
  IngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  SourceTotalCount,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
  UnreadListedItem,
  UnreadOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readPublisherText,
  unreadPublisherError,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { adapterCatch } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { parseBrTjdftDocument } from "@/api/handlers/case-law/ingestion/parsers/br-tjdft";
import type { BrTjdftDocumentContent } from "@/api/handlers/case-law/ingestion/parsers/br-tjdft";
import { sectionsFromAst } from "@/api/handlers/case-law/ingestion/sections-from-ast";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  sourceTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { errorTag } from "@/api/lib/errors/utils";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

const KEY = ADAPTER_KEYS.BR_TJDFT;
const ORIGIN = "https://jurisdf.tjdft.jus.br";
const SEARCH_URL = `${ORIGIN}/api/v1/pesquisa`;
const LANGUAGE = "pt";
const COURT = ADAPTER_MANIFESTS[KEY].publisher;
const PUBLISHER_ZONE = "America/Sao_Paulo";

/** The search's largest page; a larger `tamanho` is refused. */
export const BR_TJDFT_PAGE_SIZE = 40;

/**
 * One listing request and one detail request per listed record, each behind
 * the publisher gate: a full page is 41 requests, about a minute.
 */
const PAGE_TIMEOUT_MS = 5 * 60_000;

/**
 * Walks of one window that may restart on a moving count before the
 * frontier moves on and leaves the window to reconciliation. A closed day
 * that keeps changing is a publisher backfilling it; holding the frontier on
 * it would stall every later day.
 */
const MAX_WINDOW_RESTARTS = 3;

/** Reconciliation slices near the tip: a week of both bases. */
const TIP_WINDOW_SLICES = 14;

const BR_TJDFT_BASES = ["acordaos", "decisoes"] as const;
type BrTjdftBase = (typeof BR_TJDFT_BASES)[number];

const FIRST_DAY = ADAPTER_MANIFESTS[KEY].dateRange.fromInclusive;

/** The search's stand-in for a full text it does not hold. */
const BR_TJDFT_TEXT_PLACEHOLDER = "Inteiro Teor indisponível.";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

// ── Publisher days ───────────────────────────────────────

const zonedDay = (instant: Temporal.Instant): Temporal.PlainDate =>
  instant.toZonedDateTimeISO(PUBLISHER_ZONE).toPlainDate();

/**
 * The last publication day that is over in Brasília. The publisher's current
 * day is still being written, so it is never a closed window.
 */
export const brTjdftLastClosedDay = (now: Date): string =>
  zonedDay(Temporal.Instant.fromEpochMilliseconds(now.getTime()))
    .subtract({ days: 1 })
    .toString();

/** The court's calendar day of an instant the search states, if it is one. */
export const brTjdftCalendarDay = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const instant = Result.try({
    try: () => Temporal.Instant.from(value),
    catch: () => null,
  }).unwrapOr(null);
  return instant === null ? undefined : zonedDay(instant).toString();
};

const nextDay = (day: string): string =>
  Temporal.PlainDate.from(day).add({ days: 1 }).toString();

const previousDay = (day: string): string =>
  Temporal.PlainDate.from(day).subtract({ days: 1 }).toString();

const isDay = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Result.isOk(
    Result.try({
      try: () => Temporal.PlainDate.from(value, { overflow: "reject" }),
      catch: () => null,
    }),
  );

// ── Requests ─────────────────────────────────────────────

/** Publication days from `from` to `to`, both included. */
type PublicationRange = { from: string; to: string };

const listingBody = (
  base: BrTjdftBase,
  { from, to }: PublicationRange,
  page: number,
) =>
  JSON.stringify({
    query: "",
    termosAcessorios: [
      { campo: "base", valor: base },
      { campo: "dataPublicacao", valor: `entre ${from} e ${to}` },
    ],
    pagina: page,
    tamanho: BR_TJDFT_PAGE_SIZE,
    espelho: false,
    inteiroTeor: false,
    sinonimos: false,
    retornaInteiroTeor: false,
    retornaTotalizacao: false,
  });

/** The body the court's own reader page sends for one record. */
const detailBody = (uuid: string) =>
  JSON.stringify({
    termosAcessorios: [{ campo: "uuid", valor: uuid }],
    pagina: 0,
    tamanho: 1,
    espelho: false,
    inteiroTeor: false,
    sinonimos: false,
    retornaInteiroTeor: true,
    retornaTotalizacao: false,
  });

type CountQuery = { base: BrTjdftBase; secretOnly: boolean };

const countBody = ({ base, secretOnly }: CountQuery) =>
  JSON.stringify({
    query: "",
    termosAcessorios: [
      { campo: "base", valor: base },
      ...(secretOnly ? [{ campo: "segredoJustica", valor: "true" }] : []),
    ],
    pagina: 0,
    tamanho: 1,
    espelho: false,
    inteiroTeor: false,
    sinonimos: false,
    retornaInteiroTeor: false,
    retornaTotalizacao: false,
  });

const searchResponseSchema = v.looseObject({
  hits: v.looseObject({
    value: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  registros: v.array(v.record(v.string(), v.unknown())),
});

type BrTjdftSearchResponse = {
  total: number;
  rows: Record<string, unknown>[];
  /** The response body as served, for the stored envelope. */
  raw: string;
};

/**
 * A search answer this adapter can read: a count and a list of records. Any
 * other HTTP 200 is not an empty result (rule 20), so it is refused.
 */
export const readBrTjdftSearch = (
  raw: string,
): BrTjdftSearchResponse | null => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  const read = v.safeParse(searchResponseSchema, parsed);
  if (!read.success) {
    return null;
  }
  return {
    total: read.output.hits.value,
    rows: read.output.registros,
    raw,
  };
};

type SearchStage = "listing" | "document";

type SearchOptions = {
  body: string;
  stage: SearchStage;
  cursor: string | null;
  signal?: AbortSignal | undefined;
};

const postSearch = async ({ body, stage, signal }: SearchOptions) =>
  await readPublisherText(SEARCH_URL, {
    adapterKey: KEY,
    fetchStage: stage,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body,
    redirect: "error",
    // One endpoint serves listing and detail: a refusal of either is the
    // source refusing the crawl.
    refusalScope: "source",
    timeoutMs: ADAPTER_TIMEOUT.LIST,
    ...(signal === undefined ? {} : { signal }),
  });

/** A listing or count request, as a value or the error that fails the page. */
const search = async (
  options: SearchOptions,
): Promise<Result<BrTjdftSearchResponse, AdapterFetchError>> => {
  const read = await postSearch(options);
  if (read.type !== "present") {
    return Result.err(
      unreadPublisherError({
        outcome: read,
        message: "TJDFT search could not be read",
        adapterKey: KEY,
        cursor: options.cursor,
      }),
    );
  }
  const response = readBrTjdftSearch(read.value);
  return response === null
    ? Result.err(
        new AdapterFetchError({
          message: `TJDFT search answered no readable result: ${read.value.slice(0, 200)}`,
          adapterKey: KEY,
          cursor: options.cursor,
        }),
      )
    : Result.ok(response);
};

type DetailRead =
  | { type: "read"; record: Record<string, unknown>; raw: string }
  /** The search states no record under the id the listing gave. */
  | { type: "absent" }
  | { type: "unread"; outcome: UnreadOutcome; error: AdapterFetchError };

const unreadDetail = (
  cursor: string | null,
  message: string,
  error: unknown,
): DetailRead => ({
  type: "unread",
  outcome: { type: "unavailable", cause: { kind: "thrown", error } },
  error: new AdapterFetchError({
    message,
    adapterKey: KEY,
    cursor,
    cause: error,
  }),
});

/**
 * The one-record answer for a listed id. A rate-limit refusal is not caught
 * here: it rejects, so the page halts after the one request (rule 19a).
 */
const readDetail = async (
  uuid: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<DetailRead, AdapterFetchError>> => {
  const read = await postSearch({
    body: detailBody(uuid),
    stage: "document",
    cursor,
    signal,
  });
  switch (read.type) {
    case "present":
      break;
    case "refused":
      return Result.err(
        unreadPublisherError({
          outcome: read,
          message: "TJDFT detail refused",
          adapterKey: KEY,
          cursor,
        }),
      );
    case "absent":
      return Result.ok({ type: "absent" });
    case "unavailable":
      return Result.ok({
        type: "unread",
        outcome: read,
        error: unreadPublisherError({
          outcome: read,
          message: "TJDFT detail could not be read",
          adapterKey: KEY,
          cursor,
        }),
      });
    default:
      read satisfies never;
      return panic(`Unhandled TJDFT read: ${JSON.stringify(read)}`);
  }
  const response = readBrTjdftSearch(read.value);
  if (response === null) {
    return Result.ok(
      unreadDetail(cursor, "TJDFT detail answered no readable result", null),
    );
  }
  if (response.total === 0 && response.rows.length === 0) {
    return Result.ok({ type: "absent" });
  }
  const record = response.rows.at(0);
  if (response.rows.length !== 1 || record?.["uuid"] !== uuid) {
    return Result.ok(
      unreadDetail(
        cursor,
        `TJDFT detail for ${uuid} answered another record`,
        null,
      ),
    );
  }
  return Result.ok({ type: "read", record, raw: response.raw });
};

// ── Record fields ────────────────────────────────────────

const stringField = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
};

const numberField = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const booleanField = (
  record: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

/** A record the court published under judicial secrecy. */
const isBrTjdftSecret = (record: Record<string, unknown>): boolean =>
  record["segredoJustica"] === true;

/**
 * The publisher's id, when it is one: a lower-case UUID within the identity
 * column. `identificador` is not a fallback: a record carries a `versao`,
 * and nothing shows the number is unique across versions.
 */
const uuidOf = (record: Record<string, unknown>): string | undefined => {
  const uuid = record["uuid"];
  return typeof uuid === "string" && UUID_PATTERN.test(uuid) ? uuid : undefined;
};

/**
 * The listing row without its coordinates in one response: its position and
 * the highlight offsets of the query. What is left identifies the record.
 */
const listingContent = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => key !== "sequencial" && key !== "marcadores",
    ),
  );

/**
 * A content-addressed audit identity for a row stating no usable id. Built
 * from the fields that stay as they are once the id recovers, never from
 * the malformed id itself: the recovered row names the same fingerprint as a
 * repair alias and adopts the quarantine row instead of adding a second one.
 */
const quarantineIdOf = (row: Record<string, unknown>): string =>
  `quarantine:${sha256Hex(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(listingContent(row)).filter(([key]) => key !== "uuid"),
      ),
    ),
  )}`;

/** The id a listed row is held under: its own, or its quarantine one. */
const rowIdentityOf = (row: Record<string, unknown>): string =>
  uuidOf(row) ?? quarantineIdOf(row);

const DECISION_TYPE_BY_SUBBASE = {
  acordaos: "acórdão",
  "acordaos-tr": "acórdão",
  "decisoes-monocraticas": "decisão monocrática",
  "decisoes-presidencia": "decisão da presidência",
} as const;

const isKnownSubbase = (
  value: string,
): value is keyof typeof DECISION_TYPE_BY_SUBBASE =>
  Object.hasOwn(DECISION_TYPE_BY_SUBBASE, value);

/**
 * The decision type the subbase names, in the court's words. A subbase this
 * adapter does not know states none rather than borrowing its base's type.
 */
const brTjdftDecisionTypeOf = (
  record: Record<string, unknown>,
): string | undefined => {
  const subbase = stringField(record, "subbase");
  return subbase !== undefined && isKnownSubbase(subbase)
    ? DECISION_TYPE_BY_SUBBASE[subbase]
    : undefined;
};

/** How `caseNumber` was read from the process number the record states. */
type CaseNumberReading =
  | { type: "cnj" }
  /** A pre-CNJ TJDFT number ("20090020163473ARC", "APC1101"), stored as listed. */
  | { type: "publisher-legacy" }
  /** No process number: the label is the record's id. */
  | { type: "placeholder" };

/**
 * The docket: the CNJ unified number in the BRA grammar's form, else the
 * process number as the court lists it, else the record's own id.
 */
export const brTjdftCaseNumberOf = (
  record: Record<string, unknown>,
  fallbackId: string,
): { caseNumber: string; reading: CaseNumberReading } => {
  const processo = stringField(record, "processo")?.trim();
  if (processo === undefined) {
    return { caseNumber: fallbackId, reading: { type: "placeholder" } };
  }
  const parsed = DECISION_DOCKET_GRAMMARS.BRA.parse(processo);
  return parsed === null
    ? { caseNumber: processo, reading: { type: "publisher-legacy" } }
    : { caseNumber: formatDecisionDocket(parsed), reading: { type: "cnj" } };
};

/**
 * The class name the court files the record under. A one-record answer's
 * facets describe that record alone, and the class is stated nowhere else.
 */
const classOfDetail = (detailRaw: string | undefined): string | undefined => {
  if (detailRaw === undefined) {
    return undefined;
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(detailRaw),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(parsed) || !isRecord(parsed["agregacoes"])) {
    return undefined;
  }
  const classes = parsed["agregacoes"]["classe"];
  if (!Array.isArray(classes) || classes.length !== 1) {
    return undefined;
  }
  const only: unknown = classes[0];
  return isRecord(only) && typeof only["nome"] === "string"
    ? only["nome"]
    : undefined;
};

const judgesOf = (record: Record<string, unknown>): DecisionJudgeInput[] => {
  const judges: DecisionJudgeInput[] = [];
  const relator = stringField(record, "nomeRelator");
  if (relator !== undefined) {
    judges.push({ role: "rapporteur", nameAsPrinted: relator });
  }
  // The designated rapporteur drafts the judgment when the rapporteur is
  // outvoted; both are named as the court lists them.
  const designado = stringField(record, "nomeRelatorDesignado");
  if (designado !== undefined) {
    judges.push({ role: "rapporteur", nameAsPrinted: designado });
  }
  const revisor = stringField(record, "nomeRevisor");
  if (revisor !== undefined) {
    judges.push({ role: "panel-member", nameAsPrinted: revisor });
  }
  return judges;
};

/** The full text the record carries, the richest shape first. */
const documentContentOf = (
  record: Record<string, unknown>,
): { content: BrTjdftDocumentContent; source: string } | undefined => {
  const html = stringField(record, "inteiroTeorHtml");
  if (html !== undefined && html.trim() !== BR_TJDFT_TEXT_PLACEHOLDER) {
    return { content: { type: "html", text: html }, source: "inteiroTeorHtml" };
  }
  const text = stringField(record, "inteiroTeor");
  if (text !== undefined && text.trim() !== BR_TJDFT_TEXT_PLACEHOLDER) {
    return { content: { type: "text", text }, source: "inteiroTeor" };
  }
  const ementa = stringField(record, "ementa");
  const decisao = stringField(record, "decisao");
  return ementa === undefined && decisao === undefined
    ? undefined
    : {
        content: { type: "record", ementa, decisao },
        source: "record",
      };
};

/** Metadata says what the record says: a field it leaves out stays out. */
const statedEntries = (
  entries: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  );

const RAW_PART = {
  LISTING: "listing",
  DETAIL: "detail",
} as const;

const brTjdftSourceUrlOf = (
  record: Record<string, unknown>,
  uuid: string,
): string =>
  stringField(record, "base") === "decisoes"
    ? `${ORIGIN}/decisoes/${uuid}/inteiro-teor`
    : `${ORIGIN}/acordaos/${uuid}`;

const documentUrlOf = (uuid: string): string =>
  `${SEARCH_URL}/download/${uuid}`;

/** Why a listed record holds no detail payload. */
const DETAIL_STATUS = {
  ABSENT: "detail-absent",
  UNREAD: "detail-unread",
  NO_IDENTITY: "no-publisher-identity",
} as const;

type DetailStatus = (typeof DETAIL_STATUS)[keyof typeof DETAIL_STATUS];

type AssembleBrTjdftOptions = {
  listing: Record<string, unknown>;
  /** The one-record answer, absent when the record was not read. */
  detail: { record: Record<string, unknown>; raw: string } | undefined;
  /** Why `detail` is absent; required exactly when it is. */
  detailStatus: DetailStatus | undefined;
};

/**
 * One decision from the responses in hand. No I/O: the crawl, the
 * reconciliation walk and a replay of the stored envelope reach this with the
 * same payloads, so none of them can key or parse a row differently.
 */
export const assembleBrTjdftDecision = ({
  listing,
  detail,
  detailStatus,
}: AssembleBrTjdftOptions): IngestionResult => {
  const record = detail?.record ?? listing;
  const uuid = uuidOf(listing);
  const sourceDocumentId = rowIdentityOf(listing);
  const { caseNumber, reading } = brTjdftCaseNumberOf(record, sourceDocumentId);
  const decisionType = brTjdftDecisionTypeOf(record);
  const decisionDate = brTjdftCalendarDay(record["dataJulgamento"]);
  const sourceUrl =
    uuid === undefined ? SEARCH_URL : brTjdftSourceUrlOf(record, uuid);
  const parts: SourceRawParts = {
    [RAW_PART.LISTING]: JSON.stringify(listing),
    ...(detail === undefined ? {} : { [RAW_PART.DETAIL]: detail.raw }),
  };
  const sourceRaw = encodeSourceRawEnvelope(parts);

  const content = detail === undefined ? undefined : documentContentOf(record);
  const parsed =
    content === undefined
      ? undefined
      : parseBrTjdftDocument({
          content: content.content,
          documentId: sourceDocumentId,
          caseNumber,
          court: COURT,
          decisionDate,
          decisionType,
          sourceUrl,
        });
  const ementa = stringField(record, "ementa");
  const inteiroTeor = stringField(record, "inteiroTeor");
  // A monocratic decision states its whole text as `ementa` too; that is the
  // decision, not a headnote of it.
  const headnote =
    ementa === undefined || ementa === inteiroTeor
      ? absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED).headnote
      : sourceTextField(KEY, ementa);
  const judges = judgesOf(record);
  const cnjClass = classOfDetail(detail?.raw);

  return plainTextIngestionResult({
    caseNumber,
    ...(reading.type === "placeholder"
      ? { caseNumberIsPlaceholder: true }
      : {}),
    sourceDocumentId,
    // Repair-only: it adopts a row stored while the id was malformed, and
    // is never reserved on its own (rule 20).
    ...(uuid === undefined
      ? {}
      : { sourceDocumentIdRepairAliases: [quarantineIdOf(listing)] }),
    court: COURT,
    country: ADAPTER_MANIFESTS[KEY].country,
    language: LANGUAGE,
    ...(decisionDate === undefined ? {} : { decisionDate }),
    ...(decisionType === undefined ? {} : { decisionType }),
    ...(parsed === undefined ? {} : { fulltext: parsed.fulltext }),
    ...(parsed === undefined
      ? {}
      : { sections: sectionsFromAst(parsed.documentAst.blocks) }),
    ...(detail === undefined ? { isListingOnly: true } : {}),
    sourceUrl,
    ...(uuid === undefined ? {} : { documentUrl: documentUrlOf(uuid) }),
    textFields: {
      ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      headnote,
    },
    judges,
    metadata: checkedDecisionMetadata(
      statedEntries({
        caseNumber,
        court: COURT,
        decisionDate,
        // The search states no judgment date for monocratic decisions.
        decisionDateAvailability:
          decisionDate === undefined
            ? { status: "not-published-by-source" }
            : undefined,
        decisionType,
        // Brazil issues no ECLI.
        ecliAvailability: { status: "not_published" },
        processNumber: stringField(record, "processo"),
        caseNumberReading: reading.type,
        base: stringField(record, "base"),
        subbase: stringField(record, "subbase"),
        recordIdentifier: stringField(record, "identificador"),
        recordVersion: stringField(record, "versao"),
        stateCode: stringField(record, "uf"),
        cnjClassCode: numberField(record, "codigoClasseCnj"),
        cnjClass,
        chamber: stringField(record, "descricaoOrgaoJulgador"),
        chamberCode: numberField(record, "codigoSistjOrgaoJulgador"),
        organ: stringField(record, "descricaoOrgao"),
        rapporteur: stringField(record, "nomeRelator"),
        rapporteurActive: booleanField(record, "relatorAtivo"),
        designatedRapporteur: stringField(record, "nomeRelatorDesignado"),
        reviser: stringField(record, "nomeRevisor"),
        turmaRecursal: booleanField(record, "turmaRecursal"),
        judicialSecrecy: booleanField(record, "segredoJustica"),
        publishedAt: stringField(record, "dataPublicacao"),
        publicationDate: brTjdftCalendarDay(record["dataPublicacao"]),
        publicationVenue: stringField(record, "localDePublicacao"),
        publicationPage: stringField(record, "paginaPublicacao"),
        judgedAt: stringField(record, "dataJulgamento"),
        outcome: stringField(record, "decisao"),
        auxiliaryTerms: stringField(record, "termosAuxiliares"),
        hasFullText: booleanField(record, "possuiInteiroTeor"),
        textSource: content?.source,
        detailStatus,
      }),
    ),
    rawHash: sourceFingerprint({ sourceRaw }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.BR_TJDFT],
    documentAst: parsed?.documentAst ?? EMPTY_AST,
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
};

/** What reading and assembling one listed row produced. */
type RowBuild =
  | { type: "built"; decision: IngestionResult }
  /** The search no longer lists the record under its id. */
  | { type: "detail-absent"; decision: IngestionResult }
  | { type: "unread"; item: UnreadListedItem }
  /** A row with no publisher id, kept under a content-addressed identity. */
  | { type: "quarantined"; decision: IngestionResult }
  /**
   * The record is under judicial secrecy by its own answer, whatever the
   * listing row said: nothing of it is built or kept.
   */
  | { type: "excluded" };

const buildRow = async (
  row: Record<string, unknown>,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<RowBuild, AdapterFetchError>> => {
  const uuid = uuidOf(row);
  if (uuid === undefined) {
    return Result.ok({
      type: "quarantined",
      decision: assembleBrTjdftDecision({
        listing: row,
        detail: undefined,
        detailStatus: DETAIL_STATUS.NO_IDENTITY,
      }),
    });
  }
  const read = await readDetail(uuid, cursor, signal);
  if (Result.isError(read)) {
    return read;
  }
  switch (read.value.type) {
    case "read":
      if (isBrTjdftSecret(read.value.record)) {
        return Result.ok({ type: "excluded" });
      }
      return Result.ok({
        type: "built",
        decision: assembleBrTjdftDecision({
          listing: row,
          detail: { record: read.value.record, raw: read.value.raw },
          detailStatus: undefined,
        }),
      });
    case "absent":
      return Result.ok({
        type: "detail-absent",
        decision: assembleBrTjdftDecision({
          listing: row,
          detail: undefined,
          detailStatus: DETAIL_STATUS.ABSENT,
        }),
      });
    case "unread": {
      const listed = assembleBrTjdftDecision({
        listing: row,
        detail: undefined,
        detailStatus: DETAIL_STATUS.UNREAD,
      });
      return Result.ok({
        type: "unread",
        item: {
          listing: { ...listed, sourceDocumentId: uuid, isListingOnly: true },
          outcome: read.value.outcome,
        },
      });
    }
    default:
      read.value satisfies never;
      return panic(`Unhandled TJDFT detail: ${JSON.stringify(read.value)}`);
  }
};

type Collected = Pick<
  SyncPage,
  "decisions" | "itemBuildFailures" | "unreadItems"
> & { excluded: number };

const collectRows = async (
  rows: readonly Record<string, unknown>[],
  cursor: string | null,
  signal?: AbortSignal,
): Promise<Result<Collected, AdapterFetchError>> => {
  const decisions: IngestionResult[] = [];
  const unreadItems: UnreadListedItem[] = [];
  let failed = 0;
  let excluded = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    if (isBrTjdftSecret(row)) {
      excluded += 1;
      continue;
    }
    const built = await buildPlainTextItem({
      adapterKey: KEY,
      rawListing: JSON.stringify(row),
      build: async () => await buildRow(row, cursor, signal),
      decisionOf: (outcome) => {
        if (Result.isError(outcome)) {
          return undefined;
        }
        const value = outcome.value;
        switch (value.type) {
          case "unread":
            return value.item.listing;
          case "excluded":
            return undefined;
          case "built":
          case "detail-absent":
          case "quarantined":
            return value.decision;
          default:
            value satisfies never;
            return panic(`Unhandled TJDFT row: ${JSON.stringify(value)}`);
        }
      },
    });
    if (built.type === "item_build_failed") {
      failed += 1;
      decisions.push(built.decision);
      continue;
    }
    if (Result.isError(built.value)) {
      return built.value;
    }
    const outcome = built.value.value;
    switch (outcome.type) {
      case "built":
      case "detail-absent":
      case "quarantined":
        decisions.push(outcome.decision);
        break;
      // The pipeline decides what an unread detail costs the page.
      case "unread":
        unreadItems.push(outcome.item);
        break;
      case "excluded":
        excluded += 1;
        break;
      default:
        outcome satisfies never;
        panic(`Unhandled TJDFT row: ${JSON.stringify(outcome)}`);
    }
  }
  return Result.ok({
    decisions,
    ...(failed === 0
      ? {}
      : { itemBuildFailures: { type: "item_build_failed", count: failed } }),
    ...(unreadItems.length === 0 ? {} : { unreadItems }),
    excluded,
  });
};

// ── Crawl cursor ─────────────────────────────────────────

const CURSOR_VERSION = 1;

const cursorSchema = v.strictObject({
  version: v.literal(CURSOR_VERSION),
  day: v.pipe(v.string(), v.check(isDay)),
  base: v.picklist(BR_TJDFT_BASES),
  page: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The window's count as its first page stated it; null before that page. */
  total: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /**
   * The ids of the rows the window listed so far, secret ones included. A
   * count of rows cannot tell a row listed twice from two rows, so the
   * window is whole only when its distinct ids are its count.
   */
  seen: v.array(v.string()),
  /** Of those, the rows under judicial secrecy, which are not stored. */
  excluded: v.pipe(v.number(), v.integer(), v.minValue(0)),
  restarts: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type BrTjdftCursor = v.InferOutput<typeof cursorSchema>;

export const encodeBrTjdftCursor = (cursor: BrTjdftCursor): string =>
  JSON.stringify(cursor);

const windowStart = (
  day: string,
  base: BrTjdftBase,
  restarts = 0,
): BrTjdftCursor => ({
  version: CURSOR_VERSION,
  day,
  base,
  page: 0,
  total: null,
  seen: [],
  excluded: 0,
  restarts,
});

/**
 * A cursor this adapter did not write is refused: reading it as the start
 * would re-walk from the tip and drop the position it held.
 */
export const parseBrTjdftCursor = (
  cursor: string | null,
  now: Date,
): Result<BrTjdftCursor, AdapterFetchError> =>
  cursor === null
    ? Result.ok(windowStart(brTjdftLastClosedDay(now), "acordaos"))
    : Result.try({
        try: () => v.parse(cursorSchema, JSON.parse(cursor)),
        catch: adapterCatch(KEY, cursor),
      });

const nextWindow = (position: BrTjdftCursor): BrTjdftCursor =>
  position.base === "acordaos"
    ? windowStart(position.day, "decisoes")
    : windowStart(nextDay(position.day), "acordaos");

/**
 * Walk the window again from its first page, or, once it has restarted as
 * often as a closed window should, move on and leave it to reconciliation.
 */
const restartWindow = (
  position: BrTjdftCursor,
  reason: string,
): BrTjdftCursor => {
  if (position.restarts < MAX_WINDOW_RESTARTS) {
    return windowStart(position.day, position.base, position.restarts + 1);
  }
  logger.warn("case_law.ingestion.window_unstable", {
    adapterKey: KEY,
    day: position.day,
    base: position.base,
    reason,
  });
  return nextWindow(position);
};

type CrawlDependencies = { now: () => Date };

const crawlPage = async (
  cursor: string | null,
  { now }: CrawlDependencies,
  signal?: AbortSignal,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const parsed = parseBrTjdftCursor(cursor, now());
  if (Result.isError(parsed)) {
    return parsed;
  }
  const position = parsed.value;
  // The frontier only crosses closed days: a quiet cycle sends nothing.
  if (position.day > brTjdftLastClosedDay(now())) {
    return Result.ok({
      decisions: [],
      nextCursor: encodeBrTjdftCursor(position),
    });
  }
  const listing = await search({
    body: listingBody(
      position.base,
      { from: position.day, to: position.day },
      position.page,
    ),
    stage: "listing",
    cursor,
    signal,
  });
  if (Result.isError(listing)) {
    return listing;
  }
  const { total, rows } = listing.value;
  if (rows.length > BR_TJDFT_PAGE_SIZE) {
    return Result.err(
      new AdapterFetchError({
        message: `TJDFT listing answered ${rows.length} rows for a page of ${BR_TJDFT_PAGE_SIZE}`,
        adapterKey: KEY,
        cursor,
      }),
    );
  }
  const offset = position.page * BR_TJDFT_PAGE_SIZE;
  if (rows.length === 0 && offset < total) {
    // A full count with an empty page is not the end of the window (rule 14).
    return Result.err(
      new AdapterFetchError({
        message: `TJDFT listing page ${position.page} is empty below its count ${total}`,
        adapterKey: KEY,
        cursor,
      }),
    );
  }

  const collected = await collectRows(rows, cursor, signal);
  if (Result.isError(collected)) {
    return collected;
  }
  const { decisions, itemBuildFailures, unreadItems } = collected.value;
  const seen = new Set(position.seen);
  const repeated = rows.some((row) => {
    const id = rowIdentityOf(row);
    const known = seen.has(id);
    seen.add(id);
    return known;
  });
  const excluded = position.excluded + collected.value.excluded;
  const moved = position.total !== null && position.total !== total;
  const lastPage = offset + rows.length >= total;
  let next: BrTjdftCursor;
  if (moved) {
    next = restartWindow(position, "count changed between pages");
  } else if (repeated) {
    // A row seen on an earlier page moved under the offsets, so some other
    // row of the window was skipped.
    next = restartWindow(position, "a row was listed twice");
  } else if (!lastPage) {
    next = {
      ...position,
      page: position.page + 1,
      total,
      seen: [...seen],
      excluded,
    };
  } else if (seen.size !== total) {
    next = restartWindow(position, "listed rows do not add up to the count");
  } else {
    // The secret records are counted here, against the window's own total,
    // because no row records that they were seen and left.
    logger.info("case_law.ingestion.window_collected", {
      adapterKey: KEY,
      day: position.day,
      base: position.base,
      reported: total,
      excluded,
    });
    next = nextWindow(position);
  }
  return Result.ok({
    decisions,
    ...(itemBuildFailures === undefined ? {} : { itemBuildFailures }),
    ...(unreadItems === undefined ? {} : { unreadItems }),
    nextCursor: encodeBrTjdftCursor(next),
    sourceUrl: SEARCH_URL,
  });
};

// ── Reconciliation ───────────────────────────────────────

const SLICE_SEPARATOR = ":";

/**
 * History is sliced by how much of it there is. The search dates a handful
 * of acórdãos before the court sat in 1960 and some thousands a year until
 * the late 1990s; a daily slice over that span costs a listing request per
 * empty day on every sweep. So a slice is a year before 1960, a month until
 * 2000 (no month of those years comes near the slice ceiling) and a day
 * from 2000, when the court publishes thousands a month.
 */
const MONTH_SLICES_FROM_YEAR = 1960;
const DAY_SLICES_FROM = "2000-01-01";

type SlicePeriod =
  | { type: "year"; year: number }
  | { type: "month"; year: number; month: number }
  | { type: "day"; day: string };

const padded = (value: number, width: number): string =>
  String(value).padStart(width, "0");

const periodKey = (period: SlicePeriod): string => {
  switch (period.type) {
    case "year":
      return padded(period.year, 4);
    case "month":
      return `${padded(period.year, 4)}-${padded(period.month, 2)}`;
    case "day":
      return period.day;
    default:
      period satisfies never;
      return panic(`Unhandled TJDFT slice period: ${JSON.stringify(period)}`);
  }
};

/** The slice period a publication day belongs to. */
const periodOfDay = (day: string): SlicePeriod => {
  const date = Temporal.PlainDate.from(day);
  if (date.year < MONTH_SLICES_FROM_YEAR) {
    return { type: "year", year: date.year };
  }
  return day < DAY_SLICES_FROM
    ? { type: "month", year: date.year, month: date.month }
    : { type: "day", day };
};

const rangeOf = (period: SlicePeriod): PublicationRange => {
  switch (period.type) {
    case "year":
      return {
        from: `${padded(period.year, 4)}-01-01`,
        to: `${padded(period.year, 4)}-12-31`,
      };
    case "month": {
      const month = Temporal.PlainYearMonth.from({
        year: period.year,
        month: period.month,
      });
      return {
        from: month.toPlainDate({ day: 1 }).toString(),
        to: month.toPlainDate({ day: month.daysInMonth }).toString(),
      };
    }
    case "day":
      return { from: period.day, to: period.day };
    default:
      period satisfies never;
      return panic(`Unhandled TJDFT slice period: ${JSON.stringify(period)}`);
  }
};

export const brTjdftSlice = (period: string, base: BrTjdftBase): string =>
  `${period}${SLICE_SEPARATOR}${base}`;

const sliceAt = (period: SlicePeriod, base: BrTjdftBase): string =>
  brTjdftSlice(periodKey(period), base);

const SLICE_PERIOD_PATTERN = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u;

/**
 * A slice this adapter writes, or undefined. A period is accepted only in
 * the shape its tier gives it, so `1999-02-01` (a day where the months run)
 * names no slice.
 */
const parseBrTjdftSlice = (
  slice: string,
): { period: SlicePeriod; base: BrTjdftBase } | undefined => {
  const [key, base, ...rest] = slice.split(SLICE_SEPARATOR);
  if (
    key === undefined ||
    rest.length > 0 ||
    (base !== "acordaos" && base !== "decisoes") ||
    !SLICE_PERIOD_PATTERN.test(key)
  ) {
    return undefined;
  }
  // A year or a month key, filled out to the first day it covers.
  const firstDay = `${key}${"-01-01".slice(key.length - 4)}`;
  if (!isDay(firstDay)) {
    return undefined;
  }
  const period = periodOfDay(firstDay);
  return periodKey(period) === key ? { period, base } : undefined;
};

const FIRST_SLICE = sliceAt(periodOfDay(FIRST_DAY), "acordaos");

const sliceOf = (now: Date): string =>
  sliceAt(periodOfDay(brTjdftLastClosedDay(now)), "decisoes");

const nextSlice = (slice: string, now: Date): string | null => {
  const parsed = parseBrTjdftSlice(slice);
  if (parsed === undefined) {
    return null;
  }
  const next =
    parsed.base === "acordaos"
      ? sliceAt(parsed.period, "decisoes")
      : sliceAt(periodOfDay(nextDay(rangeOf(parsed.period).to)), "acordaos");
  return next > sliceOf(now) ? null : next;
};

const previousSlice = (slice: string): string | null => {
  const parsed = parseBrTjdftSlice(slice);
  if (parsed === undefined) {
    return null;
  }
  if (parsed.base === "decisoes") {
    return sliceAt(parsed.period, "acordaos");
  }
  const { from } = rangeOf(parsed.period);
  return from <= FIRST_DAY
    ? null
    : sliceAt(periodOfDay(previousDay(from)), "decisoes");
};

/**
 * One walk of a slice. The engine lists a slice page by page from the
 * first, and the walk states twice as many pages as the slice holds: the
 * first pass lists the records, the second lists the slice again for its ids
 * alone (rule 19). The listing counts the slice only if the count held still
 * through both passes, each pass's distinct ids add up to it, and the two
 * passes name the same records; a record replaced by another under an
 * unchanged count fails the walk, and the slice is retried rather than
 * recorded whole.
 */
type SliceWalk = {
  total: number;
  passes: readonly [Set<string>, Set<string>];
};

const sliceWalks = new Map<string, SliceWalk>();
const MAX_OPEN_SLICE_WALKS = 64;
const VERIFYING_PASS = 1;

type SlicePageOptions = {
  slice: string;
  page: number;
  signal?: AbortSignal | undefined;
};

const sameIds = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((id) => right.has(id));

const listSlicePage = async (
  { slice, page, signal }: SlicePageOptions,
  { now }: CrawlDependencies,
): Promise<ReconciliationSlicePage> => {
  const parsed = parseBrTjdftSlice(slice);
  const refuse = (message: string) => {
    sliceWalks.delete(slice);
    return new AdapterFetchError({ message, adapterKey: KEY, cursor: slice });
  };
  if (
    parsed === undefined ||
    slice < FIRST_SLICE ||
    slice > sliceOf(now()) ||
    !Number.isSafeInteger(page) ||
    page < 0
  ) {
    return await Promise.reject(
      refuse(`Invalid TJDFT reconciliation page: ${slice}/${page}`),
    );
  }
  const known = page === 0 ? undefined : sliceWalks.get(slice);
  if (page > 0 && known === undefined) {
    return await Promise.reject(
      refuse(`TJDFT slice ${slice} page ${page} has no walk to continue`),
    );
  }
  const passPages =
    known === undefined ? 0 : Math.ceil(known.total / BR_TJDFT_PAGE_SIZE);
  const pass = page >= passPages && page > 0 ? VERIFYING_PASS : 0;
  const passPage = pass === VERIFYING_PASS ? page - passPages : page;
  const listing = await search({
    body: listingBody(parsed.base, rangeOf(parsed.period), passPage),
    stage: "listing",
    cursor: slice,
    signal,
  });
  if (Result.isError(listing)) {
    sliceWalks.delete(slice);
    return await Promise.reject(listing.error);
  }
  const { total, rows } = listing.value;
  if (page === 0) {
    if (sliceWalks.size >= MAX_OPEN_SLICE_WALKS) {
      sliceWalks.clear();
    }
    sliceWalks.set(slice, { total, passes: [new Set(), new Set()] });
  }
  const walk = sliceWalks.get(slice);
  if (walk === undefined || walk.total !== total) {
    return await Promise.reject(
      refuse(`TJDFT slice ${slice} changed its count while it was listed`),
    );
  }
  const offset = passPage * BR_TJDFT_PAGE_SIZE;
  if (
    rows.length > BR_TJDFT_PAGE_SIZE ||
    (rows.length === 0 && offset < total)
  ) {
    return await Promise.reject(
      refuse(`TJDFT slice ${slice} page ${page} does not match its count`),
    );
  }
  const ids = walk.passes[pass];
  for (const row of rows) {
    ids.add(rowIdentityOf(row));
  }
  const pagesPerPass = Math.ceil(total / BR_TJDFT_PAGE_SIZE);
  if (passPage + 1 >= pagesPerPass && ids.size !== total) {
    return await Promise.reject(
      refuse(
        `TJDFT slice ${slice} listed ${ids.size} distinct records for a count of ${total}`,
      ),
    );
  }
  if (pass === VERIFYING_PASS && passPage + 1 >= pagesPerPass) {
    const [first, second] = walk.passes;
    sliceWalks.delete(slice);
    if (!sameIds(first, second)) {
      return await Promise.reject(
        refuse(
          `TJDFT slice ${slice} changed its records between two listings under an unchanged count`,
        ),
      );
    }
  }
  return {
    // The verifying pass reads ids only; the records came with the first.
    items:
      pass === VERIFYING_PASS
        ? []
        : rows
            .filter((row) => !isBrTjdftSecret(row))
            .map((row) => ({
              identity: {
                type: "document" as const,
                sourceDocumentId: rowIdentityOf(row),
              },
              payload: row,
            })),
    totalPages: 2 * pagesPerPass,
  };
};

const buildReconciliationDecision = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload) || isBrTjdftSecret(payload)) {
    return { type: "unkeyable" };
  }
  const built = await buildRow(payload, null, signal);
  if (Result.isError(built)) {
    return await Promise.reject(built.error);
  }
  switch (built.value.type) {
    case "built":
    case "quarantined":
      return { type: "built", decision: built.value.decision };
    case "detail-absent":
      return { type: "detail-unavailable" };
    // Retired: a record the court keeps secret is never held.
    case "excluded":
      return { type: "unkeyable" };
    case "unread":
      return await Promise.reject(
        new AdapterFetchError({
          message: "TJDFT reconciliation could not read a detail",
          adapterKey: KEY,
          cursor: null,
        }),
      );
    default:
      built.value satisfies never;
      return panic(`Unhandled TJDFT build: ${JSON.stringify(built.value)}`);
  }
};

// ── Replay ───────────────────────────────────────────────

const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: rowIdentityOf,
  });
  if (read.type === "rejected") {
    return read;
  }
  const detailRaw = read.parts[RAW_PART.DETAIL];
  const detail =
    detailRaw === undefined ? undefined : readBrTjdftSearch(detailRaw);
  const record = detail?.rows.at(0);
  if (detailRaw !== undefined && record === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail: "the stored detail response holds no record",
    };
  }
  const detailStatus = stored.metadata["detailStatus"];
  return {
    type: "parsed",
    result: assembleBrTjdftDecision({
      listing: read.listing,
      detail:
        detailRaw === undefined || record === undefined
          ? undefined
          : { record, raw: detailRaw },
      detailStatus:
        detailRaw !== undefined
          ? undefined
          : (Object.values(DETAIL_STATUS).find(
              (status) => status === detailStatus,
            ) ?? DETAIL_STATUS.UNREAD),
    }),
  };
};

// ── Source-field inventory ───────────────────────────────

const RECORD_FIELDS = [
  "base",
  "subbase",
  "sequencial",
  "uuid",
  "identificador",
  "versao",
  "uf",
  "processo",
  "codigoClasseCnj",
  "codigoSistjOrgaoJulgador",
  "descricaoOrgaoJulgador",
  "descricaoOrgao",
  "nomeRelator",
  "nomeRelatorDesignado",
  "nomeRevisor",
  "relatorAtivo",
  "turmaRecursal",
  "segredoJustica",
  "localDePublicacao",
  "paginaPublicacao",
  "dataJulgamento",
  "dataPublicacao",
  "decisao",
  "ementa",
  "marcadores",
  "termosAuxiliares",
  "possuiInteiroTeor",
  "inteiroTeor",
  "inteiroTeorHtml",
  "jurisprudenciaEmFoco",
] as const;

/** Facets of the one-record detail answer, named `agregacoes.<facet>`. */
const DETAIL_FACETS = [
  "agregacoes.classe",
  "agregacoes.relator",
  "agregacoes.relatorDesignado",
  "agregacoes.revisor",
  "agregacoes.orgaoJulgador",
  "agregacoes.base",
  "agregacoes.segredoJustica",
] as const;

const SOURCE_FIELDS = [...RECORD_FIELDS, ...DETAIL_FACETS] as const;

const metadataField = (key: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key },
});

const FACET_OF_RECORD = excludedSourceField(
  "a facet count over the one-record detail answer, restating a field the record carries and that is stored from it",
);

const BR_TJDFT_SOURCE_FIELDS = {
  base: metadataField("base"),
  subbase: metadataField("subbase"),
  sequencial: excludedSourceField(
    "the row's position in one search answer, a listing coordinate that changes with every query",
  ),
  uuid: { disposition: "stored", target: { type: "identity" } },
  identificador: metadataField("recordIdentifier"),
  versao: metadataField("recordVersion"),
  uf: metadataField("stateCode"),
  processo: metadataField("processNumber"),
  codigoClasseCnj: metadataField("cnjClassCode"),
  codigoSistjOrgaoJulgador: metadataField("chamberCode"),
  descricaoOrgaoJulgador: metadataField("chamber"),
  descricaoOrgao: metadataField("organ"),
  nomeRelator: metadataField("rapporteur"),
  nomeRelatorDesignado: metadataField("designatedRapporteur"),
  nomeRevisor: metadataField("reviser"),
  relatorAtivo: metadataField("rapporteurActive"),
  turmaRecursal: metadataField("turmaRecursal"),
  segredoJustica: metadataField("judicialSecrecy"),
  localDePublicacao: metadataField("publicationVenue"),
  paginaPublicacao: metadataField("publicationPage"),
  dataJulgamento: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  dataPublicacao: metadataField("publishedAt"),
  decisao: metadataField("outcome"),
  ementa: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  marcadores: excludedSourceField(
    "highlight offsets of the query terms in the answer, empty for the empty query the crawl sends; a property of the query, not of the decision",
  ),
  termosAuxiliares: metadataField("auxiliaryTerms"),
  possuiInteiroTeor: metadataField("hasFullText"),
  inteiroTeor: { disposition: "stored", target: { type: "document" } },
  inteiroTeorHtml: { disposition: "stored", target: { type: "document" } },
  jurisprudenciaEmFoco: {
    disposition: "stored",
    target: {
      type: "raw",
      part: RAW_PART.DETAIL,
      path: ["registros", "*", "jurisprudenciaEmFoco"],
      reason:
        "links to the court's editorial digest of related case law: a separate publication with its own URLs and an encoded excerpt, kept as served",
    },
  },
  "agregacoes.classe": metadataField("cnjClass"),
  "agregacoes.relator": FACET_OF_RECORD,
  "agregacoes.relatorDesignado": FACET_OF_RECORD,
  "agregacoes.revisor": FACET_OF_RECORD,
  "agregacoes.orgaoJulgador": FACET_OF_RECORD,
  "agregacoes.base": FACET_OF_RECORD,
  "agregacoes.segredoJustica": FACET_OF_RECORD,
} as const satisfies Record<
  (typeof SOURCE_FIELDS)[number],
  SourceFieldDisposition
>;

const keysOf = (raw: string | undefined): string[] => {
  if (raw === undefined) {
    return [];
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);
  return isRecord(parsed) ? Object.keys(parsed) : [];
};

/** Every field the listing row and the detail answer state. */
const listBrTjdftSourceFields = (parts: SourceRawParts): readonly string[] => {
  const fields = new Set(keysOf(parts[RAW_PART.LISTING]));
  const detail =
    parts[RAW_PART.DETAIL] === undefined
      ? null
      : Result.try({
          try: (): unknown => JSON.parse(parts[RAW_PART.DETAIL] ?? ""),
          catch: () => null,
        }).unwrapOr(null);
  if (isRecord(detail)) {
    const records = detail["registros"];
    if (Array.isArray(records)) {
      for (const record of records) {
        for (const key of isRecord(record) ? Object.keys(record) : []) {
          fields.add(key);
        }
      }
    }
    const facets = detail["agregacoes"];
    for (const facet of isRecord(facets) ? Object.keys(facets) : []) {
      fields.add(`agregacoes.${facet}`);
    }
  }
  return [...fields];
};

// ── Count ────────────────────────────────────────────────

const countOf = async (
  query: CountQuery,
  signal: AbortSignal,
): Promise<Result<number, AdapterFetchError>> =>
  (
    await search({
      body: countBody(query),
      stage: "listing",
      cursor: null,
      signal,
    })
  ).map(({ total }) => total);

/**
 * Every record of both bases the search counts, less the ones under judicial
 * secrecy, which are never stored. Records with no publication date stay in:
 * they are the corpus too, and the crawl cannot reach them, which is the gap
 * this figure is there to show.
 */
const COUNT_QUERIES = [
  { base: "acordaos", secretOnly: false },
  { base: "decisoes", secretOnly: false },
  // Decisões state no secrecy flag; only the acórdãos' secret count is taken.
  { base: "acordaos", secretOnly: true },
] as const satisfies readonly CountQuery[];

const totalCount = async (signal: AbortSignal): Promise<SourceTotalCount> => {
  let total = 0;
  for (const query of COUNT_QUERIES) {
    const count = await Result.tryPromise({
      try: async () => await countOf(query, signal),
      catch: (error) => error,
    });
    if (Result.isError(count)) {
      return { type: "probe-failed", errorTag: errorTag(count.error) };
    }
    if (Result.isError(count.value)) {
      return count.value.error.httpStatus === undefined
        ? sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD)
        : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS);
    }
    total += query.secretOnly ? -count.value.value : count.value.value;
  }
  return sourceTotalRead(total);
};

// ── Adapter ──────────────────────────────────────────────

const SOURCE_SURFACES = ["listing", "detail", "document-pdf"] as const;

const BR_TJDFT_SOURCE_SURFACES = {
  surfaces: {
    listing: storedSourceSurface(RAW_PART.LISTING),
    detail: storedSourceSurface(RAW_PART.DETAIL),
    "document-pdf": excludedSourceSurface(
      "a PDF rendering of the full text the detail answer already carries as inteiroTeorHtml",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

const DEFAULT_DEPENDENCIES: CrawlDependencies = { now: () => new Date() };

export const createBrTjdftAdapter = (
  dependencies: CrawlDependencies = DEFAULT_DEPENDENCIES,
) =>
  defineSourceAdapter({
    key: KEY,
    documentStage: "inline",
    language: LANGUAGE,
    minRequestIntervalMs: publisherRequestIntervalMs(KEY),
    pageTimeoutMs: PAGE_TIMEOUT_MS,
    sourceSurfaces: BR_TJDFT_SOURCE_SURFACES,
    sourceFields: {
      status: "declared",
      fields: BR_TJDFT_SOURCE_FIELDS,
      listSourceFields: listBrTjdftSourceFields,
    },
    fetchPage: async (cursor, _config, signal) =>
      await crawlPage(cursor, dependencies, signal),
    reparseStoredRaw,
    getTotalCount: totalCount,
    reconciliation: {
      // Listing coordinates and query highlights describe the answer, not
      // the record.
      revisionOf: (payload) =>
        isRecord(payload) ? listingContent(payload) : null,
      heldRequiresDetail: true,
      firstSlice: FIRST_SLICE,
      sliceOf,
      nextSlice: (slice) => nextSlice(slice, dependencies.now()),
      previousSlice,
      tipWindowDays: TIP_WINDOW_SLICES,
      listSlicePage: async (options) =>
        await listSlicePage(options, dependencies),
      buildDecision: buildReconciliationDecision,
    },
  });

export const brTjdftAdapter = createBrTjdftAdapter();
