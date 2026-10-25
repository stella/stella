import { panic, Result, TaggedError } from "better-result";
/**
 * Tribunal Superior do Trabalho (Brazil's superior labour court).
 *
 * One search endpoint lists everything the court publishes:
 * `POST /rest/pesquisa-textual/{start}/{size}` on its jurisprudence backend,
 * `start` a 1-based offset. A listed row is the whole record: identifiers,
 * docket, chamber, rapporteur, dates, subjects, the headnote (`ementa`), the
 * operative part (`dispositivo`) and the full text, so the listing is the
 * detail and there is no second request per decision. Six record types share
 * it: acórdãos and despachos (keyed by a 32-hex `id`), and súmulas,
 * orientações jurisprudenciais (ordinary and transitory) and precedentes
 * normativos (keyed by a small integer `id` of their own table).
 *
 * Three measurements decide the walk:
 *
 * **The offset stops at 10 000.** `start + size - 1` above 10 000 answers
 * 500, so every walk runs inside a window the publisher serves whole. One
 * publication day is that window: the busiest day measured held 7 528
 * records. A day above the ceiling is walked per record type instead, and a
 * type above it alone is a typed failure.
 *
 * **Publication-date windows partition the dated corpus.** Two adjacent
 * single-day windows sum to the window spanning both; `ordenacao: "data"`
 * returns the same ids in the same order for repeated requests. Judgment date
 * is no axis: the filter does not apply to despachos and precedents (it
 * returns all of them), and the court's collective vacations (2 to 31 January
 * and July, LOMAN art. 66) empty those months of judgments, which reads as an
 * anomaly and is not one.
 *
 * **Precedents are a small set, and some carry no date.** 1 292 súmulas, OJs
 * and precedentes normativos, 70 of the PNs with `dtaPublicacao: null`, so no
 * date window lists them. They are walked as one window ordered by number,
 * and reconciled as one undated slice.
 *
 * Cursor, therefore:
 *
 *   walk over the precedents window, then each publication day from the
 *   floor, oldest first, each window paged by offset to the count the
 *   publisher stated for it (a changed count restarts the window, rule 19);
 *   parked once the last closed day is walked.
 *
 * A day is closed once it is over in Brasília: the publisher's current day is
 * never walked. Parked, a cycle with no newly closed day costs no request and
 * returns its cursor; each closed day is walked once. The court keeps indexing
 * a day for weeks (despachos arrive four to eight weeks late), and what lands
 * after the walk passed is the reconciliation ledger's: its slices are the
 * same days, its tip re-lists the last week, and its listing verifies the
 * distinct identities it read against the count the publisher states for the
 * slice (rule 15). That is also the walk's verification pass: the crawl does
 * not re-read a window, because a listing row is the full decision and a
 * second pass would cost the whole corpus again.
 *
 * Thirteen acórdãos and despachos with no publication date are reachable by
 * no window and are a known blind spot of both walks.
 *
 * Signatories' tax identifiers (`codCPFSignatario`) are nulled before
 * anything is built, stored or handed to reconciliation: they are personal
 * data about the person who signed, not part of the decision. Fields the backend serves as the literal
 * "removido no backend" are placeholders and carry no text.
 */
import * as v from "valibot";

import {
  DECISION_DOCKET_GRAMMARS,
  formatDecisionDocket,
} from "@stll/api-contract/decision-docket-grammar";
import { sha256Hex } from "@stll/sha256/bun";
import { parsePlainDate, Temporal, todayFor } from "@stll/time";

import {
  defineSourceAdapter,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  isPersistableSourceDocumentId,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  SOURCE_TOTAL_PROBE_FAILURE,
  sourceTotalProbeFailed,
  sourceTotalRead,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  ListingIdentity,
  ReconciliationBuildOutcome,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  SourceFieldDisposition,
  SourceRawParts,
  SourceSurfaceCensus,
  SourceSurfaceDisposition,
  SourceTotalCount,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
  SyncPage,
} from "@/api/handlers/case-law/ingestion/adapter";
import { logDocumentParseFailure } from "@/api/handlers/case-law/ingestion/adapters/document-parse-failure";
import { buildPlainTextItem } from "@/api/handlers/case-law/ingestion/adapters/item-build";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readPublisherText,
  unreadPublisherError,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import { adapterCatch } from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  parseBrTstDespacho,
  parseBrTstHtml,
  parseBrTstPrecedent,
} from "@/api/handlers/case-law/ingestion/parsers/br-tst";
import type {
  BrTstDocumentIdentity,
  BrTstParsedDocument,
  BrTstParseError,
} from "@/api/handlers/case-law/ingestion/parsers/br-tst";
import { MAX_SLICE_PAGES } from "@/api/handlers/case-law/ingestion/slice-listing";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { DECISION_JUDGE_ROLE } from "@/api/handlers/case-law/judges/consts";
import {
  absentDecisionTextFields,
  absentTextField,
  checkedDecisionMetadata,
  sourceTextField,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { TextField } from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  BR_TST_PRECEDENTS_SLICE,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { logger } from "@/api/lib/observability/logger";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";
import { isRecord } from "@/api/lib/type-guards";

const ADAPTER_KEY = ADAPTER_KEYS.BR_TST;
const LANGUAGE = "pt";
const COUNTRY = ADAPTER_MANIFESTS[ADAPTER_KEY].country;

// ── Publisher boundary ───────────────────────────────────

const SEARCH_ORIGIN = "https://jurisprudencia-backend2.tst.jus.br";
const SEARCH_PATH = "/rest/pesquisa-textual";
/** The front end's origin, which the backend's CORS policy names; requests carry it as the front end's do. */
const FRONT_END_ORIGIN = "https://jurisprudencia.tst.jus.br";
/**
 * The court's document service, which serves each decision's signed PDF. The
 * adapter only links to it; the record already holds the text.
 */
const DOCUMENT_ORIGIN = "https://consultadocumento.tst.jus.br";

/** The only origin this adapter reaches (rule 21). */
const BR_TST_HOST_POLICY = {
  type: "exact-origin",
  origins: [SEARCH_ORIGIN],
} as const;

/** The highest `start + size - 1` the search serves; past it, a 500. */
export const BR_TST_OFFSET_CEILING = 10_000;

/** Rows per crawl request: an acórdão row is about 200 KB. */
const CRAWL_PAGE_SIZE = 20;

/**
 * Rows per reconciliation listing request. The shared listing walks at most
 * `MAX_SLICE_PAGES` pages of a slice, and a slice may hold up to the offset
 * ceiling, so the page has to cover the ceiling in that many pages.
 */
export const BR_TST_LISTING_PAGE_SIZE = Math.ceil(
  BR_TST_OFFSET_CEILING / MAX_SLICE_PAGES,
);

/**
 * Consecutive empty day windows one `fetchPage` steps over before it banks
 * its progress. Weekends, holidays and the December recess are empty, and so
 * are the first years after the floor.
 */
const MAX_EMPTY_WINDOW_SKIPS = 30;

/** The court's own day, which decides when a publication day is over. */
const PUBLISHER_TIME_ZONE = "America/Sao_Paulo";

const FIRST_DAY = ADAPTER_MANIFESTS[ADAPTER_KEY].dateRange.fromInclusive;

/** The literal the backend serves in place of the fields it strips. */
export const BR_TST_PLACEHOLDER = "removido no backend";

// ── Record types ─────────────────────────────────────────

export const BR_TST_TIPOS = [
  "ACORDAO",
  "DESPACHO",
  "SUM",
  "OJ",
  "OJT",
  "PN",
] as const;
export type BrTstTipo = (typeof BR_TST_TIPOS)[number];

const isTipo = (value: unknown): value is BrTstTipo =>
  BR_TST_TIPOS.some((tipo) => tipo === value);

/** What each record type is, in the court's language (rule 8). */
const DECISION_TYPES = {
  ACORDAO: "acórdão",
  DESPACHO: "despacho",
  SUM: "súmula",
  OJ: "orientação jurisprudencial",
  OJT: "orientação jurisprudencial transitória",
  PN: "precedente normativo",
} as const satisfies Record<BrTstTipo, string>;

const PRECEDENT_TIPOS = [
  "SUM",
  "OJ",
  "OJT",
  "PN",
] as const satisfies readonly BrTstTipo[];
type PrecedentTipo = (typeof PRECEDENT_TIPOS)[number];

const isPrecedentTipo = (tipo: BrTstTipo): tipo is PrecedentTipo =>
  PRECEDENT_TIPOS.some((candidate) => candidate === tipo);

// ── Windows and requests ─────────────────────────────────

/**
 * The parts a day is walked in when it holds more than the offset ceiling:
 * every record type the day can hold, each part on its own.
 */
const DAY_PARTS = ["acordao", "despacho", "precedentes"] as const;
type DayPart = "all" | (typeof DAY_PARTS)[number];

const DAY_PART_TIPOS = {
  all: [],
  acordao: ["ACORDAO"],
  despacho: ["DESPACHO"],
  precedentes: PRECEDENT_TIPOS,
} as const satisfies Record<DayPart, readonly BrTstTipo[]>;

type BrTstWindow =
  /** Everything the search holds, for its total count. */
  | { type: "corpus" }
  | { type: "precedents" }
  | { type: "day"; day: string; part: DayPart };

const TIPOS_OF_WINDOW = (window: BrTstWindow): readonly BrTstTipo[] => {
  switch (window.type) {
    case "corpus":
      return [];
    case "precedents":
      return PRECEDENT_TIPOS;
    case "day":
      return DAY_PART_TIPOS[window.part];
    default:
      window satisfies never;
      return panic(`Unhandled TST window: ${JSON.stringify(window)}`);
  }
};

/** The search body; every field is required, a missing one answers 400. */
export const brTstSearchBody = (window: BrTstWindow): string => {
  const tipos = TIPOS_OF_WINDOW(window);
  const day = window.type === "day" ? window.day : "";
  return JSON.stringify({
    ou: "",
    e: "",
    termoExato: "",
    naoContem: "",
    ementa: "",
    dispositivo: "",
    numeracaoUnica: {
      numero: "",
      ano: "",
      digito: "",
      orgao: "5",
      tribunal: "",
      vara: "",
    },
    orgaosJudicantes: [],
    ministros: [],
    convocados: [],
    classesProcessuais: [],
    codigosClassesPrecedentes: [],
    indicadores: [],
    assuntos: [],
    tipos,
    orgao: "TST",
    publicacaoInicial: day,
    publicacaoFinal: day,
    julgamentoInicial: "",
    julgamentoFinal: "",
    // `numero` orders precedents only; decisions answer nothing under it.
    ordenacao: window.type === "precedents" ? "numero" : "data",
  });
};

const searchResponseSchema = v.looseObject({
  totalRegistros: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  registros: v.array(
    v.looseObject({ registro: v.record(v.string(), v.unknown()) }),
  ),
});

type SearchPage = {
  reported: number;
  records: Record<string, unknown>[];
  url: string;
};

/** The search's answer was not the shape it states its results in. */
class BrTstResponseError extends TaggedError("BrTstResponseError")<{
  message: string;
}> {}

type SearchOptions = {
  window: BrTstWindow;
  /** Rows already read in the window: the request starts after them. */
  offset: number;
  size: number;
  cursor: string;
  signal?: AbortSignal | undefined;
};

const searchError = (cursor: string, message: string): AdapterFetchError =>
  new AdapterFetchError({
    message: `TST search: ${message}`,
    adapterKey: ADAPTER_KEY,
    cursor,
  });

/**
 * One search request. A 429 rejects after this one request (rule 19a); a
 * 5xx, a timeout or an unreadable body comes back as the page's failure, so
 * the cursor holds and nothing is retried inside the cycle: the backend's
 * 500 is also its answer to a request it will never serve.
 */
const search = async ({
  window,
  offset,
  size,
  cursor,
  signal,
}: SearchOptions): Promise<Result<SearchPage, AdapterFetchError>> => {
  if (offset + size > BR_TST_OFFSET_CEILING) {
    return panic(`TST request past the offset ceiling: ${offset} + ${size}`);
  }
  const target = restrictOutboundUrl({
    hostPolicy: BR_TST_HOST_POLICY,
    rawUrl: `${SEARCH_ORIGIN}${SEARCH_PATH}/${offset + 1}/${size}`,
  });
  if (target === null) {
    return panic("TST search escaped the publisher origin");
  }
  const outcome = await readPublisherText(target, {
    adapterKey: ADAPTER_KEY,
    fetchStage: "listing",
    timeoutMs: ADAPTER_TIMEOUT.LIST,
    signal,
    redirect: "error",
    refusalScope: "source",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: FRONT_END_ORIGIN,
    },
    body: brTstSearchBody(window),
  });
  if (outcome.type !== "present") {
    return Result.err(
      unreadPublisherError({
        outcome,
        message: "TST search could not be read",
        adapterKey: ADAPTER_KEY,
        cursor,
      }),
    );
  }
  const parsed = Result.try({
    try: () => v.parse(searchResponseSchema, JSON.parse(outcome.value)),
    catch: () =>
      new BrTstResponseError({
        message: `unreadable search response: ${outcome.value.slice(0, 200)}`,
      }),
  });
  if (Result.isError(parsed)) {
    return Result.err(searchError(cursor, parsed.error.message));
  }
  return Result.ok({
    reported: parsed.value.totalRegistros,
    records: parsed.value.registros.map(({ registro }) => registro),
    url: target.toString(),
  });
};

// ── Records ──────────────────────────────────────────────

/** Fields kept by name only: a signatory's personal tax identifier (CPF). */
const WITHHELD_FIELDS = new Set(["codCPFSignatario"]);

/**
 * The record as the adapter keeps it: everything the publisher listed, with
 * the signatory's tax identifier nulled. Built before anything else reads the
 * row, so no stored part, payload or metadata carries the identifier, while
 * the stored record still states that the publisher served the field.
 */
export const brTstRetainedRecord = (
  record: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      WITHHELD_FIELDS.has(key) ? null : value,
    ]),
  );

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** A text field, or nothing where the backend left its placeholder. */
const textOf = (value: unknown): string | undefined => {
  const text = stringOf(value);
  return text === undefined || text.trim() === BR_TST_PLACEHOLDER
    ? undefined
    : text;
};

const tipoOf = (record: Record<string, unknown>): unknown => {
  const tipo = record["tipo"];
  return isRecord(tipo) ? tipo["codigoTipoJurisprudencia"] : undefined;
};

/** A publisher id as its digits or hex: a number only when it is exact. */
const idOf = (record: Record<string, unknown>): string | undefined => {
  const id = record["id"];
  if (typeof id === "number") {
    return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  }
  return stringOf(id);
};

/**
 * The row's identity: its record type and the id that type's table gives
 * it. Decisions and precedents are numbered by different tables, so the type
 * is part of the key.
 */
export const brTstSourceDocumentId = (
  record: Record<string, unknown>,
): string | undefined => {
  const tipo = tipoOf(record);
  const id = idOf(record);
  if (typeof tipo !== "string" || tipo.trim() === "" || id === undefined) {
    return undefined;
  }
  const identity = `${tipo}:${id}`;
  return isPersistableSourceDocumentId(identity) ? identity : undefined;
};

export const brTstListingIdentity = (
  record: Record<string, unknown>,
): ListingIdentity => {
  const sourceDocumentId = brTstSourceDocumentId(record);
  return sourceDocumentId === undefined
    ? { type: "unidentifiable" }
    : { type: "document", sourceDocumentId };
};

/**
 * How a record's docket was read.
 *
 * A decision is filed under a CNJ number, which the BRA grammar reads from
 * `numFormatado` (class, hyphen, number) or, where the class is missing or
 * the grammar refuses the print, from the twenty digits in `numero`. A
 * precedent has no docket: it is cited by its type, chamber and number, which
 * the grammar does not read, so it takes the court's short label built from
 * the record's own codes (`SUM-331`, `OJ-SDI1-394`, `PN-119`).
 */
type DocketReading =
  | { type: "docket"; formatted: string; field: "numFormatado" | "numero" }
  | { type: "precedent-label"; label: string }
  | { type: "refused"; printed: string | undefined };

const docketOf = (record: Record<string, unknown>): DocketReading => {
  for (const field of ["numFormatado", "numero"] as const) {
    const raw = stringOf(record[field]);
    const parsed =
      raw === undefined ? null : DECISION_DOCKET_GRAMMARS.BRA.parse(raw);
    if (parsed !== null) {
      return { type: "docket", formatted: formatDecisionDocket(parsed), field };
    }
  }
  return {
    type: "refused",
    printed: stringOf(record["numFormatado"])?.trim(),
  };
};

const precedentLabelOf = (
  tipo: PrecedentTipo,
  record: Record<string, unknown>,
): DocketReading => {
  const numero = record["numero"];
  const chamber = record["orgaoJudicante"];
  const sigla = isRecord(chamber)
    ? stringOf(chamber["sigla"])?.trim()
    : undefined;
  if (typeof numero !== "number" || !Number.isSafeInteger(numero)) {
    return { type: "refused", printed: undefined };
  }
  return {
    type: "precedent-label",
    label: [tipo, ...(sigla === undefined ? [] : [sigla]), String(numero)].join(
      "-",
    ),
  };
};

/**
 * The process class a decision is filed under, as `numFormatado` prints it
 * before the number (`Ag-RR - 404-14.2012.5.04.0028`). The stored docket is
 * the CNJ number alone, so the class is kept beside it.
 */
const processClassOf = (
  record: Record<string, unknown>,
): string | undefined => {
  const printed = stringOf(record["numFormatado"]);
  const separator = printed?.indexOf(" - ") ?? -1;
  const processClass =
    printed === undefined || separator < 0
      ? ""
      : printed.slice(0, separator).trim();
  return processClass === "" ? undefined : processClass;
};

/** `2020-01-31T07:00:00-03` as the document service spells it. */
const documentServiceDate = (published: string): string | undefined => {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<time>\d{2}:\d{2}:\d{2})/u.exec(
      published,
    )?.groups;
  const year = match?.["year"];
  const month = match?.["month"];
  const day = match?.["day"];
  const time = match?.["time"];
  return year === undefined ||
    month === undefined ||
    day === undefined ||
    time === undefined
    ? undefined
    : `${day}/${month}/${year} ${time}`;
};

const digitsOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined;

/**
 * The decision's signed PDF on the court's document service, addressed by
 * the record's internal process number, its publication instant and the
 * document's own number (`numInterno` for an acórdão, `numMinuta` for a
 * despacho). Rebuilt from those fields, never taken from a payload.
 */
const documentUrlOf = (
  tipo: "ACORDAO" | "DESPACHO",
  record: Record<string, unknown>,
): string | undefined => {
  const year = digitsOf(record["anoProcInt"]);
  const number = digitsOf(record["numProcInt"]);
  const published = stringOf(record["dtaPublicacao"]);
  const date =
    published === undefined ? undefined : documentServiceDate(published);
  const document = digitsOf(
    record[tipo === "ACORDAO" ? "numInterno" : "numMinuta"],
  );
  if (
    year === undefined ||
    number === undefined ||
    date === undefined ||
    document === undefined
  ) {
    return undefined;
  }
  const page = tipo === "ACORDAO" ? "acordao.do" : "despacho.do";
  return `${DOCUMENT_ORIGIN}/consultaDocumento/${page}?${new URLSearchParams({
    anoProcInt: year,
    numProcInt: number,
    dtaPublicacaoStr: date,
    nia: document,
  }).toString()}`;
};

/**
 * Fields the record states that the row does not keep as metadata: the
 * identity, the texts that become the document or a text field, and the
 * publisher's own renderings of those texts. Every one of them is in the
 * stored listing, so a later parser can still read it.
 */
const NOT_METADATA = new Set([
  ...WITHHELD_FIELDS,
  "id",
  "ementa",
  "inteiroTeorHtml",
  "txtConteudoDecisao",
  "titulo",
  "tese",
  "observacao",
  "historico",
  "inteiroTeorHTMLHighlight",
  "txtEmentaHighlight",
  "txtConteudoDecisaoHighlight",
  "tituloHighlight",
  "teseHighlight",
  "observacaoHighlight",
  "textoPesquisavel",
  "textoPesquisavelNaoAnalisado",
]);

/**
 * Fields the backend strips and serves as the placeholder. Never read as
 * text; a value other than the placeholder means the backend changed, which
 * an operator should hear about, while the stored listing keeps it.
 */
export const BR_TST_PLACEHOLDER_FIELDS = [
  "ementaHtml",
  "ementaNaoAnalisada",
  "txtInteiroTeor",
  "txtInteiroTeorNaoAnalisado",
  "inteiroTeorRtf",
  "dispositivoNaoAnalisado",
  "conteudoDecisao",
  "conteudoDecisaoNaoAnalisado",
] as const;

const PLACEHOLDER_FIELD_SET = new Set<string>(BR_TST_PLACEHOLDER_FIELDS);

const reportPlaceholderDrift = (
  record: Record<string, unknown>,
  sourceDocumentId: string,
): void => {
  const drifted = BR_TST_PLACEHOLDER_FIELDS.filter((field) => {
    const value = record[field];
    return (
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim() === BR_TST_PLACEHOLDER)
    );
  });
  if (drifted.length > 0) {
    logger.warn("case_law.ingestion.br_tst_placeholder_carries_value", {
      adapterKey: ADAPTER_KEY,
      documentId: sourceDocumentId,
      fields: drifted.join(","),
    });
  }
};

/** Everything else the record states, under the publisher's own names. */
const publisherMetadataOf = (
  record: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        !NOT_METADATA.has(key) &&
        !PLACEHOLDER_FIELD_SET.has(key) &&
        value !== undefined,
    ),
  );

const RAW_PART = { LISTING: "listing" } as const;

type BuiltRecord =
  | { type: "built"; decision: IngestionResult }
  /** Kept as a listing-only row: the record is listed, its type is not ours. */
  | { type: "unbuildable"; decision: IngestionResult; reason: string };

type DocumentRead =
  | { type: "parsed"; parsed: BrTstParsedDocument }
  | { type: "absent" }
  | { type: "failed"; error: BrTstParseError };

const readDocument = (
  tipo: BrTstTipo,
  record: Record<string, unknown>,
  identity: BrTstDocumentIdentity,
): DocumentRead => {
  const settle = (
    parsed: Result<BrTstParsedDocument, BrTstParseError>,
  ): DocumentRead =>
    Result.isOk(parsed)
      ? { type: "parsed", parsed: parsed.value }
      : { type: "failed", error: parsed.error };
  switch (tipo) {
    case "ACORDAO": {
      const html = textOf(record["inteiroTeorHtml"]);
      return html === undefined
        ? { type: "absent" }
        : settle(parseBrTstHtml(html, identity));
    }
    case "DESPACHO": {
      const text = textOf(record["txtConteudoDecisao"]);
      return text === undefined
        ? { type: "absent" }
        : settle(parseBrTstDespacho(text, identity));
    }
    case "SUM":
    case "OJ":
    case "OJT":
    case "PN": {
      const fields = {
        titulo: textOf(record["titulo"]),
        tese: textOf(record["tese"]),
        observacao: textOf(record["observacao"]),
        historico: textOf(record["historico"]),
      };
      return Object.values(fields).every((value) => value === undefined)
        ? { type: "absent" }
        : settle(parseBrTstPrecedent(fields, identity));
    }
    default:
      tipo satisfies never;
      return panic(`Unhandled TST record type: ${String(tipo)}`);
  }
};

/**
 * The acórdão's ementa as its headnote. The placeholder the backend serves for
 * the fields it strips is the publisher saying the text is not here.
 */
const headnoteOf = (record: Record<string, unknown>): TextField => {
  const ementa = stringOf(record["ementa"]);
  return ementa?.trim() === BR_TST_PLACEHOLDER
    ? absentTextField(TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER)
    : sourceTextField(ADAPTER_KEY, ementa);
};

/** A decision date the record states as a calendar day. */
const judgmentDateOf = (
  record: Record<string, unknown>,
): string | undefined => {
  const value = stringOf(record["dtaJulgamento"]);
  return value === undefined ? undefined : parsePlainDate(value)?.toString();
};

const courtOf = (record: Record<string, unknown>): string | undefined => {
  const organ = record["orgao"];
  return isRecord(organ) ? stringOf(organ["nome"])?.trim() : undefined;
};

/**
 * Build one listed record into its decision. No I/O: the crawl, the
 * reconciliation walk and a replay of the stored envelope all reach this with
 * the same retained record.
 */
/** What a record is keyed and built as, or why it cannot be built. */
type RecordReading =
  | {
      type: "readable";
      tipo: BrTstTipo;
      court: string;
      sourceDocumentId: string;
    }
  | { type: "unbuildable"; reason: string; court: string | undefined };

const readingOf = (record: Record<string, unknown>): RecordReading => {
  const tipo = tipoOf(record);
  const court = courtOf(record);
  const sourceDocumentId = brTstSourceDocumentId(record);
  if (!isTipo(tipo)) {
    return {
      type: "unbuildable",
      reason: `record type ${String(tipo)} is not one this adapter reads`,
      court,
    };
  }
  if (court === undefined) {
    return { type: "unbuildable", reason: "the record names no court", court };
  }
  if (sourceDocumentId === undefined) {
    return {
      type: "unbuildable",
      reason: "the record states no type and id to key it by",
      court,
    };
  }
  return { type: "readable", tipo, court, sourceDocumentId };
};

const caseNumberOf = (
  docket: DocketReading,
  sourceDocumentId: string,
): string => {
  switch (docket.type) {
    case "docket":
      return docket.formatted;
    case "precedent-label":
      return docket.label;
    case "refused":
      return docket.printed ?? sourceDocumentId;
    default:
      docket satisfies never;
      return panic(`Unhandled TST docket reading: ${JSON.stringify(docket)}`);
  }
};

/** The parts of a row every build states alike, from the retained record. */
const storedRecordOf = (record: Record<string, unknown>) => {
  const listing = JSON.stringify(record);
  const sourceRaw = encodeSourceRawEnvelope({ [RAW_PART.LISTING]: listing });
  return {
    // A row with no identity of its own is quarantined under its content
    // (rule 20): the listing proves it exists, and nothing else names it.
    sourceDocumentId:
      brTstSourceDocumentId(record) ?? `quarantine:${sha256Hex(listing)}`,
    country: COUNTRY,
    language: LANGUAGE,
    rawHash: sourceFingerprint({ sourceRaw }),
    parserVersion: PARSER_VERSIONS[ADAPTER_KEY],
    sourceRaw,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  };
};

/** A listed record kept as a listing-only row under its identity (rule 20). */
const unbuildableRecord = (
  record: Record<string, unknown>,
  { reason, court }: Extract<RecordReading, { type: "unbuildable" }>,
): BuiltRecord => {
  const stored = storedRecordOf(record);
  return {
    type: "unbuildable",
    reason,
    decision: plainTextIngestionResult({
      ...stored,
      caseNumber: stored.sourceDocumentId,
      caseNumberIsPlaceholder: true,
      isListingOnly: true,
      // Only a record that names no court reaches this without one; the row
      // is a listing-only quarantine, never a published decision.
      court: court ?? ADAPTER_MANIFESTS[ADAPTER_KEY].publisher,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.PARSE_FAILED),
      documentAst: EMPTY_AST,
      metadata: checkedDecisionMetadata({
        ...publisherMetadataOf(record),
        buildFailure: reason,
      }),
    }),
  };
};

export const buildBrTstDecision = (
  listed: Record<string, unknown>,
): BuiltRecord => {
  const record = brTstRetainedRecord(listed);
  const reading = readingOf(record);
  if (reading.type === "unbuildable") {
    return unbuildableRecord(record, reading);
  }
  const { tipo, court, sourceDocumentId } = reading;
  const common = storedRecordOf(record);
  reportPlaceholderDrift(record, sourceDocumentId);

  const docket = isPrecedentTipo(tipo)
    ? precedentLabelOf(tipo, record)
    : docketOf(record);
  const caseNumber = caseNumberOf(docket, sourceDocumentId);
  const decisionType = DECISION_TYPES[tipo];
  const decisionDate = tipo === "ACORDAO" ? judgmentDateOf(record) : undefined;
  const identity = {
    sourceDocumentId,
    caseNumber,
    court,
    decisionDate,
    decisionType,
  } satisfies BrTstDocumentIdentity;
  const document = readDocument(tipo, record, identity);
  if (document.type === "failed") {
    logDocumentParseFailure({
      adapterKey: ADAPTER_KEY,
      caseNumber,
      error: document.error,
    });
  }
  const parsed = document.type === "parsed" ? document.parsed : undefined;
  const documentUrl =
    tipo === "ACORDAO" || tipo === "DESPACHO"
      ? documentUrlOf(tipo, record)
      : undefined;
  const rapporteur = stringOf(record["nomRelator"])?.trim();
  const processClass = isPrecedentTipo(tipo)
    ? undefined
    : processClassOf(record);
  const headnote = tipo === "ACORDAO" ? headnoteOf(record) : undefined;

  return {
    type: "built",
    decision: plainTextIngestionResult({
      ...common,
      caseNumber,
      ...(docket.type === "refused" && docket.printed === undefined
        ? { caseNumberIsPlaceholder: true }
        : {}),
      court,
      decisionType,
      ...(decisionDate === undefined ? {} : { decisionDate }),
      ...(parsed === undefined ? {} : { fulltext: parsed.fulltext }),
      ...(parsed?.sections === undefined ? {} : { sections: parsed.sections }),
      ...(documentUrl === undefined ? {} : { documentUrl }),
      ...(rapporteur === undefined
        ? {}
        : {
            judges: [
              {
                role: DECISION_JUDGE_ROLE.RAPPORTEUR,
                nameAsPrinted: rapporteur,
              },
            ],
          }),
      textFields: {
        ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        ...(headnote === undefined ? {} : { headnote }),
      },
      documentAst: parsed?.documentAst ?? EMPTY_AST,
      metadata: checkedDecisionMetadata({
        ...publisherMetadataOf(record),
        caseNumber,
        decisionType,
        ...(decisionDate === undefined
          ? { decisionDateAvailability: { status: "not-published-by-source" } }
          : { decisionDate }),
        docketReading: docket,
        ...(processClass === undefined ? {} : { processClass }),
        // Brazil has no ECLI, and the record states none.
        ecliAvailability: { status: "not_published" },
        // The search serves no page per decision; the record is the source.
        sourceUrlStatus: "not-published-by-source",
      }),
    }),
  };
};

// ── Source-field inventory ───────────────────────────────

/** Every field the search states on a record of any of the six types. */
const SOURCE_FIELDS = [
  // shared by the decisions
  "anoProc",
  "anoProcInt",
  "codCPFSignatario",
  "codFase",
  "codMinRelator",
  "dtaAtualizacao",
  "dtaFase",
  "dtaOrdenacao",
  "dtaPublicacao",
  "id",
  "indicadores",
  "nomRelator",
  "numFormatado",
  "numProcDocumento",
  "numProcInt",
  "numeracaoUnica",
  "numero",
  "orgao",
  "orgaoJudicante",
  "sexRelator",
  "temaProcs",
  "tipo",
  "txtIndicador",
  "txtTemaProc",
  // acórdãos
  "dispositivo",
  "dispositivoNaoAnalisado",
  "dtaJulgamento",
  "ementa",
  "ementaHtml",
  "ementaNaoAnalisada",
  "indTipAcordao",
  "inteiroTeorHTMLHighlight",
  "inteiroTeorHtml",
  "inteiroTeorRtf",
  "numFormatadoAnt",
  "numInterno",
  "numProc",
  "numeracaoAnterior",
  "tipoDecisoes",
  "txtEmentaHighlight",
  "txtInteiroTeor",
  "txtInteiroTeorNaoAnalisado",
  // despachos
  "codAndCgjt",
  "conteudoDecisao",
  "conteudoDecisaoNaoAnalisado",
  "indIndexacao",
  "numDigAnt",
  "numMinuta",
  "numProcAnt",
  "numSeqProcesso",
  "numVaraAtual",
  "numVersaoMinuta",
  "subTipo",
  "txtConteudoDecisao",
  "txtConteudoDecisaoHighlight",
  // súmulas, orientações jurisprudenciais, precedentes normativos
  "dataPrimeiraPublicacao",
  "dataSegundaPublicacao",
  "dataUltimaPublicacao",
  "historico",
  "indiceNumero",
  "indiceTipo",
  "observacao",
  "observacaoHighlight",
  "precedentes",
  "precedentesExternos",
  "situacao",
  "tese",
  "teseHighlight",
  "textoPesquisavel",
  "textoPesquisavelNaoAnalisado",
  "titulo",
  "tituloHighlight",
] as const;

type BrTstSourceField = (typeof SOURCE_FIELDS)[number];

const storedAs = (key: string) =>
  ({ disposition: "stored", target: { type: "metadata", key } }) as const;

const PLACEHOLDER_REASON =
  "served as the literal 'removido no backend' on every record: the backend strips the field, and the text it named is stored from ementa, dispositivo, inteiroTeorHtml or txtConteudoDecisao";

const HIGHLIGHT_REASON =
  "the search's highlight rendering of a stored text, re-serialized with the query's hits marked; the crawl sends no terms, and the verbatim rendering stays in the stored listing";

const BR_TST_SOURCE_FIELDS = {
  anoProc: storedAs("anoProc"),
  anoProcInt: storedAs("anoProcInt"),
  codCPFSignatario: excludedSourceField(
    "the signatory's personal tax identifier (CPF), which is not part of the decision; nulled before the record is stored or read, for data minimization",
  ),
  codFase: storedAs("codFase"),
  codMinRelator: storedAs("codMinRelator"),
  dtaAtualizacao: storedAs("dtaAtualizacao"),
  dtaFase: storedAs("dtaFase"),
  dtaOrdenacao: storedAs("dtaOrdenacao"),
  dtaPublicacao: storedAs("dtaPublicacao"),
  id: { disposition: "stored", target: { type: "identity" } },
  indicadores: storedAs("indicadores"),
  nomRelator: {
    disposition: "stored",
    target: { type: "result", key: "judges" },
  },
  numFormatado: {
    disposition: "stored",
    target: { type: "result", key: "caseNumber" },
  },
  numProcDocumento: storedAs("numProcDocumento"),
  numProcInt: storedAs("numProcInt"),
  numeracaoUnica: storedAs("numeracaoUnica"),
  numero: storedAs("numero"),
  orgao: { disposition: "stored", target: { type: "result", key: "court" } },
  orgaoJudicante: storedAs("orgaoJudicante"),
  sexRelator: storedAs("sexRelator"),
  temaProcs: storedAs("temaProcs"),
  tipo: {
    disposition: "stored",
    target: { type: "result", key: "decisionType" },
  },
  txtIndicador: storedAs("txtIndicador"),
  txtTemaProc: storedAs("txtTemaProc"),

  dispositivo: storedAs("dispositivo"),
  dispositivoNaoAnalisado: excludedSourceField(PLACEHOLDER_REASON),
  dtaJulgamento: {
    disposition: "stored",
    target: { type: "result", key: "decisionDate" },
  },
  ementa: {
    disposition: "stored",
    target: { type: "textField", key: "headnote" },
  },
  ementaHtml: excludedSourceField(PLACEHOLDER_REASON),
  ementaNaoAnalisada: excludedSourceField(PLACEHOLDER_REASON),
  indTipAcordao: storedAs("indTipAcordao"),
  inteiroTeorHTMLHighlight: excludedSourceField(HIGHLIGHT_REASON),
  inteiroTeorHtml: { disposition: "stored", target: { type: "document" } },
  inteiroTeorRtf: excludedSourceField(PLACEHOLDER_REASON),
  numFormatadoAnt: storedAs("numFormatadoAnt"),
  numInterno: storedAs("numInterno"),
  numProc: storedAs("numProc"),
  numeracaoAnterior: storedAs("numeracaoAnterior"),
  tipoDecisoes: storedAs("tipoDecisoes"),
  txtEmentaHighlight: excludedSourceField(HIGHLIGHT_REASON),
  txtInteiroTeor: excludedSourceField(PLACEHOLDER_REASON),
  txtInteiroTeorNaoAnalisado: excludedSourceField(PLACEHOLDER_REASON),

  codAndCgjt: storedAs("codAndCgjt"),
  conteudoDecisao: excludedSourceField(PLACEHOLDER_REASON),
  conteudoDecisaoNaoAnalisado: excludedSourceField(PLACEHOLDER_REASON),
  indIndexacao: storedAs("indIndexacao"),
  numDigAnt: storedAs("numDigAnt"),
  numMinuta: storedAs("numMinuta"),
  numProcAnt: storedAs("numProcAnt"),
  numSeqProcesso: storedAs("numSeqProcesso"),
  numVaraAtual: storedAs("numVaraAtual"),
  numVersaoMinuta: storedAs("numVersaoMinuta"),
  subTipo: storedAs("subTipo"),
  txtConteudoDecisao: { disposition: "stored", target: { type: "document" } },
  txtConteudoDecisaoHighlight: excludedSourceField(HIGHLIGHT_REASON),

  dataPrimeiraPublicacao: storedAs("dataPrimeiraPublicacao"),
  dataSegundaPublicacao: storedAs("dataSegundaPublicacao"),
  dataUltimaPublicacao: storedAs("dataUltimaPublicacao"),
  historico: { disposition: "stored", target: { type: "document" } },
  indiceNumero: storedAs("indiceNumero"),
  indiceTipo: storedAs("indiceTipo"),
  observacao: { disposition: "stored", target: { type: "document" } },
  observacaoHighlight: excludedSourceField(HIGHLIGHT_REASON),
  precedentes: storedAs("precedentes"),
  precedentesExternos: storedAs("precedentesExternos"),
  situacao: storedAs("situacao"),
  tese: { disposition: "stored", target: { type: "document" } },
  teseHighlight: excludedSourceField(HIGHLIGHT_REASON),
  textoPesquisavel: excludedSourceField(
    "the search's index text: number, title, thesis and note run together, each of which is stored on its own",
  ),
  textoPesquisavelNaoAnalisado: excludedSourceField(
    "the unanalysed copy of textoPesquisavel, character for character the same text",
  ),
  titulo: { disposition: "stored", target: { type: "document" } },
  tituloHighlight: excludedSourceField(HIGHLIGHT_REASON),
} as const satisfies Record<BrTstSourceField, SourceFieldDisposition>;

/** The stored record's own keys: what the publisher stated for it. */
const listBrTstSourceFields = (parts: SourceRawParts): readonly string[] => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(parts[RAW_PART.LISTING] ?? ""),
    catch: () => null,
  }).unwrapOr(null);
  return isRecord(parsed) ? Object.keys(parsed) : [];
};

/**
 * The court's addresses for one decision. The record is the decision; the
 * signed PDF is a rendering of the same text, and the search front end
 * renders the record it was served.
 */
const SOURCE_SURFACES = ["search-record", "signed-pdf", "front-end"] as const;

const BR_TST_SOURCE_SURFACES = {
  surfaces: {
    "search-record": storedSourceSurface(RAW_PART.LISTING),
    "signed-pdf": excludedSourceSurface(
      "the signed PDF the document service renders from the text the record carries; linked as documentUrl, and its robots policy asks not to be indexed",
    ),
    "front-end": excludedSourceSurface(
      "the search application renders the same record the adapter stores, with no field of its own",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Replay ───────────────────────────────────────────────

const reparseBrTstStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.LISTING,
    identityOf: brTstSourceDocumentId,
  });
  if (read.type === "rejected") {
    return read;
  }
  const built = buildBrTstDecision(read.listing);
  return built.type === "built"
    ? { type: "parsed", result: built.decision }
    : {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
        detail: built.reason,
      };
};

// ── Slices ───────────────────────────────────────────────

const addDays = (day: string, days: number): string =>
  (parsePlainDate(day) ?? panic(`TST slice is not a calendar day: ${day}`))
    .add({ days })
    .toString();

const todayInBrasilia = (now: Temporal.Instant): string =>
  todayFor(PUBLISHER_TIME_ZONE, now).toString();

/** The newest publication day that is over in Brasília. */
export const brTstLastClosedDay = (now: Temporal.Instant): string =>
  addDays(todayInBrasilia(now), -1);

const instantOf = (now: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(now.getTime());

const sliceOf = (now: Date): string => todayInBrasilia(instantOf(now));

const nextSlice = (slice: string): string | null => {
  if (slice === BR_TST_PRECEDENTS_SLICE) {
    return FIRST_DAY;
  }
  const next = addDays(slice, 1);
  return next > sliceOf(new Date()) ? null : next;
};

const previousSlice = (slice: string): string | null => {
  if (slice === BR_TST_PRECEDENTS_SLICE) {
    return null;
  }
  return slice <= FIRST_DAY ? BR_TST_PRECEDENTS_SLICE : addDays(slice, -1);
};

/** A week of days re-listed on the fast cadence, while the court indexes them. */
const TIP_WINDOW_DAYS = 7;

type ParsedSlice = { type: "precedents" } | { type: "day"; day: string };

const parseSlice = (slice: string): ParsedSlice | null => {
  if (slice === BR_TST_PRECEDENTS_SLICE) {
    return { type: "precedents" };
  }
  const day = parsePlainDate(slice);
  return day === null || day.toString() < FIRST_DAY
    ? null
    : { type: "day", day: day.toString() };
};

/**
 * What one slice's listing has read so far, so its last page can hold the
 * distinct identities it listed against the count the publisher stated
 * (rule 15). The shared listing reads a slice's pages in order in one call,
 * so the record lives from its first page to its last.
 */
type SliceListing = {
  windows: readonly {
    window: BrTstWindow;
    reported: number;
    firstPage: number;
  }[];
  reported: number;
  seen: Set<string>;
  /** Rows with no identity: counted, since the publisher counts them too. */
  unidentifiable: number;
};

const sliceListings = new Map<string, SliceListing>();

type WindowCount = { window: BrTstWindow; reported: number };

const countWindow = async (
  window: BrTstWindow,
  slice: string,
  signal: AbortSignal | undefined,
): Promise<Result<WindowCount, AdapterFetchError>> => {
  const counted = await search({
    window,
    offset: 0,
    size: 0,
    cursor: slice,
    signal,
  });
  return counted.map(({ reported }) => ({ window, reported }));
};

/**
 * The windows a slice is listed in: its one window, or, for a day past the
 * offset ceiling, each part of the day, with the publisher's count for each.
 */
const planSlice = async (
  parsed: ParsedSlice,
  slice: string,
  signal: AbortSignal | undefined,
): Promise<Result<SliceListing, AdapterFetchError>> => {
  const whole: BrTstWindow =
    parsed.type === "precedents"
      ? { type: "precedents" }
      : { type: "day", day: parsed.day, part: "all" };
  const counted = await countWindow(whole, slice, signal);
  if (Result.isError(counted)) {
    return counted;
  }
  const counts: WindowCount[] = [];
  if (
    counted.value.reported <= BR_TST_OFFSET_CEILING ||
    parsed.type === "precedents"
  ) {
    counts.push(counted.value);
  } else {
    for (const part of DAY_PARTS) {
      const partCount = await countWindow(
        { type: "day", day: parsed.day, part },
        slice,
        signal,
      );
      if (Result.isError(partCount)) {
        return partCount;
      }
      counts.push(partCount.value);
    }
  }
  const overCeiling = counts.find(
    ({ reported }) => reported > BR_TST_OFFSET_CEILING,
  );
  if (overCeiling !== undefined) {
    return Result.err(
      searchError(
        slice,
        `a window reports ${overCeiling.reported} records, past the ${BR_TST_OFFSET_CEILING} the search serves`,
      ),
    );
  }
  const windows: SliceListing["windows"][number][] = [];
  let firstPage = 0;
  for (const { window, reported } of counts) {
    windows.push({ window, reported, firstPage });
    firstPage += Math.ceil(reported / BR_TST_LISTING_PAGE_SIZE);
  }
  return Result.ok({
    windows,
    reported: counted.value.reported,
    seen: new Set(),
    unidentifiable: 0,
  });
};

const listBrTstSlicePage = async ({
  page,
  signal,
  slice,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const parsed = parseSlice(slice);
  if (parsed === null) {
    return await Promise.reject(
      searchError(slice, `not a TST slice: ${slice}`),
    );
  }
  if (page === 0) {
    const planned = await planSlice(parsed, slice, signal);
    if (Result.isError(planned)) {
      return await Promise.reject(planned.error);
    }
    sliceListings.set(slice, planned.value);
  }
  const listing = sliceListings.get(slice);
  if (listing === undefined) {
    return await Promise.reject(
      searchError(
        slice,
        `page ${page} of a listing that never read its first page`,
      ),
    );
  }
  const totalPages = listing.windows.reduce(
    (pages, { reported }) =>
      pages + Math.ceil(reported / BR_TST_LISTING_PAGE_SIZE),
    0,
  );
  if (totalPages === 0) {
    sliceListings.delete(slice);
    return { items: [], totalPages: 0 };
  }
  const located = listing.windows.findLast(
    ({ firstPage }) => firstPage <= page,
  );
  if (located === undefined || page >= totalPages) {
    sliceListings.delete(slice);
    return await Promise.reject(
      searchError(slice, `page ${page} is past the slice`),
    );
  }
  const offset = (page - located.firstPage) * BR_TST_LISTING_PAGE_SIZE;
  const read = await search({
    window: located.window,
    offset,
    size: Math.min(BR_TST_LISTING_PAGE_SIZE, located.reported - offset),
    cursor: slice,
    signal,
  });
  if (Result.isError(read)) {
    sliceListings.delete(slice);
    return await Promise.reject(read.error);
  }
  if (read.value.reported !== located.reported) {
    sliceListings.delete(slice);
    return await Promise.reject(
      searchError(
        slice,
        `the count moved from ${located.reported} to ${read.value.reported} while the slice was listed`,
      ),
    );
  }
  const items = read.value.records.map((listed) => {
    const payload = brTstRetainedRecord(listed);
    const identity = brTstListingIdentity(payload);
    if (identity.type === "document") {
      listing.seen.add(identity.sourceDocumentId);
    } else {
      listing.unidentifiable += 1;
    }
    return { identity, payload };
  });
  if (page + 1 < totalPages) {
    return { items, totalPages };
  }
  sliceListings.delete(slice);
  // Offsets over a set that reordered between pages repeat some rows and
  // skip others; the count of distinct ids is what shows it.
  const listed = listing.seen.size + listing.unidentifiable;
  if (listed !== listing.reported) {
    return await Promise.reject(
      searchError(
        slice,
        `listed ${listed} distinct records of the ${listing.reported} the publisher counts`,
      ),
    );
  }
  return { items, totalPages };
};

const buildBrTstFromPayload = async (
  payload: unknown,
): Promise<ReconciliationBuildOutcome> => {
  if (!isRecord(payload) || brTstSourceDocumentId(payload) === undefined) {
    return await Promise.resolve({ type: "unkeyable" });
  }
  // A record of a type this adapter does not read is still a listed identity:
  // it is held as the listing-only row the crawl writes for it (rule 20).
  return { type: "built", decision: buildBrTstDecision(payload).decision };
};

/**
 * Fields that move without the record changing: the publisher's reindexing
 * stamp, its sort key and the highlight renderings.
 */
const REVISION_EXCLUDED = new Set([
  "dtaAtualizacao",
  "dtaOrdenacao",
  "inteiroTeorHTMLHighlight",
  "txtEmentaHighlight",
  "txtConteudoDecisaoHighlight",
  "tituloHighlight",
  "teseHighlight",
  "observacaoHighlight",
]);

const revisionOf = (payload: unknown): unknown =>
  isRecord(payload)
    ? Object.fromEntries(
        Object.entries(brTstRetainedRecord(payload)).filter(
          ([key]) => !REVISION_EXCLUDED.has(key),
        ),
      )
    : null;

// ── Crawl cursor ─────────────────────────────────────────

const windowSchema = v.variant("type", [
  v.strictObject({ type: v.literal("precedents") }),
  v.strictObject({
    type: v.literal("day"),
    day: v.pipe(v.string(), v.isoDate()),
    part: v.picklist(["all", ...DAY_PARTS]),
  }),
]);

const cursorSchema = v.variant("phase", [
  v.strictObject({
    phase: v.literal("walk"),
    window: windowSchema,
    offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    /** The count the window's first page stated; a change restarts it. */
    reported: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    /** A split day's own count, and what its finished parts counted. */
    split: v.optional(
      v.strictObject({
        dayTotal: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        partsTotal: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      }),
    ),
  }),
  v.strictObject({
    phase: v.literal("parked"),
    /** The last closed day walked. */
    through: v.pipe(v.string(), v.isoDate()),
  }),
]);

export type BrTstCursor = v.InferOutput<typeof cursorSchema>;
type WalkCursor = Extract<BrTstCursor, { phase: "walk" }>;

export const encodeBrTstCursor = (cursor: BrTstCursor): string =>
  JSON.stringify(cursor);

const START: BrTstCursor = {
  phase: "walk",
  window: { type: "precedents" },
  offset: 0,
};

/**
 * Read a persisted cursor. A cursor this adapter did not write is refused:
 * restarting would re-read the whole corpus.
 */
export const parseBrTstCursor = (
  cursor: string | null,
): Result<BrTstCursor, AdapterFetchError> =>
  cursor === null
    ? Result.ok(START)
    : Result.try({
        try: () => v.parse(cursorSchema, JSON.parse(cursor)),
        catch: adapterCatch(ADAPTER_KEY, cursor),
      });

/** The walk position after `day`, or parked when no later day has closed. */
const afterDay = (day: string, now: Temporal.Instant): BrTstCursor => {
  const next = addDays(day, 1);
  return next > brTstLastClosedDay(now)
    ? { phase: "parked", through: day }
    : {
        phase: "walk",
        window: { type: "day", day: next, part: "all" },
        offset: 0,
      };
};

/** Where the walk goes once `cursor`'s window is read to its end. */
const afterWindow = (
  cursor: WalkCursor,
  reported: number,
  now: Temporal.Instant,
): BrTstCursor => {
  const { window } = cursor;
  if (window.type === "precedents") {
    return FIRST_DAY > brTstLastClosedDay(now)
      ? { phase: "parked", through: addDays(FIRST_DAY, -1) }
      : {
          phase: "walk",
          window: { type: "day", day: FIRST_DAY, part: "all" },
          offset: 0,
        };
  }
  if (window.part === "all" || cursor.split === undefined) {
    return afterDay(window.day, now);
  }
  const partsTotal = cursor.split.partsTotal + reported;
  const nextPart = DAY_PARTS[DAY_PARTS.indexOf(window.part) + 1];
  if (nextPart !== undefined) {
    return {
      phase: "walk",
      window: { type: "day", day: window.day, part: nextPart },
      offset: 0,
      split: { dayTotal: cursor.split.dayTotal, partsTotal },
    };
  }
  if (partsTotal !== cursor.split.dayTotal) {
    // A record of a type no part names: the walk cannot list it, and holding
    // the cursor would stop every later day. The day's reconciliation slice
    // fails its count, which is where the shortfall stays visible.
    logger.error("case_law.ingestion.br_tst_split_day_short", {
      adapterKey: ADAPTER_KEY,
      day: window.day,
      dayTotal: cursor.split.dayTotal,
      partsTotal,
    });
  }
  return afterDay(window.day, now);
};

type CollectedPage = Pick<SyncPage, "decisions" | "itemBuildFailures">;

const collect = async (
  records: readonly Record<string, unknown>[],
): Promise<CollectedPage> => {
  const decisions: IngestionResult[] = [];
  let failures = 0;
  for (const listed of records) {
    const captured = await buildPlainTextItem({
      adapterKey: ADAPTER_KEY,
      rawListing: JSON.stringify(brTstRetainedRecord(listed)),
      build: async () => await Promise.resolve(buildBrTstDecision(listed)),
      decisionOf: (built) => built.decision,
    });
    if (captured.type === "item_build_failed") {
      failures += 1;
      decisions.push(captured.decision);
      continue;
    }
    const built = captured.value;
    if (built.type === "unbuildable") {
      logger.warn("case_law.ingestion.br_tst_record_unbuildable", {
        adapterKey: ADAPTER_KEY,
        documentId: built.decision.sourceDocumentId,
        reason: built.reason,
      });
      failures += 1;
    }
    decisions.push(built.decision);
  }
  return {
    decisions,
    ...(failures === 0
      ? {}
      : { itemBuildFailures: { type: "item_build_failed", count: failures } }),
  };
};

type CrawlOptions = {
  now: Temporal.Instant;
  signal?: AbortSignal | undefined;
};

/**
 * One page of the crawl. Exported with its clock so a test can stand at any
 * day; the adapter passes the real one.
 */
export const brTstFetchPage = async (
  cursor: string | null,
  { now, signal }: CrawlOptions,
): Promise<Result<SyncPage, AdapterFetchError>> => {
  const parsed = parseBrTstCursor(cursor);
  if (Result.isError(parsed)) {
    return parsed;
  }
  let position = parsed.value;
  if (position.phase === "parked") {
    const resumed = afterDay(position.through, now);
    if (resumed.phase === "parked") {
      // No day has closed since: the quiet cycle, no request (rule 19).
      return Result.ok({
        decisions: [],
        nextCursor: encodeBrTstCursor(position),
      });
    }
    position = resumed;
  }

  for (let step = 0; step <= MAX_EMPTY_WINDOW_SKIPS; step += 1) {
    if (position.phase === "parked") {
      return Result.ok({
        decisions: [],
        nextCursor: encodeBrTstCursor(position),
      });
    }
    // Annotated: the loop reassigns `position`, which inference cannot follow.
    const walk: WalkCursor = position;
    const encoded = encodeBrTstCursor(walk);
    const read = await search({
      window: walk.window,
      offset: walk.offset,
      size: Math.min(CRAWL_PAGE_SIZE, BR_TST_OFFSET_CEILING - walk.offset),
      cursor: encoded,
      signal,
    });
    if (Result.isError(read)) {
      return read;
    }
    const { records, reported, url } = read.value;
    if (walk.reported !== undefined && reported !== walk.reported) {
      // The window changed under the walk: every later offset moved, so the
      // window is read again from its start (rule 19).
      return Result.ok({
        decisions: [],
        sourceUrl: url,
        nextCursor: encodeBrTstCursor({
          phase: "walk",
          window: walk.window,
          offset: 0,
          ...(walk.split === undefined ? {} : { split: walk.split }),
        }),
      });
    }
    if (reported > BR_TST_OFFSET_CEILING) {
      if (walk.window.type === "day" && walk.window.part === "all") {
        position = {
          phase: "walk",
          window: { type: "day", day: walk.window.day, part: DAY_PARTS[0] },
          offset: 0,
          split: { dayTotal: reported, partsTotal: 0 },
        };
        continue;
      }
      return Result.err(
        searchError(
          encoded,
          `window reports ${reported} records, past the ${BR_TST_OFFSET_CEILING} the search serves`,
        ),
      );
    }
    const end = walk.offset + records.length;
    if (
      end < reported &&
      records.length < Math.min(CRAWL_PAGE_SIZE, reported - walk.offset)
    ) {
      // A short page before the stated end is not the end (rule 14).
      return Result.err(
        searchError(
          encoded,
          `page at ${walk.offset} returned ${records.length} rows of a window that counts ${reported}`,
        ),
      );
    }
    if (records.length === 0) {
      position = afterWindow(walk, reported, now);
      continue;
    }
    const collected = await collect(records);
    const nextCursor =
      end >= reported
        ? afterWindow(walk, reported, now)
        : { ...walk, offset: end, reported };
    return Result.ok({
      ...collected,
      sourceUrl: url,
      nextCursor: encodeBrTstCursor(nextCursor),
    });
  }
  // Out of steps rather than out of windows: bank where the walk got to.
  return Result.ok({ decisions: [], nextCursor: encodeBrTstCursor(position) });
};

// ── Total count ──────────────────────────────────────────

/** Every record the search holds, by its own count, in one request. */
const brTstTotalCount = async (
  signal: AbortSignal,
): Promise<SourceTotalCount> => {
  const counted = await search({
    window: { type: "corpus" },
    offset: 0,
    size: 0,
    cursor: "total",
    signal,
  });
  return Result.isOk(counted)
    ? sourceTotalRead(counted.value.reported)
    : sourceTotalProbeFailed(
        counted.error.httpStatus === undefined
          ? SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD
          : SOURCE_TOTAL_PROBE_FAILURE.HTTP_STATUS,
      );
};

// ── Adapter ──────────────────────────────────────────────

export const brTstAdapter = defineSourceAdapter({
  key: ADAPTER_KEY,
  documentStage: "inline",
  language: LANGUAGE,
  minRequestIntervalMs: publisherRequestIntervalMs(ADAPTER_KEY),
  // A page is one request, or up to MAX_EMPTY_WINDOW_SKIPS of them over empty
  // days, each of up to a few megabytes behind the publisher gate.
  pageTimeoutMs: 300_000,
  reparseStoredRaw: reparseBrTstStoredRaw,
  sourceSurfaces: BR_TST_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: BR_TST_SOURCE_FIELDS,
    listSourceFields: listBrTstSourceFields,
  },
  getTotalCount: brTstTotalCount,
  reconciliation: {
    // Content and identity only: the reindexing stamp, the sort key and the
    // highlight renderings move without the record changing.
    revisionOf,
    firstSlice: BR_TST_PRECEDENTS_SLICE,
    sliceOf,
    nextSlice,
    previousSlice,
    tipWindowDays: TIP_WINDOW_DAYS,
    listSlicePage: listBrTstSlicePage,
    buildDecision: buildBrTstFromPayload,
  },
  async fetchPage(cursor, _config, signal) {
    return Result.flatten(
      await Result.tryPromise({
        try: async () =>
          await brTstFetchPage(cursor, { now: Temporal.Now.instant(), signal }),
        catch: adapterCatch(ADAPTER_KEY, cursor),
      }),
    );
  },
});
