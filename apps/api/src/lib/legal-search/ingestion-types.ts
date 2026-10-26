// parser-output-unchanged: scopes adapter callbacks for telemetry while preserving their arguments, returned values and rejection behavior.
// parser-output-unchanged: raw-envelope codecs move unchanged into their pure owner; bytes and validation are identical.
// parser-output-unchanged: classifies thrown page-fetch failures at the shared adapter boundary.
// parser-output-unchanged: document scheduling is checked against the source manifest; parsed output is unchanged.
// parser-output-unchanged: Adds an optional observation-quality discriminator; publisher fields and document parsing are unchanged.
// parser-output-unchanged: observer wiring returns the adapter’s same normalized SyncPage.
// parser-output-unchanged: replay outcome type gains an optional legacy docket; no parser output changes.
// parser-output-unchanged: The required reconciliation revision projection changes retry bookkeeping, not parsed decision output.
// parser-output-unchanged: preserves explicit URL declarations; ordinary metadata strings are projected as before
// parser-output-unchanged: a page may also report listed items whose read did not produce them; built decisions are unchanged.
// parser-output-unchanged: adapter definitions keep their declared reconciliation types; parsed output is unchanged.
// parser-output-unchanged: listing identities lose the unkeyed variant; they key ledger rows and never reach a parsed decision.
import { panic, Result, TaggedError } from "better-result";

import type { DecisionJudgeRole } from "@stll/api-contract/case-law-judges";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type {
  DecisionTextFieldKey,
  ReadDecisionTextFields,
  TextField,
} from "@stll/api-contract/case-law-text-field";
import {
  DECISION_TEXT_FIELD,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { DecisionDocumentRole } from "@stll/api-contract/decision-document-role";
import { withExceptionScope } from "@stll/errors/exception-scope-context";
import type {
  DecisionIdentifiers,
  DecisionPrimaryReferenceType,
} from "@stll/legal-ast/decision-identifier";
// parser-output-unchanged: imports the document AST from its package owner
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import type {
  DocumentStage,
  DocumentStageObserver,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import {
  type PlainText,
  PlainTextError,
  type PlainTextMetadataValue,
  toPlainText,
  toPlainTextMetadataObject,
} from "@/api/lib/case-law/plain-text";
import type { ReadOutcome } from "@/api/lib/errors/read-outcome";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { CitationOpinionScope } from "@/api/lib/legal-search/citation-opinion-scope";
import type { DecisionSupplementKind } from "@/api/lib/legal-search/decision-supplement-kind";
import {
  type DocumentStagePageOptions,
  withDocumentStageWindow,
} from "@/api/lib/legal-search/document-stage-observation";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import type { ObservationDetail } from "@/api/lib/legal-search/partial-observation-sql";
import type { SkCollectionConnector } from "@/api/lib/legal-search/sk-collection-enrichment";
import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  type SourceRawParts,
} from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

export { EMPTY_AST };
export type { EmptyAst };

/**
 * A judge the source names in the form a reader sees, titles removed.
 *
 * Each variant rules out the other's name field, so a reader of either
 * spelling (`judge.czechDeclinedName !== undefined`) tells them apart, and a
 * consumer that only reads printed names still compiles against both.
 */
export type PrintedDecisionJudge = {
  role: DecisionJudgeRole;
  nameAsPrinted: string;
  czechDeclinedName?: never;
};

/**
 * A judge a Czech text names inside a sentence, in the case its grammar asks
 * for ("z předsedy Jana Svatoně"). The declined form is never shown: the row
 * is written only when the court's roster names exactly one person it can be,
 * and then under that person's own name.
 */
export type CzechDeclinedDecisionJudge = {
  role: DecisionJudgeRole;
  czechDeclinedName: string;
  nameAsPrinted?: never;
};

/** A judge as one decision names them, before the roster is consulted. */
export type DecisionJudgeInput =
  PrintedDecisionJudge | CzechDeclinedDecisionJudge;

/** Mirrors the publisher-identity columns in the case-law schema. */
export const SOURCE_DOCUMENT_ID_MAX_LENGTH = 256;

export const isPersistableSourceDocumentId = (value: string): boolean =>
  value.length > 0 && value.length <= SOURCE_DOCUMENT_ID_MAX_LENGTH;

/**
 * How an observation stands to the decision's document.
 *
 * `inline`: the adapter fetched what the publisher serves for this decision,
 * so a result with no text is a decision with no document. `deferred`: the
 * document is fetched later by a queue of its own, and a result with no text
 * says nothing about whether one exists.
 */
export const DOCUMENT_DELIVERY = {
  DEFERRED: "deferred",
  INLINE: "inline",
} as const;

type DocumentDelivery =
  (typeof DOCUMENT_DELIVERY)[keyof typeof DOCUMENT_DELIVERY];

export type { CitationOpinionScope } from "@/api/lib/legal-search/citation-opinion-scope";

/** Result of parsing a single court decision from a source. */
export type RawIngestionResult = {
  /**
   * The decision's primary citable reference: the docket, unless
   * `caseNumberType` says otherwise.
   */
  caseNumber: string;
  /**
   * What kind of reference `caseNumber` is. Absent means a docket. A source
   * that cites a decision primarily by a reporter or neutral citation says
   * so here and lists the docket, where it has one, in `identifiers`.
   */
  caseNumberType?: DecisionPrimaryReferenceType | undefined;
  /**
   * Every identifier the publisher states for this decision. The pipeline
   * always adds `caseNumber` and `ecli`, so adapters may omit this until they
   * expose neutral or reporter citations.
   */
  identifiers?: DecisionIdentifiers | undefined;
  /**
   * True when `caseNumber` is a durable ingestion placeholder rather than a
   * publisher docket. Identified-row refreshes preserve an already recovered
   * docket and its citation key when a later partial listing carries this.
   */
  caseNumberIsPlaceholder?: boolean | undefined;
  /**
   * True when the publisher listing proves this document exists but the
   * adapter could not recover its detail payload. The first observation is
   * still durable; a later listing-only refresh must not replace detail state
   * that an earlier fetch or repair already recovered.
   */
  isListingOnly?: boolean | undefined;
  /** Quality of document and secondary reads, independent of document presence. */
  observationDetail?: ObservationDetail | undefined;
  /**
   * Absent means `inline`. An inline result that carries no document is
   * stored unpublished, exactly as a listing-only one is, and is repaired the
   * same way; a deferred one stays public while its queue fetches the text.
   */
  documentDelivery?: DocumentDelivery | undefined;
  /**
   * The publisher's own identifier for this document. Supply it whenever the
   * source has one: it is what makes a decision identifiable. A case number
   * does not, because courts number dockets per court and one source often
   * covers many, so the same number recurs across unrelated decisions.
   *
   * Omit it only where the source publishes no such id.
   */
  sourceDocumentId?: string | undefined;
  /**
   * Other exact publisher identifiers for this same document. Emit every
   * alternate identity visible with the canonical `sourceDocumentId`; the
   * pipeline atomically reserves all of them to one durable decision UUID, so
   * canonical/fallback observations converge in either order. Identities must
   * fit `SOURCE_DOCUMENT_ID_MAX_LENGTH`; adapters should discard a malformed
   * alias at their publisher boundary instead of poisoning the whole page.
   */
  sourceDocumentIdAliases?: readonly string[] | undefined;
  /**
   * Deterministic identities emitted by an older or degraded observation that
   * may adopt an existing registry owner but are not exact enough to reserve
   * when unclaimed. Use this for content-addressed repair fingerprints, never
   * for an alternate publisher key.
   */
  sourceDocumentIdRepairAliases?: readonly string[] | undefined;
  /**
   * Exact source URLs emitted by an older adapter version for this same
   * publisher document. This is a narrowly scoped identity-migration hint:
   * the pipeline may use it to attach a newly learned `sourceDocumentId` to
   * the right legacy null-id row without guessing from a shared docket.
   */
  legacySourceUrls?: readonly string[] | undefined;
  /**
   * The ECLI an older adapter version derived for this same publisher
   * document, where it differs from `ecli` in more than case or punctuation
   * (for example a counter segment the publisher's own spelling omits). Like
   * `legacySourceUrls`, it only lets the pipeline recognise the legacy
   * null-id row this document produced; it is never stored.
   */
  legacyEcli?: string | undefined;
  /**
   * The docket an older adapter version stored this same publisher document
   * under, where it differs from `caseNumber` (a court letter the publisher
   * never printed, read off the publisher's own identifier). Like
   * `legacyEcli`, it only lets the pipeline find the legacy null-id row this
   * document produced, which it adopts only on ECLI or source URL proof; it
   * is never stored.
   */
  legacyCaseNumber?: string | undefined;
  /**
   * Sheet number within the court file, where the source appends one to the
   * docket. Split it out with `splitCaseReference` rather than leaving it on
   * `caseNumber`: a citation names the docket alone, so a number carrying a
   * sheet matches nothing.
   */
  sheetNumber?: string | undefined;
  ecli?: string | undefined;
  court: string;
  /**
   * The court directory's exact id for `court`, required where the
   * jurisdiction identifies courts by directory id and absent everywhere
   * else. `court` is then the directory's canonical name for it
   * (`resolveDecisionCourtId`).
   */
  courtId?: string | undefined;
  country: string;
  language: string;
  decisionDate?: string | undefined;
  decisionType?: string | undefined;
  /** Declared publisher enum only; omission means unknown, never ruling. */
  documentRole?: DecisionDocumentRole | undefined;
  fulltext?: string | undefined;
  sourceUrl?: string | undefined;
  documentUrl?: string | undefined;
  metadata: Record<string, unknown>;
  /**
   * The judges the source names on this decision, in the order it prints
   * them. Absent, not empty, for a source whose pages state none: an empty
   * list is a publisher saying there are none, and the pipeline replaces the
   * decision's stored judges only when an observation carries the field.
   */
  judges?: readonly DecisionJudgeInput[] | undefined;
  /** Publisher text stored under its existing metadata keys by the pipeline. */
  textFields: ReadDecisionTextFields;
  rawHash: string;
  /** Parsed document AST, or empty object for courts without a parser. */
  documentAst: DocumentAst | EmptyAst;
  /**
   * Structural sections, when the adapter's parser can derive them from
   * the document itself. Omitted by adapters that rely on the
   * wording-based `segmentDecision` fallback in the pipeline.
   */
  sections?: DecisionSection[] | undefined;
  /**
   * The opinions `documentAst` prints, for a source whose decisions carry
   * more than one. Absent, citation short forms resolve only within the
   * block they appear in.
   */
  citationScopes?: readonly CitationOpinionScope[] | undefined;
  /** Parser version that produced the AST. Enables lazy re-parsing. */
  parserVersion?: number | undefined;
  /**
   * Raw source from the court website (HTML, JSON string, etc.)
   * stored verbatim for future re-parsing without re-downloading.
   */
  sourceRaw?: string | undefined;
  /**
   * The publisher's own cited-decisions list, where the source supplies
   * one (case numbers as published). Not stored on the row: it is the
   * ground truth the pipeline measures citation extraction against.
   */
  publisherCitedCases?: readonly string[] | undefined;
  /**
   * Binary raw source (e.g. PDF bytes) for S3 upload.
   *
   * The pipeline stores these bytes *instead of* `sourceRaw`, so an adapter
   * that sets both keeps only the bytes and loses the payload that named the
   * decision.
   */
  sourceRawBytes?: Uint8Array | undefined;
  /**
   * Binary responses the envelope names rather than holds, under the part
   * name each has in {@link SourceRawParts}.
   *
   * The envelope is text, so a document the publisher serves as a file has
   * to live beside it. The pipeline writes each of these under the
   * decision's raw prefix and rewrites the envelope's `objects` map with the
   * address it wrote them at; the adapter states only the bytes.
   */
  sourceRawObjects?:
    Readonly<Record<string, SourceRawObjectPayload>> | undefined;
  /** MIME type of sourceRaw/sourceRawBytes for S3 storage. */
  sourceRawContentType?: string | undefined;
};

/** All publisher labels cross the shared structural text boundary before ingestion. */
type PlainTextResultFields = {
  caseNumber: PlainText;
  sheetNumber?: PlainText | undefined;
  ecli?: PlainText | undefined;
  legacyEcli?: PlainText | undefined;
  legacyCaseNumber?: PlainText | undefined;
  court: PlainText;
  decisionType?: PlainText | undefined;
  metadata: Record<string, PlainTextMetadataValue>;
  judges?:
    | readonly (
        | {
            role: DecisionJudgeRole;
            nameAsPrinted: PlainText;
            czechDeclinedName?: never;
          }
        | {
            role: DecisionJudgeRole;
            czechDeclinedName: PlainText;
            nameAsPrinted?: never;
          }
      )[]
    | undefined;
  textFields: Readonly<
    Record<
      DecisionTextFieldKey,
      | Extract<TextField, { type: typeof TEXT_FIELD_TYPE.ABSENT }>
      | {
          readonly type: typeof TEXT_FIELD_TYPE.PRESENT;
          readonly text: PlainText;
        }
    >
  >;
  publisherCitedCases?: readonly PlainText[] | undefined;
  identifiers?:
    | readonly [
        Omit<DecisionIdentifiers[0], "value"> & { value: PlainText },
        ...(Omit<DecisionIdentifiers[0], "value"> & { value: PlainText })[],
      ]
    | undefined;
};

type PlainTextOutcome =
  { type: "accepted" } | { type: "item_build_failed"; error: PlainTextError };

export type IngestionResult = Omit<
  RawIngestionResult,
  keyof PlainTextResultFields
> &
  PlainTextResultFields & { plainTextOutcome: PlainTextOutcome };

/** Total over the fields whose source text cannot reach ingestion unbranded. */
export const PLAIN_TEXT_RESULT_FIELDS = {
  caseNumber: true,
  sheetNumber: true,
  ecli: true,
  legacyEcli: true,
  legacyCaseNumber: true,
  court: true,
  decisionType: true,
  metadata: true,
  judges: true,
  textFields: true,
  publisherCitedCases: true,
  identifiers: true,
} as const satisfies Record<keyof PlainTextResultFields, true>;

/** All source registrations share the branded result contract; no field debt is allowed. */
export const PLAIN_TEXT_FIELD_DEBT = {} as const satisfies Record<
  string,
  never
>;

const plainTextField = (
  field: TextField,
): Result<
  IngestionResult["textFields"][DecisionTextFieldKey],
  PlainTextError
> => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return Result.ok(field);
    case TEXT_FIELD_TYPE.PRESENT:
      return toPlainText(field.text).andThen((text) =>
        text.length === 0
          ? Result.err(
              new PlainTextError({
                message: "Published text contains no plain-text content",
                reason: "empty-present-text",
              }),
            )
          : Result.ok({ type: field.type, text }),
      );
    default:
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
  }
};

const requiredLabel = (raw: string) =>
  toPlainText(raw).andThen((plain) =>
    raw.trim().length > 0 && plain.length === 0
      ? Result.err(
          new PlainTextError({
            message: "Published label contains no plain-text content",
            reason: "empty-present-text",
          }),
        )
      : Result.ok(plain),
  );

const optionalPlainText = (raw: string | undefined) =>
  raw === undefined ? Result.ok(undefined) : toPlainText(raw);

/** Source identifiers, URLs, sourceRaw and AST structure retain their separate contracts. */
export const toPlainTextIngestionResult = <T extends RawIngestionResult>(
  raw: T,
  metadataUrlSchema?: unknown,
): Result<
  IngestionResult & Omit<T, keyof PlainTextResultFields | "plainTextOutcome">,
  PlainTextError
> =>
  Result.gen(function* () {
    if (
      "plainTextOutcome" in raw &&
      isRecord(raw.plainTextOutcome) &&
      raw.plainTextOutcome["type"] === "item_build_failed" &&
      raw.plainTextOutcome["error"] instanceof PlainTextError
    ) {
      return Result.err(raw.plainTextOutcome["error"]);
    }
    const identifiers = raw.identifiers;
    const plainIdentifiers =
      identifiers === undefined
        ? undefined
        : ([
            {
              type: identifiers[0].type,
              value: yield* toPlainText(identifiers[0].value),
            },
            ...(yield* Result.all(
              identifiers
                .slice(1)
                .map(({ type, value }) =>
                  toPlainText(value).map((plain) => ({ type, value: plain })),
                ),
            )),
          ] as const);
    return Result.ok({
      ...raw,
      plainTextOutcome: { type: "accepted" as const },
      caseNumber: yield* requiredLabel(raw.caseNumber),
      sheetNumber: yield* optionalPlainText(raw.sheetNumber),
      ecli: yield* optionalPlainText(raw.ecli),
      legacyEcli: yield* optionalPlainText(raw.legacyEcli),
      legacyCaseNumber: yield* optionalPlainText(raw.legacyCaseNumber),
      court: yield* requiredLabel(raw.court),
      decisionType: yield* optionalPlainText(raw.decisionType),
      metadata: yield* toPlainTextMetadataObject(
        raw.metadata,
        metadataUrlSchema,
      ),
      judges:
        raw.judges === undefined
          ? undefined
          : yield* Result.all(
              raw.judges.map((judge) =>
                judge.czechDeclinedName !== undefined
                  ? toPlainText(judge.czechDeclinedName).map((plain) => ({
                      role: judge.role,
                      czechDeclinedName: plain,
                    }))
                  : toPlainText(judge.nameAsPrinted).map((plain) => ({
                      role: judge.role,
                      nameAsPrinted: plain,
                    })),
              ),
            ),
      textFields: {
        [DECISION_TEXT_FIELD.ABSTRACT]: yield* plainTextField(
          raw.textFields.abstract,
        ),
        [DECISION_TEXT_FIELD.HEADNOTE]: yield* plainTextField(
          raw.textFields.headnote,
        ),
        [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: yield* plainTextField(
          raw.textFields.legalSentence,
        ),
        [DECISION_TEXT_FIELD.SUMMARY]: yield* plainTextField(
          raw.textFields.summary,
        ),
      },
      publisherCitedCases:
        raw.publisherCitedCases === undefined
          ? undefined
          : yield* Result.all(raw.publisherCitedCases.map(toPlainText)),
      identifiers: plainIdentifiers,
    });
  });

/**
 * Which decision a supplement belongs to, beyond the court, docket and
 * language it shares with that decision.
 */
export type DecisionSupplementTarget = {
  /**
   * The decision types a judgment this supplement can join carries, in the
   * stored vocabulary (`wyrok`, `postanowienie`, ...). A decision of any other
   * type under the same docket is not a candidate.
   */
  decisionTypes: readonly string[];
  /**
   * The latest date that judgment can carry: the supplement's own date, since
   * reasons are written on or after the ruling they explain. Absent where the
   * publisher stated no usable date.
   */
  latestDecisionDate?: string | undefined;
};

/**
 * A document the publisher serves under an id of its own that belongs inside
 * another decision's document, such as the written reasons SAOS publishes
 * apart from the ruling they explain.
 *
 * Not a decision with a flag: the pipeline never stores it as one while a
 * judgment holds it. It joins the judgment's document, its citations are
 * extracted as the judgment's, and it is kept in its own table so the
 * judgment's later observations can compose it again.
 */
export type DecisionSupplement = {
  kind: DecisionSupplementKind;
  target: DecisionSupplementTarget;
  /**
   * The supplement as the publisher served it, in the shape one observation
   * takes. Its court, docket and language are the judgment's too. It is
   * written as a decision row of its own only while no stored judgment
   * matches it, so its `decisionType` is the one such a row should carry.
   */
  document: IngestionResult & { sourceDocumentId: string };
};

/**
 * Reads a stored raw payload by key; null only where object storage
 * confirmed it holds no such object.
 */
export type StoredRawReader = (key: string) => Promise<Uint8Array | null>;

/** A stored raw payload read that returned no payload. */
export class StoredRawReadError extends TaggedError("StoredRawReadError")<{
  message: string;
  key: string;
  cause: unknown;
  /**
   * The object is there but can never be read as a payload (past the size
   * ceiling): asking again gives the same answer. Otherwise the store did
   * not answer, and another attempt may.
   */
  permanent: boolean;
}> {}

/**
 * Reads a stored raw payload as a value: `null` only where object storage
 * confirmed it holds no such object; any other failure is an error, so the
 * caller retries its work instead of treating the payload as absent.
 */
export type StoredRawResultReader = (
  key: string,
) => Promise<Result<Uint8Array | null, StoredRawReadError>>;

/** A reader that raises, as one that returns its failure. */
export const storedRawResultReader =
  (read: StoredRawReader): StoredRawResultReader =>
  async (key) =>
    await Result.tryPromise({
      try: async () => await read(key),
      catch: (cause) =>
        new StoredRawReadError({
          message: `Stored payload read failed for ${key}`,
          key,
          cause,
          permanent: false,
        }),
    });

/** One item an adapter read off a page: a decision, or a supplement to one. */
export type IngestionItem =
  | { type: "decision"; decision: IngestionResult }
  | { type: "supplement"; supplement: DecisionSupplement };

/** One binary response, as the adapter that fetched it hands it over. */
type SourceRawObjectPayload = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
};

/**
 * What a source says it holds for a slice, against what is held for it.
 *
 * Coverage is otherwise unknowable: a walk that silently stops early looks
 * exactly like a slice with fewer decisions in it. Recording the source's own
 * count next to the collected count turns that into a number the ledger can
 * select on.
 *
 * Written by the reconciliation loop alone. A crawl cannot state it honestly:
 * a forward-only cursor does not know which slice it has finished, so a count
 * taken mid-slice reads as a shortfall and a count taken at the end reads as
 * complete whatever the crawl skipped.
 */
export type SliceCoverage = {
  /**
   * The slice these counts describe — a calendar day for date-cursor
   * adapters. Stable across re-walks, since it keys the ledger row.
   */
  slice: string;
  /** How many records the source says the slice contains. */
  reported: number;
  /** How many of them are held. */
  collected: number;
};

/** A page of ingestion results with an optional cursor. */
export type SyncPage = {
  decisions: IngestionResult[];
  /** Failed item builds retained as listing-only rows for reconciliation. */
  itemBuildFailures?: { type: "item_build_failed"; count: number } | undefined;
  /**
   * Supplements read off the same page. The pipeline processes them after
   * the page's decisions, so a judgment and the reasons listed beside it are
   * both stored before the reasons look for their judgment.
   */
  supplements?: readonly DecisionSupplement[] | undefined;
  /**
   * Listed items whose read did not produce them. The pipeline, not the
   * adapter, decides what each costs the page: see {@link UnreadListedItem}.
   */
  unreadItems?: readonly UnreadListedItem[] | undefined;
  nextCursor: string | null;
  /**
   * The listing request whose response these decisions were read from.
   *
   * Only the adapter knows which of its requests that was: a session
   * bootstrap, a search POST, and a per-decision detail fetch are all
   * indistinguishable from outside, so request order cannot name it. Set it
   * where the listing response is parsed, and leave it unset on a page that
   * read no listing (a skipped or empty page). `update-fixtures.ts` cites it
   * as the recorded provenance of a page fixture and refuses to record an
   * adapter that names nothing.
   */
  sourceUrl?: string | undefined;
};

/** A read that did not produce a listed item, in the read-outcome vocabulary. */
export type UnreadOutcome = Extract<
  ReadOutcome<never>,
  { type: "unavailable" | "refused" }
>;

/**
 * A listed item whose detail read was `unavailable` or `refused`.
 *
 * `listing` is the row the listing alone describes, keyed by the publisher's
 * id. An unavailable item holds the page's cursor for a bounded number of
 * consecutive cycles, then the pipeline stores `listing` (or, for a row that
 * already holds its detail, only the typed outcome) and the page advances. A
 * refusal is terminal at once: it is stored typed and re-checked on the
 * normal cadence.
 */
export type UnreadListedItem = {
  listing: IngestionResult & {
    sourceDocumentId: string;
    isListingOnly: true;
  };
  outcome: UnreadOutcome;
};

export {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  withSourceRawObjects,
} from "@/api/lib/legal-search/source-raw-envelope";
export type {
  SourceRawObjectRef,
  SourceRawObjects,
  SourceRawParts,
} from "@/api/lib/legal-search/source-raw-envelope";

/**
 * A stored raw payload that is not an envelope, and the part names its own
 * keys stand for.
 *
 * `wrapper-json` is an adapter's own object around several responses,
 * `bare-payload` is one response stored alone, and `document-bytes` is a
 * payload kept as bytes. All three predate the envelope and none is written
 * again once its adapter migrates, which is why this is a ledger rather than a
 * shape the encoder can produce.
 */
export type LegacyRawShape =
  | {
      readonly shape: "wrapper-json";
      readonly contentTypes: readonly (string | null)[];
      /** Wrapper key to the part name the envelope would give that response. */
      readonly keys: Readonly<Record<string, string>>;
    }
  | {
      readonly shape: "bare-payload" | "document-bytes";
      readonly contentTypes: readonly (string | null)[];
      readonly part: string;
    };

/**
 * Austria's eleven tribunals and the ministry's document service each stored
 * the two responses they read in one object of their own, so one shape
 * describes twelve adapters and each still deletes its own line.
 *
 * The keys are what those rows hold; the values are the parts the envelope
 * gives the same two responses today, which is what lets a reader of an old
 * row ask for `document-xml` and be answered.
 */
const AT_LISTING_AND_DOCUMENT_JSON = [
  {
    shape: "wrapper-json",
    contentTypes: ["application/json"],
    keys: { listing: "listing", documentXml: "document-xml" },
  },
] as const satisfies readonly LegacyRawShape[];

const LEGACY_RAW_SHAPE_ADAPTERS = [
  ADAPTER_KEYS.CZ_US,
  ADAPTER_KEYS.CZ_REGIONAL,
  ADAPTER_KEYS.SK_COURTS,
  ADAPTER_KEYS.SK_US,
  ADAPTER_KEYS.PL_COURTS,
  ADAPTER_KEYS.EU_ECJ,
  ADAPTER_KEYS.AT_COURTS,
  ADAPTER_KEYS.AT_VFGH,
  ADAPTER_KEYS.AT_VWGH,
  ADAPTER_KEYS.AT_BVWG,
  ADAPTER_KEYS.AT_LVWG,
  ADAPTER_KEYS.AT_ASYLGH,
  ADAPTER_KEYS.AT_UBAS,
  ADAPTER_KEYS.AT_UVS,
  ADAPTER_KEYS.AT_VERG,
  ADAPTER_KEYS.AT_UMSE,
  ADAPTER_KEYS.AT_BKS,
  ADAPTER_KEYS.AT_FINDOK,
] as const satisfies readonly AdapterKey[];

export type LegacyRawShapeAdapter = (typeof LEGACY_RAW_SHAPE_ADAPTERS)[number];

/**
 * The adapters whose stored rows are not envelopes, and what a reader of those
 * rows must accept.
 *
 * Total over the adapters that have such rows and over nothing else: a
 * migrated adapter deletes its line, so the map's length is how much of the
 * fleet still stores a shape only its own reader understands. The conformance
 * suite reads committed fixtures through this map, so a line that stops
 * describing the rows it claims to describe fails rather than rots.
 */
export const LEGACY_RAW_SHAPES = {
  [ADAPTER_KEYS.CZ_US]: [
    {
      shape: "wrapper-json",
      contentTypes: ["application/json"],
      keys: {
        textHtml: "document",
        listingHtml: "listing",
        abstractHtml: "abstract",
      },
    },
    {
      shape: "bare-payload",
      contentTypes: ["text/html", null],
      part: "document",
    },
  ],
  // Kept after the adapter moved to the envelope: every row stored before it
  // did holds the document payload alone, and the listing row that named it
  // was never kept, so those rows are readable only through this shape.
  [ADAPTER_KEYS.CZ_REGIONAL]: [
    {
      shape: "bare-payload",
      contentTypes: ["application/json"],
      part: "document",
    },
  ],
  [ADAPTER_KEYS.SK_COURTS]: [
    {
      shape: "wrapper-json",
      contentTypes: ["application/json"],
      keys: { listItem: "listing", detail: "detail" },
    },
  ],
  [ADAPTER_KEYS.SK_US]: [
    {
      shape: "bare-payload",
      contentTypes: ["application/json"],
      part: "listing",
    },
    {
      // The document file, which the envelope now names as an object
      // beside the parts rather than storing as the payload itself.
      shape: "document-bytes",
      contentTypes: ["application/pdf"],
      part: "document-file",
    },
  ],
  // Kept after the adapter moved to the envelope: every row stored before it
  // holds the pair in this wrapper, and the dump row it holds is the
  // allowlisted reading of the listing response rather than the response.
  [ADAPTER_KEYS.PL_COURTS]: [
    {
      shape: "wrapper-json",
      contentTypes: ["application/json"],
      keys: { dumpItem: "listing-dump", detail: "detail" },
    },
  ],
  [ADAPTER_KEYS.EU_ECJ]: [
    {
      shape: "bare-payload",
      contentTypes: [
        "application/xhtml+xml",
        "application/xhtml+xml; stella-storage=verbatim",
      ],
      part: "document",
    },
  ],
  [ADAPTER_KEYS.AT_COURTS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_VFGH]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_VWGH]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_BVWG]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_LVWG]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_ASYLGH]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_UBAS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_UVS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_VERG]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_UMSE]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_BKS]: AT_LISTING_AND_DOCUMENT_JSON,
  [ADAPTER_KEYS.AT_FINDOK]: AT_LISTING_AND_DOCUMENT_JSON,
} as const satisfies Record<LegacyRawShapeAdapter, readonly LegacyRawShape[]>;

/**
 * A stored raw payload plus the persisted fields an adapter needs to rebuild
 * the ingestion result it once produced from it. Every field comes off the
 * decision row, so a re-parse reads object storage and the database only.
 *
 * `raw` is the object verbatim, as bytes: adapters store XHTML, JSON and PDF
 * alike, and only the adapter knows how to decode its own.
 */
export type StoredRawReparseInput = {
  raw: Uint8Array;
  /** Media type recorded with the payload; null on rows stored without one. */
  contentType: string | null;
  caseNumber: string;
  sourceDocumentId: string | null;
  language: string;
  court: string;
  ecli: string | null;
  decisionDate: string | null;
  decisionType: string | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Why a stored payload produced no result. Enumerated so a caller can report
 * each cause separately: "10 rows rejected" hides whether the parser broke or
 * the rows predate a metadata field.
 */
export const STORED_RAW_REPARSE_REJECTION = {
  /** The row lacks a field the adapter needs to rebuild the result. */
  INCOMPLETE_METADATA: "incomplete-metadata",
  /** Re-parsing would target a different decision than the selected row. */
  IDENTITY_MISMATCH: "identity-mismatch",
  /** Historical normalization erased source distinctions the parser needs. */
  RAW_FIDELITY_LOST: "raw-fidelity-lost",
  /** The stored media type is not one this adapter parses. */
  UNSUPPORTED_CONTENT: "unsupported-content",
  /** The payload parsed to nothing that could be stored as a decision. */
  NO_DOCUMENT: "no-document",
  /** The payload is a supplement to another decision, not one of its own. */
  SUPPLEMENT: "supplement",
} as const;

export type StoredRawReparseRejection =
  (typeof STORED_RAW_REPARSE_REJECTION)[keyof typeof STORED_RAW_REPARSE_REJECTION];

export type StoredRawReparseOutcome =
  | {
      type: "parsed";
      result: IngestionResult;
      /**
       * The docket the selected row is stored under, where the adapter proved
       * it is an older spelling of `result.caseNumber` (for example one an
       * earlier parser stored before decoding it). A replay compares identity
       * under it and writes the new spelling over the row; absent, the docket
       * must match exactly.
       */
      legacyCaseNumber?: string | undefined;
    }
  /**
   * The payload is a supplement to another decision. A replay does not write
   * it over the row it was read from; the supplement fold does.
   */
  | { type: "supplement"; supplement: DecisionSupplement }
  | {
      type: "rejected";
      rejection: StoredRawReparseRejection;
      /** Row-specific context for the operator; safe to print. */
      detail: string;
    };

/** A rejection on its own, for a step that can refuse before a result exists. */
type StoredRawReparseRejected = Extract<
  StoredRawReparseOutcome,
  { type: "rejected" }
>;

export type StoredRawListing =
  | {
      type: "listing";
      /** Every part of the envelope, for the payloads beside the listing. */
      parts: SourceRawParts;
      /** The listing row, verified to name the decision the database holds. */
      listing: Record<string, unknown>;
      /** The decoded envelope, reusable when replay preserves it verbatim. */
      sourceRaw: string;
    }
  | StoredRawReparseRejected;

export type ReadStoredRawListingOptions = {
  stored: StoredRawReparseInput;
  /** The envelope part holding the publisher's listing row. */
  part: string;
  /** The publisher id that row states, read the way the adapter keys it. */
  identityOf: (listing: Record<string, unknown>) => string | undefined;
};

/**
 * The listing row inside a stored envelope, once it is known to describe the
 * row that was selected.
 *
 * Four refusals stand between a stored payload and a replay — the media type,
 * the envelope, the row's JSON, and whether the row names this decision at all
 * — and every adapter storing an envelope has to make all four. Made once here,
 * beside the envelope's own encoder and the rejection vocabulary, so a
 * publisher's replay cannot quietly answer a different question from its
 * neighbour's.
 */
export const readStoredRawListing = ({
  identityOf,
  part,
  stored,
}: ReadStoredRawListingOptions): StoredRawListing => {
  if (stored.contentType !== SOURCE_RAW_ENVELOPE_CONTENT_TYPE) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
      detail: `stored under ${stored.contentType ?? "no content type"}`,
    };
  }

  const sourceRaw = new TextDecoder().decode(stored.raw);
  const parts = decodeSourceRawEnvelope(sourceRaw);
  const listingRaw = parts?.[part];
  if (parts === null || listingRaw === undefined) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.INCOMPLETE_METADATA,
      detail: "the stored payload holds no listing row",
    };
  }

  const listing = Result.try({
    try: (): unknown => JSON.parse(listingRaw),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(listing)) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.RAW_FIDELITY_LOST,
      detail: "the stored listing row is not an object",
    };
  }

  const identity = identityOf(listing);
  if (identity !== stored.sourceDocumentId) {
    return {
      type: "rejected",
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      detail: `the envelope names ${identity ?? "no id"}, the row ${stored.sourceDocumentId ?? "none"}`,
    };
  }

  return { type: "listing", parts, listing, sourceRaw };
};

/**
 * How a listing item would be keyed once stored, mirroring the two halves of
 * the decision identity index: the publisher's own document id where the item
 * carries one, the docket plus its language otherwise.
 *
 * There is no variant for an item with nothing to key on (case-law AGENTS.md
 * rule 20): a record the publisher lists without a usable id is stored under
 * its quarantine identity (`quarantine-identity.ts`), a `document` identity
 * like any other, so every listed record is both counted and collected.
 */
export type ListingIdentity =
  | { type: "document"; sourceDocumentId: string }
  | { type: "case-number"; caseNumber: string; language: string };

/**
 * Mirrors `case_law_reconciliation_items.identity_key`. A key longer than the
 * column cannot be parked, so it cannot be tracked to a fixed point either.
 * Every persistable identity fits: `source_document_id` and `case_number`
 * are both bounded at 256 characters.
 */
const LISTING_IDENTITY_KEY_MAX_LENGTH = 320;

const IDENTITY_KEY_PREFIX = {
  DOCUMENT: "document:",
  CASE_NUMBER: "case-number:",
} as const;

const unboundedListingIdentityKey = (identity: ListingIdentity): string => {
  switch (identity.type) {
    case "document":
      return `${IDENTITY_KEY_PREFIX.DOCUMENT}${identity.sourceDocumentId}`;
    case "case-number":
      return `${IDENTITY_KEY_PREFIX.CASE_NUMBER}${identity.language}:${identity.caseNumber}`;
    default: {
      identity satisfies never;
      return panic(`Unhandled listing identity: ${JSON.stringify(identity)}`);
    }
  }
};

/**
 * Whether an identity has a key: no empty half, since an empty one produces
 * a key the parser below rejects, and a key within the column. Adapters
 * check an identity the publisher states with this at their boundary and
 * quarantine the record when it fails, so {@link listingIdentityKey} never
 * meets one that does.
 */
export const isKeyableListingIdentity = (
  identity: ListingIdentity,
): boolean => {
  switch (identity.type) {
    case "document":
      return isPersistableSourceDocumentId(identity.sourceDocumentId);
    case "case-number":
      return (
        identity.caseNumber.length > 0 &&
        identity.language.length > 0 &&
        unboundedListingIdentityKey(identity).length <=
          LISTING_IDENTITY_KEY_MAX_LENGTH
      );
    default: {
      identity satisfies never;
      return panic(`Unhandled listing identity: ${JSON.stringify(identity)}`);
    }
  }
};

/**
 * The stable string form of an identity.
 *
 * Panics on one {@link isKeyableListingIdentity} rejects: adapters quarantine
 * such a record at their boundary, so meeting one here is an adapter bug, and
 * skipping it would drop a listed record from both what its slice reports and
 * what it collects. In a reconciliation walk the panic fails the slice, which
 * keeps the slice's previous ledger row and records the error.
 */
export const listingIdentityKey = (identity: ListingIdentity): string =>
  isKeyableListingIdentity(identity)
    ? unboundedListingIdentityKey(identity)
    : panic(
        `Listing identity has no key; quarantine it at the adapter boundary: ${identity.type}`,
      );

/**
 * The identity a key names, or `null` when no current rule produces that key.
 *
 * The inverse of `listingIdentityKey`, deliberately its neighbour: a stored
 * key has to be read back to ask whether its decision has since been stored,
 * and a parser living apart from the format it parses is free to drift from
 * it. `listingIdentityKey` round-trips through this for every keyable
 * identity, which is the property that binds the two.
 */
export const parseListingIdentityKey = (
  key: string,
): ListingIdentity | null => {
  if (key.startsWith(IDENTITY_KEY_PREFIX.DOCUMENT)) {
    const sourceDocumentId = key.slice(IDENTITY_KEY_PREFIX.DOCUMENT.length);
    return sourceDocumentId.length === 0
      ? null
      : { type: "document", sourceDocumentId };
  }
  if (!key.startsWith(IDENTITY_KEY_PREFIX.CASE_NUMBER)) {
    return null;
  }
  const rest = key.slice(IDENTITY_KEY_PREFIX.CASE_NUMBER.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    return null;
  }
  return {
    type: "case-number",
    language: rest.slice(0, separator),
    caseNumber: rest.slice(separator + 1),
  };
};

/** One item as the publisher lists it, plus how the ingest would key it. */
export type ReconciliationListingItem = {
  identity: ListingIdentity;
  /** Verbatim listing payload, JSON-serializable; replayed into buildDecision. */
  payload: unknown;
  /**
   * For a record keyed on a publisher id: the quarantine ids an id-less
   * listing of the same record would get, whether or not the adapter emits
   * them as repair aliases. The walker reports a slice that also lists one
   * of them as a quarantined record (`quarantinePeerCollisions`).
   */
  quarantinePeers?: readonly string[] | undefined;
};

export type ReconciliationSlicePage = {
  items: ReconciliationListingItem[];
  /**
   * Records the page lists that state no stable field at all (no publisher
   * id and nothing a quarantine identity could hash, such as a result the
   * publisher counts but will not serve). There is nothing to key or store
   * for them, so they are not items, but the publisher listed them: the walk
   * counts them so coverage shows the gap instead of losing them. Absent
   * means none.
   */
  withoutStableFields?: number | undefined;
  /** 0 where the publisher lists nothing for the slice at all. */
  totalPages: number;
};

export type ReconciliationSlicePageOptions = {
  slice: string;
  /** 0-indexed page within the slice. */
  page: number;
  signal?: AbortSignal | undefined;
};

/**
 * What building one listed item produced. `detail-unavailable` must never be
 * written: a detail-less row would make the identity held and take the
 * document out of every later reconciliation.
 */
export type ReconciliationBuildOutcome =
  | {
      type: "built";
      decision: IngestionResult;
      /**
       * Rows of their own the publisher states on the same page (the court
       * rulings attached to a decision), written after the decision.
       */
      companions?: readonly IngestionResult[] | undefined;
    }
  | { type: "built-supplement"; supplement: DecisionSupplement }
  | { type: "unkeyable" }
  | { type: "detail-unavailable" };

/**
 * How a source's history divides into addressable slices.
 *
 * Slices are opaque strings to the loop and must sort lexicographically in
 * walk order, so a ledger's `(source, slice)` rows can be ordered and
 * compared without the loop knowing what a slice means to the adapter.
 *
 * Separated from {@link SourceReconciliation} because it is the half that
 * says nothing about what a slice contains: `reconciliation-plan.ts` selects
 * work off these five fields alone, so any corpus family with a slice-walk —
 * legislation included — feeds the same selector rather than a second copy of
 * its ordering rules.
 */
export type SourceSliceWalk = {
  /**
   * The discriminant against a corpus-family-specific unsupported marker,
   * absent here so an implemented capability is written plainly rather than
   * wrapped. Declared so every reader narrows on one field instead of probing
   * for another.
   */
  type?: undefined;
  /** First slice the publisher can list (e.g. the feed's first day). */
  firstSlice: string;
  /** Slice for a UTC instant (the tip). */
  sliceOf: (now: Date) => string;
  /** Next slice after `slice` in walk order, or null past the tip. */
  nextSlice: (slice: string) => string | null;
  /**
   * Slice before `slice` in walk order, or null at `firstSlice`. The
   * historical sweep runs newest-first, so it needs the walk order reversed:
   * unsurveyed recent history is worth more than unsurveyed old history, and
   * a sweep that could only step forward would have to start at the feed's
   * beginning every time.
   */
  previousSlice: (slice: string) => string | null;
  /** Slices near the tip that get re-walked on a fast cadence. */
  tipWindowDays: number;
};

/** See `SourceReconciliation.heldWithoutDocument`. */
type HeldWithoutDocument = {
  readonly metadataKey: string;
  readonly reasons: readonly [string, ...string[]];
};

/** See `SourceReconciliation.recheckHeld`. */
type HeldRecheck = {
  readonly metadataKey: string;
  readonly values: readonly [string, ...string[]];
};

/** A held listing-only row whose detail can become available without a new listing version. */
type TextlessHeldRecheck = {
  readonly metadataKey: string;
  readonly values: readonly [string, ...string[]];
  readonly minimumAgeDays: number;
  readonly perWorkUnitLimit: number;
  readonly buildDecisionFromStored: (
    stored: StoredRawReparseInput,
    signal?: AbortSignal,
  ) => Promise<ReconciliationBuildOutcome>;
};

/** The row-level rules that decide whether a stored row counts as held. */
export type HeldRowRules = {
  readonly withoutDocument?: HeldWithoutDocument | undefined;
  readonly recheck?: HeldRecheck | undefined;
};

/**
 * The capability that makes a source reconcilable: the publisher can be asked
 * what it holds for a slice, independently of the cursor the crawl advanced.
 */
export type SourceReconciliation = SourceSliceWalk & {
  /**
   * Per-record content/identity signal, excluding listing coordinates and corpus-wide revisions.
   * Classify each new payload field as content/identity (include it) or traversal/repair metadata (exclude it).
   */
  revisionOf: (payload: unknown) => unknown;
  /**
   * Whether a stored row counts as held only when it carries the document,
   * and not when it carries the listing metadata alone.
   *
   * Defaults to false, and that default is load-bearing rather than lazy. A
   * source may be metadata-only by design: sk-courts ingests the listing and
   * a separate drain fetches documents afterwards, so at any moment a large
   * part of its corpus legitimately holds no document. Treating those rows as
   * not held would report millions of decisions missing and re-ingest them
   * under reconciliation, which is a worse failure than the one this flag
   * fixes.
   *
   * Set it only where a detail-less row means the document fetch failed for a
   * decision the source otherwise stores whole. There the row is a stub the
   * walk left behind, and reading it as held takes the decision out of every
   * later reconciliation: the identity is present, the slice reads reconciled,
   * and the document is never hunted again.
   *
   * Keyed on the pipeline's own `isListingOnly` marker, so it means the same
   * thing for every source that opts in.
   */
  heldRequiresDetail?: boolean | undefined;
  /**
   * The identities `heldRequiresDetail` does not apply to: records the source
   * publishes as metadata alone, which the pipeline stores under the same
   * no-document marker a failed fetch leaves. Without this, a source mixing
   * such records with documents it does serve has to pick one rule for both,
   * and either counts its metadata-only records missing on every walk or
   * stops hunting the documents that failed.
   *
   * Read off the identity alone, because the parked-retry path holds nothing
   * else; absent, every identity follows `heldRequiresDetail`.
   */
  heldWithoutDetail?: ((identity: ListingIdentity) => boolean) | undefined;
  /**
   * The stored rows `heldRequiresDetail` does not apply to, read off the row
   * rather than the identity: a source whose records of one kind are complete
   * or not depending on what the publisher served for each (a document that
   * is an image, no document at all) states the reason on the row, under
   * `metadataKey`, and names here the reasons that make a row complete
   * without its text. The reason is a declared value, so a later pass that
   * can read those documents selects exactly the rows it names.
   */
  heldWithoutDocument?: HeldWithoutDocument | undefined;
  /**
   * Held rows the walk asks for again whenever it walks their slice: a record
   * the publisher is still adding to (a decision awaiting the court ruling on
   * its appeal, which the publisher attaches to the decision's own page) states
   * so on the row, under `metadataKey`, with one of `values`. Bounded by the
   * slice cadence and by how many rows state it; a row stops being asked for
   * once its build no longer states it.
   */
  recheckHeld?: HeldRecheck | undefined;
  /** Opt-in for bounded, durable re-reads of older textless listing-only rows. */
  textlessHeldRecheck?: TextlessHeldRecheck | undefined;
  listSlicePage: (
    options: ReconciliationSlicePageOptions,
  ) => Promise<ReconciliationSlicePage>;
  buildDecision: (
    payload: unknown,
    signal?: AbortSignal,
  ) => Promise<ReconciliationBuildOutcome>;
  /** Creates a reader owned by one slice walk or one slice's bounded retry batch. */
  createSliceBuildDecision?:
    (() => SourceReconciliation["buildDecision"]) | undefined;
};

/**
 * What asking a source how much it holds produced.
 *
 * Three answers rather than a nullable number. "The publisher exposes no
 * count" is a permanent property of the source; "the probe did not complete"
 * is a statement about one request and nothing about the source. A caller
 * given only null has to guess which it got, and every caller guessed the
 * same way: it reported both as "no count" and alarmed on neither.
 *
 * `errorTag` is a structural, non-PII identifier — an `errorTag(...)` result
 * where the adapter caught a throw, and an adapter-authored tag naming the
 * step where it did not (a refused status, an unreadable payload). Never a
 * message: these tags reach logs and dashboards.
 */
export type SourceTotalCount =
  | { type: "count"; total: number }
  | { type: "no-count-endpoint" }
  | { type: "probe-failed"; errorTag: string };

/**
 * Tags for the count probe failures an adapter detects without a throw.
 * Alongside `errorTag(...)`, which names the ones it catches.
 */
export const SOURCE_TOTAL_PROBE_FAILURE = {
  /** The count endpoint answered with a status the adapter refuses. */
  HTTP_STATUS: "http-status",
  /** The answer carried no count this adapter can read. */
  UNREADABLE_PAYLOAD: "unreadable-payload",
} as const;

export type SourceTotalProbeFailure =
  (typeof SOURCE_TOTAL_PROBE_FAILURE)[keyof typeof SOURCE_TOTAL_PROBE_FAILURE];

/** A failure the adapter detected without a throw. */
export const sourceTotalProbeFailed = (
  failure: SourceTotalProbeFailure,
): SourceTotalCount => ({ type: "probe-failed", errorTag: failure });

/**
 * The count answer for a number an adapter read out of a publisher's payload.
 *
 * One rule for every source: a total is a positive, finite integer, and
 * anything else is a payload the adapter could not read rather than a corpus
 * of nothing. Zero especially — no publisher here holds no decisions, so a
 * zero is a query that did not run, and recording it would state a false floor
 * that every coverage figure is then measured against.
 */
export const sourceTotalRead = (value: number): SourceTotalCount =>
  Number.isSafeInteger(value) && value > 0
    ? { type: "count", total: value }
    : sourceTotalProbeFailed(SOURCE_TOTAL_PROBE_FAILURE.UNREADABLE_PAYLOAD);

/**
 * Where a field the publisher states ends up once the decision is stored.
 *
 * A union rather than a string, because the destinations are read back
 * differently: ordinary metadata and decision text have separate boundaries,
 * a result field is a column of the row, and the last two are not fields at all.
 */
export type SourceFieldTarget =
  /** Exact JSON field retained in a named raw part; `*` visits every array row. */
  | {
      readonly type: "raw";
      readonly part: string;
      readonly path: readonly string[];
      readonly reason: string;
    }
  /** `metadata[key]` on the stored row. */
  | { readonly type: "metadata"; readonly key: string }
  /** A publisher-authored field represented by the decision text contract. */
  | { readonly type: "textField"; readonly key: DecisionTextFieldKey }
  /** A field of the ingestion result itself, spelled as the contract does. */
  | { readonly type: "result"; readonly key: keyof IngestionResult }
  /** Reaches the row inside the parsed document: AST, sections or fulltext. */
  | { readonly type: "document" }
  /** Keys the row: the publisher id the decision is stored under. */
  | { readonly type: "identity" };

/**
 * Marks a reason that went through {@link excludedSourceField}. The symbol is
 * not exported, so an exclusion written as a bare object literal does not
 * satisfy the union: the only way to state one is through the constructor,
 * which is where a blank reason is rejected.
 */
const STATED_REASON: unique symbol = Symbol("stated exclusion reason");

type Whitespace = " " | "\t" | "\n" | "\r";

type Trimmed<TText extends string> = TText extends `${Whitespace}${infer TRest}`
  ? Trimmed<TRest>
  : TText extends `${infer TRest}${Whitespace}`
    ? Trimmed<TRest>
    : TText;

/** A reason with words in it, or `never`, which fails at the call site. */
type StatedReason<TText extends string> =
  Trimmed<TText> extends "" ? never : TText;

/**
 * What an adapter does with one field its source states.
 *
 * Exclusion carries a reason because that is the whole point: a field nobody
 * decided about and a field deliberately left is the same silence otherwise,
 * and the first is how a published headnote sits unread on a page the adapter
 * already fetches. A blank reason would be that same silence wearing the
 * shape of a decision, so it cannot be written.
 */
export type SourceFieldDisposition =
  | { readonly disposition: "stored"; readonly target: SourceFieldTarget }
  | {
      readonly disposition: "excluded";
      readonly reason: string;
      readonly [STATED_REASON]: true;
    };

/**
 * State why a field the source publishes is not stored. The reason has to say
 * something: `""` and `"   "` are compile errors rather than a check somebody
 * has to remember to run.
 */
export const excludedSourceField = <const TText extends string>(
  reason: StatedReason<TText>,
): SourceFieldDisposition => ({
  disposition: "excluded",
  reason,
  [STATED_REASON]: true,
});

/**
 * The adapters that may still declare a surface they do not record.
 *
 * Closed and hand-listed rather than derived from {@link ADAPTER_KEYS}: a
 * source added tomorrow must record what its publisher serves or say why not,
 * and deriving the union would hand it the exemption the day it registers.
 * `source-surface-backlog-baseline.json` names the surfaces each of these may
 * leave unrecorded, and both only shrink.
 */
export const LEGACY_BACKLOG_ADAPTERS = [
  ADAPTER_KEYS.CZ_NS,
  ADAPTER_KEYS.CZ_NSS,
  ADAPTER_KEYS.SK_COURTS,
  ADAPTER_KEYS.SK_US,
  ADAPTER_KEYS.PL_COURTS,
  ADAPTER_KEYS.AT_COURTS,
  ADAPTER_KEYS.AT_VFGH,
  ADAPTER_KEYS.AT_VWGH,
  ADAPTER_KEYS.AT_BVWG,
  ADAPTER_KEYS.AT_LVWG,
  ADAPTER_KEYS.AT_ASYLGH,
  ADAPTER_KEYS.AT_UBAS,
  ADAPTER_KEYS.AT_UVS,
  ADAPTER_KEYS.AT_VERG,
  ADAPTER_KEYS.AT_UMSE,
  ADAPTER_KEYS.AT_BKS,
  ADAPTER_KEYS.EU_ECJ,
] as const satisfies readonly AdapterKey[];

export type LegacyAdapterKey = (typeof LEGACY_BACKLOG_ADAPTERS)[number];

/** A surface this adapter records, under the part name the envelope gives it. */
export type StoredSourceSurface = {
  readonly disposition: "stored";
  /** The envelope part the response is kept as. */
  readonly part: string;
};

export type ExcludedSourceSurface = {
  readonly disposition: "excluded";
  readonly reason: string;
  readonly [STATED_REASON]: true;
};

export type BacklogSourceSurface = {
  readonly disposition: "backlog";
  readonly reason: string;
  /** Whose baseline line this surface occupies; only a legacy adapter has one. */
  readonly adapter: LegacyAdapterKey;
  readonly [STATED_REASON]: true;
};

/**
 * What an adapter does with one surface its publisher serves for a decision.
 *
 * A field inventory answers "what does the page state"; this answers the
 * question before it — which of the publisher's pages are read at all. A
 * surface nobody decided about is the silence a field inventory cannot break,
 * because the inventory only ever sees the pages already fetched.
 */
export type SourceSurfaceDisposition =
  StoredSourceSurface | ExcludedSourceSurface | BacklogSourceSurface;

/** A response the crawl fetches with the decision and keeps as `part`. */
export const storedSourceSurface = (part: string): StoredSourceSurface => ({
  disposition: "stored",
  part,
});

/** State why a surface the publisher serves is not recorded at all. */
export const excludedSourceSurface = <const TText extends string>(
  reason: StatedReason<TText>,
): ExcludedSourceSurface => ({
  disposition: "excluded",
  reason,
  [STATED_REASON]: true,
});

/**
 * A surface that belongs in the row and is not there yet.
 *
 * The adapter argument is the escape's whole cost: only an adapter that
 * already exists can be named, the committed baseline lists the surfaces each
 * one may leave, and the conformance suite fails both ways — so the set
 * shrinks as families enrol and can never grow with a new source.
 */
export const backlogSurface = <const TText extends string>(
  adapter: LegacyAdapterKey,
  reason: StatedReason<TText>,
): BacklogSourceSurface => ({
  disposition: "backlog",
  reason,
  adapter,
  [STATED_REASON]: true,
});

/**
 * Every surface an adapter's publisher serves for a decision, and its fate.
 *
 * An adapter writes the map `as const satisfies Record<<its SOURCE_SURFACES
 * union>, SourceSurfaceDisposition>`, so a surface listed without a
 * disposition does not compile.
 */
export type SourceSurfaceCensus = {
  readonly surfaces: Readonly<Record<string, SourceSurfaceDisposition>>;
};

/**
 * Every field a source states for one decision, and what becomes of it.
 *
 * Scoped to the per-decision pages an adapter fetches — the labelled detail,
 * print or metadata payloads it parses for a document, not the listing that
 * named it, whose columns the cursor and identity conformance suites cover.
 *
 * `fields` is total over the source's own field names by construction: an
 * adapter declares those names once as a `SOURCE_FIELDS` list and writes the
 * map `as const satisfies Record<<that union>, SourceFieldDisposition>`, so a
 * name added to the list without a disposition does not compile.
 *
 * `listSourceFields` reads the whole stored envelope, not one page: a source
 * states fields across the responses it serves for a decision — a listing row,
 * a detail payload, a document — and an inventory that could only see one of
 * them would declare the others out of scope by accident. The conformance
 * suite drives it over each adapter's fixture: a name it returns that the map
 * does not hold fails with the field name, which is the check a per-adapter
 * test cannot make about the fields its author never noticed.
 */
export type SourceFieldInventory = {
  readonly status: "declared";
  readonly fields: Readonly<Record<string, SourceFieldDisposition>>;
  /**
   * A promise is allowed because a stored part can be a document: the labels
   * inside it are read by the same reader the parser uses, and that reader is
   * asynchronous. A source whose parts are text answers synchronously.
   */
  readonly listSourceFields: (
    parts: SourceRawParts,
  ) => readonly string[] | Promise<readonly string[]>;
};

/**
 * Interface for court data source adapters.
 *
 * Each adapter knows how to paginate through a specific
 * court's API or website and parse decisions into a
 * normalized format.
 */
export type SourceAdapter = {
  key: AdapterKey;
  documentStage: DocumentStage;
  observeDocumentStage: (
    options: Omit<DocumentStagePageOptions, "source">,
  ) => Promise<Result<SyncPage, AdapterFetchError>>;
  /** An opt-in annotation source; never a second decision-producing adapter. */
  collectionEnrichment?: SkCollectionConnector | undefined;
  name: string;
  /**
   * The jurisdiction this source publishes for. Typed rather than free text:
   * every per-jurisdiction policy in the slice is a total map over
   * `CaseLawJurisdiction`, so registering a source for a jurisdiction nobody
   * has declared a citation-resolution policy for is a compile error rather
   * than a silent default at run time.
   */
  country: CaseLawJurisdiction;
  language: string;
  fetchPage: (
    cursor: string | null,
    config: Record<string, unknown>,
    signal?: AbortSignal,
    onDocumentObservation?: DocumentStageObserver,
  ) => Promise<Result<SyncPage, AdapterFetchError>>;
  /** Minimum ms between requests to respect rate limits. */
  minRequestIntervalMs: number;
  /** Override per-page timeout (ms). Defaults to ADAPTER_TIMEOUT.PAGE. */
  pageTimeoutMs?: number | undefined;
  /**
   * Max pages per pipeline cycle. Shorter cycles persist cursors
   * more often, reducing lost work on interruptions. Defaults
   * to MAX_SYNC_PAGES (100). Slow adapters (sequential probing)
   * should set this lower (e.g., 10).
   */
  maxSyncPages?: number | undefined;
  /**
   * Override per-adapter cycle timeout (ms). Defaults to
   * MAX_CYCLE_MS (10 min). Adapters doing lightweight work
   * per page (metadata-only, no PDF) can use longer cycles
   * to maximize throughput per cursor persist.
   */
  maxCycleMs?: number | undefined;
  /**
   * Re-parse a payload this adapter already stored into the ingestion result
   * it would produce for that payload today, without contacting the
   * publisher. The result goes through the same pipeline a crawl feeds, so
   * whatever the parser now derives (AST, sections, fulltext, keywords, and
   * the hash over them) is applied by the same writes.
   *
   * Optional. It exists only for adapters whose stored payload is one
   * decision: where the payload is a list endpoint's page covering many
   * decisions, one blob cannot be mapped back to one row, and the adapter
   * omits this rather than guessing.
   *
   * The outcome may be returned directly by a parser that needs no I/O, or
   * as a promise by one that does (an office-format extractor, say).
   */
  reparseStoredRaw?: (
    stored: StoredRawReparseInput,
  ) => StoredRawReparseOutcome | Promise<StoredRawReparseOutcome>;
  /**
   * Ask the source how many decisions it holds, so held-vs-total coverage has
   * a denominator the publisher itself states.
   *
   * Required: a source nobody can count is a source whose coverage nobody can
   * report, and that has to be a stated property of the adapter rather than a
   * field somebody forgot. An adapter classifies its own answer, because only
   * it knows whether its publisher states no total or its probe broke.
   */
  getTotalCount: (signal: AbortSignal) => Promise<SourceTotalCount>;
  /**
   * Every field this source states for a decision, stored or excluded with a
   * reason. Required: a field nobody decided about is how published material
   * an adapter already fetches goes unstored, and the decision has to live in
   * the adapter rather than in whoever last read the page.
   *
   */
  sourceFields: SourceFieldInventory;
  /**
   * Every surface this publisher serves for a decision, and whether the row
   * records it. Required, and the step before the field inventory: an
   * inventory can only ever account for the pages an adapter already fetches,
   * so a page nobody fetches is invisible to it. A surface left unrecorded is
   * a `backlog` entry with a reason and a line in the committed baseline, not
   * a page nobody wrote down.
   */
  sourceSurfaces: SourceSurfaceCensus;
  /**
   * Ask the publisher what it lists for a slice, so the standing
   * reconciliation loop can compare that against what is held and ingest the
   * difference.
   *
   * Required. Every registered case-law source publishes an independently
   * addressable listing, so unsupported reconciliation is not a valid adapter
   * state.
   */
  reconciliation: SourceReconciliation;
};

type SourceAdapterDefinition<TKey extends AdapterKey> = Omit<
  SourceAdapter,
  "country" | "key" | "name" | "observeDocumentStage"
> & {
  readonly key: TKey;
  readonly documentStage: (typeof ADAPTER_MANIFESTS)[TKey]["documentStage"];
};

type ScopedCallbacks<TSource> = {
  [
    TKey in keyof TSource as Extract<
      TSource[TKey],
      (...args: never[]) => unknown
    > extends never
      ? never
      : TKey
  ]-?: TSource[TKey] | undefined;
};

/** Build an adapter from the source facts declared for its registry key. */
export const defineSourceAdapter = <
  const TKey extends AdapterKey,
  const TAdapter extends SourceAdapterDefinition<TKey>,
>(
  // `key` names TKey for inference; the constraint then binds documentStage to
  // that key's manifest instead of the union of every manifest's stage.
  adapter: TAdapter & { readonly key: TKey },
): Omit<SourceAdapter, "key" | "documentStage" | "reconciliation"> & {
  readonly key: TAdapter["key"];
  readonly documentStage: TAdapter["documentStage"];
  readonly reconciliation: TAdapter["reconciliation"] & SourceReconciliation;
} => {
  const scope = { type: "ingestion", adapterKey: adapter.key } as const;
  const scoped = <TArgs extends unknown[], TResult>(
    operation: (...args: TArgs) => TResult,
  ) =>
    function (this: unknown, ...args: TArgs) {
      return withExceptionScope(scope, () => operation.apply(this, args));
    };
  const reconciliation = adapter.reconciliation;
  const createSliceBuildDecision = reconciliation.createSliceBuildDecision;
  const textlessHeldRecheck = reconciliation.textlessHeldRecheck;
  const reparseStoredRaw = adapter.reparseStoredRaw;
  const collectionEnrichment = adapter.collectionEnrichment;
  const observeDocumentStage = async (
    options: Omit<DocumentStagePageOptions, "source">,
  ) =>
    await withExceptionScope(
      scope,
      async () =>
        await withDocumentStageWindow({ ...options, source: adapter.key }),
    );
  // Total callback projections make a new callback require a scope decision.
  const callbacks = {
    observeDocumentStage,
    getTotalCount: scoped(adapter.getTotalCount),
    reparseStoredRaw:
      reparseStoredRaw === undefined ? undefined : scoped(reparseStoredRaw),
    fetchPage: async (cursor, config, signal, onDocumentObservation) =>
      await observeDocumentStage({
        fetchPage: async () => {
          const fetched = await Result.tryPromise({
            try: async () => await adapter.fetchPage(cursor, config, signal),
            catch: (cause) =>
              new AdapterFetchError({
                message: "Adapter page fetch failed",
                adapterKey: adapter.key,
                cursor,
                cause,
              }),
          });
          return fetched.andThen((page) => page);
        },
        observe: onDocumentObservation,
      }),
  } satisfies ScopedCallbacks<SourceAdapter>;
  const { reparseStoredRaw: scopedReparseStoredRaw, ...requiredCallbacks } =
    callbacks;
  const reconciliationCallbacks = {
    revisionOf: scoped(reconciliation.revisionOf),
    sliceOf: scoped(reconciliation.sliceOf),
    nextSlice: scoped(reconciliation.nextSlice),
    previousSlice: scoped(reconciliation.previousSlice),
    listSlicePage: scoped(reconciliation.listSlicePage),
    buildDecision: scoped(reconciliation.buildDecision),
    heldWithoutDetail:
      reconciliation.heldWithoutDetail === undefined
        ? undefined
        : scoped(reconciliation.heldWithoutDetail),
    createSliceBuildDecision:
      createSliceBuildDecision === undefined
        ? undefined
        : scoped(function (this: unknown) {
            return scoped(createSliceBuildDecision.call(this));
          }),
  } satisfies ScopedCallbacks<SourceReconciliation>;
  const sourceFieldCallbacks = {
    listSourceFields: scoped(adapter.sourceFields.listSourceFields),
  } satisfies ScopedCallbacks<SourceFieldInventory>;
  const collection =
    collectionEnrichment === undefined
      ? undefined
      : {
          ...collectionEnrichment,
          ...({
            readIssue: scoped(collectionEnrichment.readIssue),
            join: scoped(collectionEnrichment.join),
          } satisfies ScopedCallbacks<SkCollectionConnector>),
        };
  const textless =
    textlessHeldRecheck === undefined
      ? undefined
      : {
          ...textlessHeldRecheck,
          ...({
            buildDecisionFromStored: scoped(
              textlessHeldRecheck.buildDecisionFromStored,
            ),
          } satisfies ScopedCallbacks<TextlessHeldRecheck>),
        };
  return {
    ...adapter,
    ...requiredCallbacks,
    ...(scopedReparseStoredRaw === undefined
      ? {}
      : { reparseStoredRaw: scopedReparseStoredRaw }),
    country: ADAPTER_MANIFESTS[adapter.key].country,
    name: ADAPTER_MANIFESTS[adapter.key].name,
    sourceFields: { ...adapter.sourceFields, ...sourceFieldCallbacks },
    collectionEnrichment: collection,
    reconciliation: {
      ...reconciliation,
      ...reconciliationCallbacks,
      textlessHeldRecheck: textless,
    },
  };
};
