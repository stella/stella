/**
 * Court decisions published in the Czech insolvency register
 * (insolvenční rejstřík, isir.justice.cz).
 *
 * The register is the one complete public record of the high courts'
 * insolvency decisions (Vrchní soud v Praze, Vrchní soud v Olomouci): the
 * courts' decision database lists only those it selects, and only from
 * 2020. Every decision in an insolvency file is published in the register as
 * the court's own PDF. The research note beside this file records the
 * surfaces, terms, volumes and pace.
 *
 * Interface. The register's public web service ISIR_PUBLIC_WS (`WS_1`),
 * which the register offers for bulk retrieval (`cz-isir-feed.ts`), and the
 * document servlet its actions point at. Nothing is scraped from the web
 * interface. The operating terms let the Ministry block a user sending more
 * than 3,000 requests a day or 50 a minute; the publisher gate spaces every
 * request of this source, feed and documents alike, under both.
 *
 * Scope. Only decisions: actions of a decision event type that carry the
 * decision's document. Filings, claims, reports, delivery receipts and the
 * court's notes are never read. By default only the high courts' appellate
 * decisions, including those in incidental disputes; the source's
 * `decisionScope` config (`appellate-and-insolvency-court`) adds the
 * insolvency courts' own decisions. A document of an appellate event that
 * is not a high court's decision is skipped.
 *
 * Personal data. The register's documents are not anonymised. A document is
 * anonymised (`cz-isir-anonymization.ts`) before anything about it is built,
 * and only that text is stored, as the raw payload and as the document; the
 * PDF itself is never stored. A document that cannot be anonymised with
 * confidence is not stored at all. The feed's person and address records are
 * never read (`cz-isir-feed.ts`). What the row keeps beyond the anonymised
 * text identifies the decision: court, docket, date, kind, and the register's
 * own coordinates of the document (court code, file mark, section, number).
 *
 * Removal. The register makes a debtor's data inaccessible after the period
 * § 425 insolvenčního zákona sets (five years after the proceeding ended,
 * three after a discharge), and its service description asks recipients of
 * the feed not to pass on what it struck off. This source mirrors that:
 *
 * - a document the register no longer serves is never stored: its read
 *   answers 404, and the action is skipped;
 * - a decision of a proceeding the same page strikes off is skipped;
 * - a stored decision whose document the register stops serving is removed
 *   by the publisher-removal sweep, whose probe for this source asks the
 *   document's address (`cz-isir-removal.ts`);
 * - the strike-off actions (event 636, `datumVyskrtnuti`) published after a
 *   decision was stored name its proceeding; the reconciliation job that
 *   follows them removes every stored decision of that proceeding
 *   (`czIsirStruckOffProceedings`, `CZ_ISIR_METADATA_KEY`).
 *
 * Identity. The register's document id is the document id. The docket,
 * court and date are the decision's own, read from its text (`parsers/
 * cz-isir.ts`): `3 VSPH 1361/2023` at Vrchní soud v Praze resolves like any
 * other Czech docket. The same decision published by the courts' database
 * or the Supreme Court's collection is the one decision: this source
 * attaches to a held decision of court, docket and date rather than writing
 * a second row (`held-decision-attachment.ts`).
 *
 * Crawl. The cursor is the last action id read. Each page is one feed call
 * (up to a thousand actions) and one document read per decision on it. At
 * the end of the feed the cursor stays where it is, so a later cycle reads
 * only the actions published since.
 */
import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { createPipeline } from "@stll/anonymize";
import { Temporal } from "@stll/time";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import {
  createCzIsirAnonymizer,
  type CzIsirAnonymizationFailure,
  type CzIsirAnonymizer,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir-anonymization";
import {
  CZ_ISIR_ACTION_SKIP,
  CZ_ISIR_DECISION_SCOPE,
  CZ_ISIR_DOCUMENT_REFERENCE,
  CZ_ISIR_FEED_PAGE_SIZE,
  CZ_ISIR_FEED_START_ID,
  CZ_ISIR_FEED_URL,
  CZ_ISIR_LAST_ID_REQUEST,
  type CzIsirAction,
  czIsirActionsRequest,
  czIsirDecisionAction,
  czIsirDocumentUrl,
  czIsirStruckOffOnPage,
  readCzIsirActionPage,
  readCzIsirLastId,
} from "@/api/handlers/case-law/ingestion/adapters/cz-isir-feed";
import { CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS } from "@/api/handlers/case-law/ingestion/adapters/cz-isir-insolvency-court-events";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  readPublisherBytes,
  readPublisherText,
  unreadPublisherError,
} from "@/api/handlers/case-law/ingestion/adapters/publisher-read";
import {
  adapterCatch,
  INGESTION_USER_AGENT,
} from "@/api/handlers/case-law/ingestion/adapters/utils";
import {
  type CzIsirParagraph,
  type CzIsirParseFailure,
  parseCzIsirDecision,
} from "@/api/handlers/case-law/ingestion/parsers/cz-isir";
import {
  assemblePdfParagraphs,
  extractPdfBodyAndNotes,
  PDF_PARAGRAPH_START,
  type PdfLine,
  pdfNotesOf,
  type PdfRun,
} from "@/api/handlers/case-law/ingestion/parsers/pdf-bands";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import {
  absentDecisionTextFields,
  checkedDecisionMetadata,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  CZ_ISIR_INSTANCE,
  CZ_ISIR_METADATA_KEY,
  type CzIsirDecisionMetadata,
} from "@/api/lib/legal-search/cz-isir-decision";
import {
  ADAPTER_KEYS,
  ADAPTER_TIMEOUT,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  defineSourceAdapter,
  encodeSourceRawEnvelope,
  excludedSourceField,
  excludedSourceSurface,
  PUBLISHER_REQUEST,
  readStoredRawListing,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
  storedSourceSurface,
} from "@/api/lib/legal-search/ingestion-types";
import type {
  IngestionResult,
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
  UnreadListedItem,
  UnreadOutcome,
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { logger } from "@/api/lib/observability/logger";

const KEY = ADAPTER_KEYS.CZ_ISIR;
const ORIGIN = "https://isir.justice.cz:8443";
const MANIFEST = ADAPTER_MANIFESTS[KEY];
const LANGUAGE = "cs";

const SOAP_HEADERS = {
  "User-Agent": INGESTION_USER_AGENT,
  "Content-Type": "text/xml; charset=utf-8",
  SOAPAction: '""',
} as const;
const DOCUMENT_HEADERS = { "User-Agent": INGESTION_USER_AGENT } as const;

/**
 * A page reads up to a dozen documents at the gate's pace; a cycle of a few
 * pages persists its cursor often enough.
 */
const PAGE_TIMEOUT_MS = 30 * 60_000;
const MAX_SYNC_PAGES = 4;
const MAX_CYCLE_MS = 60 * 60_000;

/** The stored payload's parts. */
const RAW_PART = {
  /** The action, reduced to the fields `CzIsirAction` keeps. */
  ACTION: "action",
  /** The document's paragraphs, anonymised. */
  TEXT: "text",
} as const;

// ── Config and cursor ────────────────────────────────────

const configSchema = v.object({
  decisionScope: v.optional(
    v.picklist([
      CZ_ISIR_DECISION_SCOPE.APPELLATE,
      CZ_ISIR_DECISION_SCOPE.APPELLATE_AND_INSOLVENCY_COURT,
    ]),
    CZ_ISIR_DECISION_SCOPE.APPELLATE,
  ),
  /** Where a walk without a cursor starts: the feed's beginning, or later. */
  startAfterActionId: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(CZ_ISIR_FEED_START_ID)),
    CZ_ISIR_FEED_START_ID,
  ),
});

type CzIsirConfig = v.InferOutput<typeof configSchema>;

const CURSOR_VERSION = 1;

const cursorSchema = v.strictObject({
  version: v.literal(CURSOR_VERSION),
  after: v.pipe(v.number(), v.integer(), v.minValue(CZ_ISIR_FEED_START_ID)),
});

export type CzIsirCursor = v.InferOutput<typeof cursorSchema>;

export const encodeCzIsirCursor = (cursor: CzIsirCursor): string =>
  JSON.stringify(cursor);

const parseConfig = (
  config: Record<string, unknown>,
  cursor: string | null,
): Result<CzIsirConfig, AdapterFetchError> => {
  const parsed = v.safeParse(configSchema, config);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new AdapterFetchError({
          message: "The cz-isir source config is invalid",
          adapterKey: KEY,
          cursor,
        }),
      );
};

const parseCursor = (
  text: string | null,
  config: CzIsirConfig,
): Result<CzIsirCursor, AdapterFetchError> => {
  if (text === null) {
    return Result.ok({
      version: CURSOR_VERSION,
      after: config.startAfterActionId,
    });
  }
  const parsed = Result.try(() => v.parse(cursorSchema, parsedJson(text)));
  return Result.isOk(parsed)
    ? Result.ok(parsed.value)
    : Result.err(
        new AdapterFetchError({
          message: `Unreadable cz-isir cursor: ${text}`,
          adapterKey: KEY,
          cursor: text,
        }),
      );
};

// ── Reads ────────────────────────────────────────────────

const DOCUMENT_ID = /^\d{1,12}$/u;

const czIsirDocumentIdOrPanic = (documentId: string): string =>
  DOCUMENT_ID.test(documentId)
    ? documentId
    : panic(`Not an ISIR document id: ${documentId}`);

const feedRead = async (
  body: string,
  cursor: string | null,
  signal: AbortSignal | undefined,
): Promise<Result<string, AdapterFetchError>> => {
  const read = await readPublisherText(
    `${ORIGIN}/isir_public_ws/IsirWsPublicService`,
    {
      adapterKey: KEY,
      fetchStage: "listing",
      method: "POST",
      headers: SOAP_HEADERS,
      body,
      redirect: "error",
      // The feed is the whole listing: a refusal of it is the source refusing
      // the crawl.
      refusalScope: "source",
      timeoutMs: ADAPTER_TIMEOUT.LIST,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return read.type === "present"
    ? Result.ok(read.value)
    : Result.err(
        unreadPublisherError({
          outcome: read,
          message: "The insolvency register feed could not be read",
          adapterKey: KEY,
          cursor,
        }),
      );
};

/**
 * The highest action id the feed has answered in this process. A page asked
 * for after an id answers the next actions whatever block they fall in, so a
 * reconciliation listing of a block's last page sees past the block when the
 * register has published past it: this, not the estimate, is where a walk
 * stops.
 */
const OBSERVED_TIP: { id: number | null } = { id: null };

const observeTip = (id: number | null) => {
  if (id !== null && (OBSERVED_TIP.id === null || id > OBSERVED_TIP.id)) {
    OBSERVED_TIP.id = id;
  }
};

/** The actions after `afterId`. */
const readActions = async (
  afterId: number,
  cursor: string | null,
  signal: AbortSignal | undefined,
) =>
  (await feedRead(czIsirActionsRequest(afterId), cursor, signal))
    .andThen((xml) =>
      readCzIsirActionPage(xml).mapError(
        (cause) =>
          new AdapterFetchError({
            message: cause.message,
            adapterKey: KEY,
            cursor,
            cause,
          }),
      ),
    )
    .tap((page) => {
      observeTip(page.lastId);
    });

/** Why a decision action produced no decision. */
export const CZ_ISIR_UNBUILT = {
  /**
   * The register states the document is gone (410). A 404 is not this: the
   * register answers 404 for its own database errors too.
   */
  WITHDRAWN: "withdrawn",
  /** The proceeding is struck off on the same page. */
  STRUCK_OFF: "struck-off",
  /** A PDF portfolio: the register's bundle of side documents. */
  PORTFOLIO: "portfolio",
  /** No text layer: a scan. */
  NO_TEXT_LAYER: "no-text-layer",
  /** Not a PDF the reader can open. */
  UNREADABLE: "unreadable",
  /** The anonymisation could not vouch for the text; nothing is stored. */
  ANONYMISATION: "anonymisation",
  /** An appellate event whose document is not a high court's decision. */
  NOT_APPELLATE: "not-appellate",
  /** The text states no docket, kind or date this source can key (a damaged text layer). */
  UNPARSED: "unparsed",
} as const;

export type CzIsirUnbuilt =
  (typeof CZ_ISIR_UNBUILT)[keyof typeof CZ_ISIR_UNBUILT];

export type CzIsirDecisionRead =
  | { type: "built"; decision: IngestionResult }
  | {
      type: "unbuilt";
      reason: CzIsirUnbuilt;
      detail?: CzIsirAnonymizationFailure | CzIsirParseFailure | undefined;
    }
  /** The document could not be read now; it is asked for again. */
  | { type: "unread"; outcome: UnreadOutcome };

/** Unbuilt for a reason that is no failure: nothing is kept of it. */
const isDeliberateSkip = (reason: CzIsirUnbuilt): boolean =>
  reason === CZ_ISIR_UNBUILT.WITHDRAWN ||
  reason === CZ_ISIR_UNBUILT.STRUCK_OFF ||
  reason === CZ_ISIR_UNBUILT.NOT_APPELLATE;

/**
 * The register's stamp of its electronic signature, printed on each page of
 * a document it serves (`cn=ISIR, c=CZ, o=Česká republika - Ministerstvo
 * spravedlnosti, ou=Insolvenční rejstřík, serialNumber=…`): the register's,
 * not the court's.
 */
const SIGNATURE_STAMP_OPENS = "cn=ISIR,";
const SIGNATURE_STAMP_CLOSES = "serialNumber=";

/**
 * A line of dockets alone: the decision's own header on its first page
 * (`3 VSPH 1361/2023-B-24` under `č. j. MSPH 60 INS 10782/2023`), and the
 * running header that repeats them, with the page's number, on every later
 * page (`2 MSPH 60 INS 10782/2023 3 VSPH 1361/2023`). Nothing a court writes
 * in its text is a line of dockets and numbers alone.
 */
const DOCKET_LINE_DOCKET =
  /^\(?(?:[KM]S[A-Z]{2} )?\d{1,4} (?:INS|ICm|VSPH|VSOL) \d{1,7}\/\d{4}(?:-(?:[A-Z]{1,3}-)?\d{1,5})?\)?$/u;
const PAGE_NUMBER = /^\d{1,3}$/u;

/** The dockets of a printed line of dockets and page numbers alone; null for any other line. */
const docketLineDockets = (text: string): string[] | null => {
  // One token per docket: its parts joined, its sheet's dash closed up.
  const tokens = text
    .replaceAll(/ ?- ?/gu, "-")
    .replace(/^č\. ?j\. /u, "")
    .replaceAll(/([KM]S[A-Z]{2}) (\d)/gu, "$1\u00a0$2")
    .replaceAll(/(\d) (INS|ICm|VSPH|VSOL) (\d)/gu, "$1\u00a0$2\u00a0$3")
    .split(" ")
    .map((token) => token.replaceAll("\u00a0", " "));
  const dockets = tokens.filter((token) => DOCKET_LINE_DOCKET.test(token));
  return dockets.length > 0 &&
    tokens.every(
      (token) => DOCKET_LINE_DOCKET.test(token) || PAGE_NUMBER.test(token),
    )
    ? dockets
    : null;
};

/** A docket without its brackets and sheet: what a running header repeats. */
const fileOfDocket = (docket: string): string => {
  const bare = docket.replaceAll(/[()]/gu, "");
  const sheet = bare.indexOf("-");
  return sheet === -1 ? bare : bare.slice(0, sheet);
};

/** A stamp is a handful of lines; one that runs on has no confirmed end. */
const STAMP_MAX_LINES = 8;

/**
 * Where the stamp that opens at `at` ends (exclusive): past its serial
 * number's value, on the serial number's line or the next. Null when no
 * serial number follows within a stamp's length.
 */
const stampEnd = (texts: readonly string[], at: number): number | null => {
  const last = Math.min(texts.length, at + STAMP_MAX_LINES);
  for (let index = at; index < last; index += 1) {
    const text = texts[index] ?? "";
    const closes = text.indexOf(SIGNATURE_STAMP_CLOSES);
    if (closes !== -1) {
      const value = text.slice(closes + SIGNATURE_STAMP_CLOSES.length).trim();
      return value.length > 0 ? index + 1 : index + 2;
    }
  }
  return null;
};

const lineText = (line: PdfLine): string =>
  line.type === "blank" ? "" : line.runs.map(({ text }) => text).join("");

/**
 * The register's furniture off the printed lines: its signature stamp, and
 * the running headers. The header block above the decision's first line of
 * text is the decision's own and stays; a later line of dockets is a running
 * header only where it repeats a file of that block, and a stamp only where
 * its serial number closes it. Anything else stays as text.
 */
const withoutRegisterFurniture = (lines: readonly PdfLine[]): PdfLine[] => {
  const texts = lines.map((line) => lineText(line).trim());
  const kept: PdfLine[] = [];
  const headerFiles = new Set<string>();
  let pastHeader = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const text = texts[index] ?? "";
    const stamp = text.startsWith(SIGNATURE_STAMP_OPENS)
      ? stampEnd(texts, index)
      : null;
    if (line === undefined || stamp !== null) {
      index = stamp ?? index + 1;
      continue;
    }
    index += 1;
    const dockets =
      line.type === "blank"
        ? null
        : docketLineDockets(text.replaceAll(/\s+/gu, " "));
    if (dockets === null) {
      pastHeader ||= text.length > 0;
    } else if (!pastHeader) {
      for (const docket of dockets) {
        headerFiles.add(fileOfDocket(docket));
      }
    } else if (
      dockets.some((docket) => headerFiles.has(fileOfDocket(docket)))
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept;
};

/** A document's paragraphs, before anonymisation; never stored. */
export const readCzIsirDocumentParagraphs = async (
  bytes: Uint8Array,
): Promise<
  Result<
    CzIsirParagraph[],
    | typeof CZ_ISIR_UNBUILT.PORTFOLIO
    | typeof CZ_ISIR_UNBUILT.NO_TEXT_LAYER
    | typeof CZ_ISIR_UNBUILT.UNREADABLE
  >
> => {
  const loaded = await Result.tryPromise(async () => await PDF.load(bytes));
  if (Result.isError(loaded)) {
    return Result.err(CZ_ISIR_UNBUILT.UNREADABLE);
  }
  if (loaded.value.getAttachments().size > 0) {
    return Result.err(CZ_ISIR_UNBUILT.PORTFOLIO);
  }
  const read = await Result.tryPromise(
    async () => await extractPdfBodyAndNotes(bytes, PDF_PARAGRAPH_START.INDENT),
  );
  if (Result.isError(read)) {
    return Result.err(CZ_ISIR_UNBUILT.UNREADABLE);
  }
  const joined = (runs: readonly PdfRun[]) =>
    runs
      .map(({ text }) => text)
      .join("")
      .replaceAll(/\s+/gu, " ")
      .trim();
  // The court's footnotes are its text too: they follow the body, each
  // opened by its number, and are anonymised with it.
  const paragraphs = [
    ...assemblePdfParagraphs(withoutRegisterFurniture(read.value.body)).map(
      (runs) => ({
        text: joined(runs),
        bold: runs.every(({ bold, text }) => bold || text.trim().length === 0),
      }),
    ),
    ...pdfNotesOf(read.value.notes).map(({ label, lines }) => ({
      text: `${label} ${joined(assemblePdfParagraphs(lines).flat())}`.trim(),
      bold: false,
    })),
  ];
  return paragraphs.some(({ text }) => text.length > 0)
    ? Result.ok(paragraphs.filter(({ text }) => text.length > 0))
    : Result.err(CZ_ISIR_UNBUILT.NO_TEXT_LAYER);
};

/** The action as the stored payload keeps it. */
const actionRow = (action: CzIsirAction): string => JSON.stringify(action);

const nullableText = v.nullable(v.string());

/** The action as {@link actionRow} stores it, every field checked. */
const storedActionSchema = v.object({
  id: v.pipe(v.number(), v.integer()),
  createdAt: nullableText,
  publishedAt: nullableText,
  documentId: v.nullable(v.pipe(v.string(), v.regex(DOCUMENT_ID))),
  documentReference: v.picklist(Object.values(CZ_ISIR_DOCUMENT_REFERENCE)),
  fileMark: v.string(),
  courtCode: nullableText,
  eventType: v.pipe(v.number(), v.integer()),
  eventDescription: nullableText,
  section: nullableText,
  sectionNumber: v.nullable(v.pipe(v.number(), v.integer())),
  note: v.object({
    sideDocument: v.boolean(),
    sideEvent: v.boolean(),
    fileState: nullableText,
    finalOn: nullableText,
    cancelledAt: nullableText,
    correctedPublicationOn: nullableText,
    struckOffOn: nullableText,
  }),
});

const isStoredAction = (value: unknown): value is CzIsirAction =>
  v.is(storedActionSchema, value);

const parsedJson = (text: string): unknown =>
  Result.try((): unknown => JSON.parse(text)).unwrapOr(null);

const paragraphsSchema = v.array(
  v.strictObject({ text: v.string(), bold: v.boolean() }),
);

/**
 * One decision from its action and its anonymised paragraphs: what a crawl
 * builds and what a replay rebuilds from the stored payload alone.
 */
export const buildCzIsirDecision = ({
  action,
  paragraphs,
}: {
  action: CzIsirAction;
  paragraphs: readonly CzIsirParagraph[];
}): CzIsirDecisionRead => {
  const documentId = action.documentId;
  if (documentId === null) {
    return panic("A decision action without a document reached the build");
  }
  const sourceUrl = czIsirDocumentUrl(documentId);
  const parsed = parseCzIsirDecision(paragraphs, { documentId, sourceUrl });
  if (Result.isError(parsed)) {
    return {
      type: "unbuilt",
      reason: CZ_ISIR_UNBUILT.UNPARSED,
      detail: parsed.error.reason,
    };
  }
  const { identity, documentAst, fulltext, sections } = parsed.value;
  if (
    identity.instance !== CZ_ISIR_INSTANCE.APPELLATE &&
    !CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS.has(action.eventType)
  ) {
    return { type: "unbuilt", reason: CZ_ISIR_UNBUILT.NOT_APPELLATE };
  }
  const metadata: CzIsirDecisionMetadata = {
    documentId,
    actionId: action.id,
    eventType: action.eventType,
    eventDescription: action.eventDescription,
    courtCode: action.courtCode,
    fileMark: action.fileMark,
    section: action.section,
    sectionNumber: action.sectionNumber,
    publishedAt: action.publishedAt,
    instance: identity.instance,
    insolvencyFile: identity.insolvencyFile ?? null,
    filePosition: identity.filePosition ?? null,
  };
  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.ACTION]: actionRow(action),
    [RAW_PART.TEXT]: JSON.stringify(paragraphs),
  });
  const reference = splitCaseReference(
    identity.sheetNumber === undefined
      ? identity.caseNumber
      : `${identity.caseNumber}-${identity.sheetNumber}`,
  );
  return {
    type: "built",
    decision: plainTextIngestionResult({
      caseNumber: reference.caseNumber,
      ...(reference.sheetNumber === undefined
        ? {}
        : { sheetNumber: reference.sheetNumber }),
      sourceDocumentId: documentId,
      court: identity.court,
      country: MANIFEST.country,
      language: LANGUAGE,
      decisionDate: identity.decisionDate,
      decisionType: identity.decisionType,
      fulltext,
      sourceUrl,
      documentUrl: sourceUrl,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      metadata: checkedDecisionMetadata({
        [CZ_ISIR_METADATA_KEY]: metadata,
        // The register's documents state no ECLI.
        ecliAvailability: { status: "not_published" },
      }),
      rawHash: sourceFingerprint({ sourceRaw }),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_ISIR],
      documentAst,
      sections,
      sourceRaw,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    }),
  };
};

/**
 * The row a listed decision keeps while its document cannot be read or
 * built: the action's allowlisted coordinates, keyed by the document id, and
 * no text. Its docket and court are the document's own, so they wait for it;
 * reconciliation builds the decision once the document reads.
 */
export const czIsirListingOnlyDecision = (
  action: CzIsirAction,
  documentId: string,
): UnreadListedItem["listing"] => {
  const sourceUrl = czIsirDocumentUrl(documentId);
  const metadata: CzIsirDecisionMetadata = {
    documentId,
    actionId: action.id,
    eventType: action.eventType,
    eventDescription: action.eventDescription,
    courtCode: action.courtCode,
    fileMark: action.fileMark,
    section: action.section,
    sectionNumber: action.sectionNumber,
    publishedAt: action.publishedAt,
    instance: null,
    insolvencyFile: null,
    filePosition: null,
  };
  const sourceRaw = encodeSourceRawEnvelope({
    [RAW_PART.ACTION]: actionRow(action),
  });
  return {
    ...plainTextIngestionResult({
      caseNumber: documentId,
      caseNumberIsPlaceholder: true,
      sourceDocumentId: documentId,
      court: "",
      country: MANIFEST.country,
      language: LANGUAGE,
      isListingOnly: true,
      sourceUrl,
      documentUrl: sourceUrl,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      metadata: checkedDecisionMetadata({
        [CZ_ISIR_METADATA_KEY]: metadata,
        ecliAvailability: { status: "not_published" },
      }),
      rawHash: sourceFingerprint({ sourceRaw }),
      parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_ISIR],
      sourceRaw,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    }),
    sourceDocumentId: documentId,
    isListingOnly: true,
  };
};

const anonymizer = createCzIsirAnonymizer(
  async () => await createPipeline({ language: LANGUAGE }),
);

type ReadDecisionOptions = {
  action: CzIsirAction;
  documentId: string;
  cursor: string | null;
  signal: AbortSignal | undefined;
  anonymize?: CzIsirAnonymizer | undefined;
};

/**
 * Read, anonymise and build one decision. A document that could not be read
 * is `unread`, so the page keeps what it built and the pipeline asks for the
 * document again; only a refusal of the whole source stops the page.
 */
export const readCzIsirDecision = async ({
  action,
  documentId,
  cursor,
  signal,
  anonymize,
}: ReadDecisionOptions): Promise<
  Result<CzIsirDecisionRead, AdapterFetchError>
> => {
  const read = await readPublisherBytes(
    `${ORIGIN}/isir_public_ws/doc/Document?idDokument=${czIsirDocumentIdOrPanic(documentId)}`,
    {
      adapterKey: KEY,
      fetchStage: "document",
      expectedContentType: "pdf",
      headers: DOCUMENT_HEADERS,
      redirect: "error",
      refusalScope: "document",
      timeoutMs: ADAPTER_TIMEOUT.REQUEST,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  switch (read.type) {
    case "present":
      break;
    case "absent":
      // The register answers 404 for its database errors as well as for a
      // document it no longer serves; only a 410 states the document gone.
      return Result.ok(
        read.evidence === "http-410"
          ? { type: "unbuilt", reason: CZ_ISIR_UNBUILT.WITHDRAWN }
          : {
              type: "unread",
              outcome: {
                type: "unavailable",
                cause: { kind: "status", status: 404 },
              },
            },
      );
    case "refused":
      if (read.scope === "source") {
        return Result.err(
          unreadPublisherError({
            outcome: read,
            message: `Insolvency register refused document ${documentId}`,
            adapterKey: KEY,
            cursor,
          }),
        );
      }
      return Result.ok({ type: "unread", outcome: read });
    case "unavailable":
      return Result.ok({ type: "unread", outcome: read });
    default:
      read satisfies never;
      return panic("Unhandled insolvency register document read");
  }
  const paragraphs = await readCzIsirDocumentParagraphs(read.value);
  if (Result.isError(paragraphs)) {
    return Result.ok({ type: "unbuilt", reason: paragraphs.error });
  }
  const pipeline = anonymize ?? (await anonymizer.load());
  const anonymised = pipeline.anonymize(paragraphs.value);
  if (Result.isError(anonymised)) {
    return Result.ok({
      type: "unbuilt",
      reason: CZ_ISIR_UNBUILT.ANONYMISATION,
      detail: anonymised.error.reason,
    });
  }
  return Result.ok(
    buildCzIsirDecision({ action, paragraphs: anonymised.value }),
  );
};

// ── Crawl ────────────────────────────────────────────────

type CrawlOptions = {
  cursorText: string | null;
  config: Record<string, unknown>;
  signal: AbortSignal | undefined;
  anonymize?: CzIsirAnonymizer | undefined;
};

const crawlPage = async ({
  cursorText,
  config: rawConfig,
  signal,
  anonymize,
}: CrawlOptions): Promise<Result<SyncPage, AdapterFetchError>> => {
  const config = parseConfig(rawConfig, cursorText);
  if (Result.isError(config)) {
    return Result.err(config.error);
  }
  const cursor = parseCursor(cursorText, config.value);
  if (Result.isError(cursor)) {
    return Result.err(cursor.error);
  }
  const page = await readActions(cursor.value.after, cursorText, signal);
  if (Result.isError(page)) {
    return Result.err(page.error);
  }
  const isStruckOff = czIsirStruckOffOnPage(page.value.actions);
  const decisions: IngestionResult[] = [];
  const unreadItems: UnreadListedItem[] = [];
  let failed = 0;
  for (const action of page.value.actions) {
    const selected = czIsirDecisionAction(
      action,
      config.value.decisionScope,
      CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS,
    );
    if (selected.type === "skip") {
      if (
        selected.reason === CZ_ISIR_ACTION_SKIP.MALFORMED_DOCUMENT_REFERENCE
      ) {
        // A listed decision the reader cannot address: counted, never
        // taken for an update without a document.
        failed += 1;
        logger.warn("case_law.ingestion.cz_isir_document_reference_malformed", {
          adapterKey: KEY,
          actionId: action.id,
        });
      }
      continue;
    }
    if (isStruckOff(action)) {
      continue;
    }
    const read = await readCzIsirDecision({
      action,
      documentId: selected.documentId,
      cursor: cursorText,
      signal,
      anonymize,
    });
    if (Result.isError(read)) {
      return Result.err(read.error);
    }
    if (read.value.type === "built") {
      decisions.push(read.value.decision);
      continue;
    }
    if (read.value.type === "unread") {
      unreadItems.push({
        listing: czIsirListingOnlyDecision(action, selected.documentId),
        outcome: read.value.outcome,
      });
      continue;
    }
    // A failed build keeps the listing, never the document; the reason is
    // counted and logged, and reconciliation builds it again.
    if (!isDeliberateSkip(read.value.reason)) {
      failed += 1;
      decisions.push(czIsirListingOnlyDecision(action, selected.documentId));
    }
    logger.info("case_law.ingestion.cz_isir_decision_unbuilt", {
      adapterKey: KEY,
      sourceDocumentId: selected.documentId,
      reason: read.value.reason,
      detail: read.value.detail ?? "",
    });
  }
  const lastId = page.value.lastId;
  return Result.ok({
    decisions,
    itemBuildFailures: { type: "item_build_failed", count: failed },
    ...(unreadItems.length === 0 ? {} : { unreadItems }),
    publisherRequest: PUBLISHER_REQUEST.ANSWERED,
    // At the feed's end the cursor stays: the next cycle asks for what was
    // published since.
    nextCursor: encodeCzIsirCursor({
      version: CURSOR_VERSION,
      after: lastId ?? cursor.value.after,
    }),
    sourceUrl: CZ_ISIR_FEED_URL,
  });
};

/** One page of the walk; exported for tests that drive it with a fixture. */
export const czIsirFetchPage = async (
  cursor: string | null,
  config: Record<string, unknown>,
  signal?: AbortSignal,
  anonymize?: CzIsirAnonymizer,
) =>
  (
    await Result.tryPromise({
      try: async () =>
        await crawlPage({ cursorText: cursor, config, signal, anonymize }),
      catch: adapterCatch(KEY, cursor),
    })
  ).andThen((page) => page);

// ── Reconciliation ───────────────────────────────────────

/**
 * A slice is a block of action ids, and a page of it the actions of a
 * thousand consecutive ids: a thousand ids hold at most a thousand actions,
 * so one feed call answers a page whole.
 */
const SLICE_IDS = 100_000;
const PAGE_IDS = CZ_ISIR_FEED_PAGE_SIZE;
const PAGES_PER_SLICE = SLICE_IDS / PAGE_IDS;
const SLICE = /^\d{5}$/u;

/** Slices are zero-padded so their order as text is their order as blocks. */
const sliceName = (index: number): string => String(index).padStart(5, "0");

/**
 * The feed states no date for an id, so the tip is estimated from a
 * measured rate: action 81,548,356 was the last published on 2026-11-19, and
 * the register published about 16,400 actions a day over the year before.
 * The estimate schedules the tip window; a walk stops at the tip the feed
 * answered ({@link OBSERVED_TIP}), and only before any answer at the estimate.
 */
const MEASURED_TIP = { id: 81_548_356, on: "2026-11-19" } as const;
const ACTIONS_PER_DAY = 16_400;

/**
 * A run of digits as its number. Every caller has matched the text against a
 * bounded digit pattern first, so a failed parse is an impossible state.
 */
const integerOf = (digits: string): number => {
  const parsed = parseIntegerToken(digits, { sign: "unsigned" });
  return Result.isOk(parsed)
    ? parsed.value
    : panic(`validated digits did not parse: ${digits}`);
};

const sliceIndexOf = (slice: string): number =>
  SLICE.test(slice)
    ? integerOf(slice)
    : panic(`cz-isir slice is not an action block: ${slice}`);

const sliceOf = (now: Date): string => {
  const days = Temporal.PlainDate.from(MEASURED_TIP.on).until(
    Temporal.Instant.fromEpochMilliseconds(now.getTime())
      .toZonedDateTimeISO("UTC")
      .toPlainDate(),
  ).days;
  const id = Math.max(0, MEASURED_TIP.id + days * ACTIONS_PER_DAY);
  return sliceName(Math.floor(id / SLICE_IDS));
};

const tipSliceIndex = (): number =>
  OBSERVED_TIP.id === null
    ? sliceIndexOf(sliceOf(new Date()))
    : Math.floor(OBSERVED_TIP.id / SLICE_IDS);

const nextSlice = (slice: string): string | null => {
  const next = sliceIndexOf(slice) + 1;
  return next > tipSliceIndex() ? null : sliceName(next);
};

const previousSlice = (slice: string): string | null => {
  const previous = sliceIndexOf(slice) - 1;
  return previous < 0 ? null : sliceName(previous);
};

const listSlicePage = async ({
  slice,
  page,
  signal,
}: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
  const first = sliceIndexOf(slice) * SLICE_IDS + page * PAGE_IDS;
  const last = first + PAGE_IDS - 1;
  const read = await readActions(first - 1, slice, signal);
  if (Result.isError(read)) {
    return await Promise.reject(read.error);
  }
  // Reconciliation skips what the crawl skips: a struck-off file's decisions.
  const isStruckOff = czIsirStruckOffOnPage(read.value.actions);
  return {
    items: read.value.actions.flatMap((action) => {
      if (action.id > last || isStruckOff(action)) {
        return [];
      }
      const selected = czIsirDecisionAction(
        action,
        CZ_ISIR_DECISION_SCOPE.APPELLATE,
        CZ_ISIR_INSOLVENCY_COURT_DECISION_EVENTS,
      );
      return selected.type === "decision"
        ? [
            {
              identity: {
                type: "document" as const,
                sourceDocumentId: selected.documentId,
              },
              payload: action,
            },
          ]
        : [];
    }),
    totalPages: PAGES_PER_SLICE,
  };
};

const buildFromPayload = async (
  payload: unknown,
  signal?: AbortSignal,
): Promise<ReconciliationBuildOutcome> => {
  if (!isStoredAction(payload) || payload.documentId === null) {
    return { type: "unkeyable" };
  }
  const read = await readCzIsirDecision({
    action: payload,
    documentId: payload.documentId,
    cursor: null,
    signal,
  });
  if (Result.isError(read)) {
    return await Promise.reject(read.error);
  }
  switch (read.value.type) {
    case "built":
      return { type: "built", decision: read.value.decision };
    case "unread":
      return { type: "detail-unavailable" };
    case "unbuilt":
      return isDeliberateSkip(read.value.reason)
        ? { type: "unkeyable" }
        : {
            type: "built",
            decision: czIsirListingOnlyDecision(payload, payload.documentId),
          };
    default:
      read.value satisfies never;
      return panic("Unhandled insolvency register reconciliation read");
  }
};

// ── Replay ───────────────────────────────────────────────

const reparseStoredRaw = (
  stored: StoredRawReparseInput,
): StoredRawReparseOutcome => {
  const read = readStoredRawListing({
    stored,
    part: RAW_PART.ACTION,
    identityOf: (listing) =>
      isStoredAction(listing) ? (listing.documentId ?? undefined) : undefined,
  });
  if (read.type === "rejected") {
    return read;
  }
  const action = read.listing;
  const text = read.parts[RAW_PART.TEXT];
  const paragraphs =
    text === undefined
      ? undefined
      : v.safeParse(paragraphsSchema, parsedJson(text));
  if (!isStoredAction(action) || paragraphs?.success !== true) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
      detail: "the stored payload holds no anonymised text",
    };
  }
  const built = buildCzIsirDecision({ action, paragraphs: paragraphs.output });
  return built.type === "built"
    ? { type: "parsed", result: built.decision }
    : {
        type: "rejected",
        rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
        detail: `the stored text is not a decision this source keys (${built.reason})`,
      };
};

// ── Source fields and surfaces ───────────────────────────

/**
 * Every field the feed states for an action. The person, address and free
 * text fields of the note are excluded unread (`cz-isir-feed.ts`).
 */
const SOURCE_FIELDS = [
  "id",
  "datumZalozeniUdalosti",
  "datumZverejneniUdalosti",
  "dokumentUrl",
  "spisovaZnacka",
  "typUdalosti",
  "popisUdalosti",
  "oddil",
  "cisloVOddilu",
  "poznamka",
] as const;

type CzIsirPublisherRecord = Readonly<
  Record<(typeof SOURCE_FIELDS)[number], unknown>
>;

const actionField = (path: string): SourceFieldDisposition => ({
  disposition: "stored",
  target: { type: "metadata", key: CZ_ISIR_METADATA_KEY, path: [path] },
});

const CZ_ISIR_SOURCE_FIELDS = {
  id: actionField("actionId"),
  datumZalozeniUdalosti: excludedSourceField({
    reason: "publisher_noise",
    justification:
      "the moment the court entered the event; the decision's own date is read from its text",
    pointer: "action.createdAt",
  }),
  datumZverejneniUdalosti: actionField("publishedAt"),
  dokumentUrl: {
    disposition: "stored",
    target: { type: "result", key: "sourceUrl" },
  },
  spisovaZnacka: actionField("fileMark"),
  typUdalosti: actionField("eventType"),
  popisUdalosti: actionField("eventDescription"),
  oddil: actionField("section"),
  cisloVOddilu: actionField("sectionNumber"),
  poznamka: excludedSourceField({
    reason: "personal_data_minimisation",
    justification:
      "the note carries the debtor's and other persons' records; only the court code and the event's flags are read, into the action",
    pointer: "cz-isir-feed.ts NOTE_FIELDS",
  }),
} as const satisfies Record<
  keyof CzIsirPublisherRecord,
  SourceFieldDisposition
>;

const listSourceFields = (parts: SourceRawParts): readonly string[] => {
  const action = parts[RAW_PART.ACTION];
  return action === undefined ? [] : SOURCE_FIELDS;
};

const SOURCE_SURFACES = ["feed", "document-pdf", "web-interface"] as const;

const CZ_ISIR_SOURCE_SURFACES = {
  surfaces: {
    feed: storedSourceSurface(RAW_PART.ACTION),
    "document-pdf": storedSourceSurface(RAW_PART.TEXT),
    "web-interface": excludedSourceSurface(
      "the register's web pages render the same file and its documents; bulk retrieval is through the public web service only",
    ),
  } as const satisfies Record<
    (typeof SOURCE_SURFACES)[number],
    SourceSurfaceDisposition
  >,
} as const satisfies SourceSurfaceCensus;

// ── Adapter ──────────────────────────────────────────────

const NO_COUNT: SourceTotalCount = { type: "no-count-endpoint" };

/** The last published action id; the walk's distance to the tip. */
export const readCzIsirTipId = async (signal: AbortSignal) =>
  (await feedRead(CZ_ISIR_LAST_ID_REQUEST, null, signal))
    .andThen((xml) =>
      readCzIsirLastId(xml).mapError(
        (cause) =>
          new AdapterFetchError({
            message: cause.message,
            adapterKey: KEY,
            cursor: null,
            cause,
          }),
      ),
    )
    .tap(observeTip);

export const czIsirAdapter = defineSourceAdapter({
  key: KEY,
  documentStage: "inline",
  language: LANGUAGE,
  minRequestIntervalMs: publisherRequestIntervalMs(KEY),
  pageTimeoutMs: PAGE_TIMEOUT_MS,
  maxSyncPages: MAX_SYNC_PAGES,
  maxCycleMs: MAX_CYCLE_MS,
  sourceSurfaces: CZ_ISIR_SOURCE_SURFACES,
  sourceFields: {
    status: "declared",
    fields: CZ_ISIR_SOURCE_FIELDS,
    listSourceFields,
  },
  fetchPage: async (cursor, config, signal) =>
    await czIsirFetchPage(cursor, config, signal),
  reparseStoredRaw,
  // The register states how many actions it holds, not how many decisions.
  getTotalCount: async () => await Promise.resolve(NO_COUNT),
  reconciliation: {
    revisionOf: (payload) =>
      isStoredAction(payload)
        ? { documentId: payload.documentId, eventType: payload.eventType }
        : null,
    firstSlice: sliceName(0),
    sliceOf,
    nextSlice,
    previousSlice,
    tipWindowDays: 1,
    listSlicePage,
    buildDecision: buildFromPayload,
  },
});
