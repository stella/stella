// parser-output-unchanged: the ÚOHS adapter entry is new; existing adapters read only their own keys, so their parsed output is unchanged.
// parser-output-unchanged: declarations about parser output; no parser reads this module.
/**
 * What each case-law source's parsed decision carries, field by field.
 *
 * The raw inventory (`SourceAdapter.sourceFields`) answers "is every field the
 * publisher states stored". This answers the question after it: of the
 * structure a decision is expected to have once parsed — the court's
 * paragraph numbers first — which does each source deliver, and where it does
 * not, why. A field nobody decided about is how Czech decisions shipped
 * without the paragraph numbers their courts print, while three other sources
 * filled them: `ParagraphBlock.number` was a free optional, and an optional
 * nobody is obliged to fill reads exactly like one that cannot be filled.
 *
 * The map below is total twice over: over every registered source, and per
 * source over {@link PROCESSED_FIELDS}. A source or a field added without a
 * disposition does not compile. Each disposition is checked against recorded
 * documents by `processed-field-inventory.test.ts`: a `provided` field must be
 * present in the parsed recording, and a `skipped` claim must not be
 * contradicted by it.
 */

import {
  ADAPTER_KEYS,
  type AdapterKey,
  IMPORT_SOURCE_KEYS,
  type ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";

/**
 * The processed fields every source declares. Grows one member at a time:
 * each member brings its conformance check, and every source's disposition.
 */
export const PROCESSED_FIELDS = [
  /**
   * The court's own citable paragraph numbers, as `ParagraphBlock.number`,
   * moved out of the text. Read by the reader's gutter, `#par=` links
   * (`resolveDecisionParagraphRange`) and citations of "bod N".
   */
  "court-paragraph-numbers",
] as const;

export type ProcessedFieldId = (typeof PROCESSED_FIELDS)[number];

/**
 * Why a source's parsed decisions do not carry a field. Closed: a reason is
 * a code an operator can sweep for, and its justification says the rest.
 */
export const PROCESSED_FIELD_SKIP_REASONS = {
  /** The publisher's documents do not contain this fact. */
  SOURCE_LACKS: "source-lacks",
  /** The court has the fact, but the rendering this source serves drops it. */
  PUBLISHER_REMOVES: "publisher-removes",
  /**
   * The documents contain it and the parser does not produce it yet. Legacy
   * only: listed in the backlog baseline, which can only shrink.
   */
  NOT_EXTRACTED: "not-extracted",
  /**
   * Nobody has established whether the documents contain it. Legacy only,
   * like `not-extracted`: a new source answers the question before it lands.
   */
  UNASSESSED: "unassessed",
} as const;

export type ProcessedFieldSkipReason =
  (typeof PROCESSED_FIELD_SKIP_REASONS)[keyof typeof PROCESSED_FIELD_SKIP_REASONS];

/** Skip reasons that are a debt rather than a fact about the source. */
export const BACKLOG_SKIP_REASONS = [
  PROCESSED_FIELD_SKIP_REASONS.NOT_EXTRACTED,
  PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
] as const satisfies readonly ProcessedFieldSkipReason[];

/** Every source a disposition is owed for: crawled adapters and importers. */
export type ProcessedFieldSourceKey = AdapterKey | ImportSourceKey;

/**
 * Where the claim is checked: recorded publisher bytes, relative to
 * `apps/api`, read by the source's own parser in the conformance suite.
 */
export type ProcessedFieldEvidence =
  | { readonly kind: "recording"; readonly fixtures: readonly string[] }
  /**
   * No recording establishes the claim yet. Legacy only: the pair is listed
   * in the backlog baseline, which can only shrink.
   */
  | { readonly kind: "unrecorded"; readonly reason: string };

const STATED: unique symbol = Symbol("stated processed-field disposition");

type Whitespace = " " | "\t" | "\n" | "\r";

type Trimmed<TText extends string> = TText extends `${Whitespace}${infer TRest}`
  ? Trimmed<TRest>
  : TText extends `${infer TRest}${Whitespace}`
    ? Trimmed<TRest>
    : TText;

/** Words, or `never`, which fails at the call site. */
type Stated<TText extends string> = Trimmed<TText> extends "" ? never : TText;

export type ProvidedProcessedField = {
  readonly disposition: "provided";
  /** Where the field is produced: the parser step that fills it. */
  readonly how: string;
  readonly evidence: ProcessedFieldEvidence;
  readonly [STATED]: true;
};

export type SkippedProcessedField = {
  readonly disposition: "skipped";
  readonly reason: ProcessedFieldSkipReason;
  /** What the source does and why the field is not on the decision. */
  readonly justification: string;
  readonly evidence: ProcessedFieldEvidence;
  readonly [STATED]: true;
};

/**
 * One source's answer for one field. Written only through the constructors
 * below, which is where a blank `how` or justification fails to compile.
 */
export type ProcessedFieldDisposition =
  ProvidedProcessedField | SkippedProcessedField;

/** Recorded publisher bytes the conformance suite parses for the claim. */
const recordedEvidence = (
  ...fixtures: readonly [string, ...string[]]
): ProcessedFieldEvidence => ({ kind: "recording", fixtures });

/** No recording yet; the pair must be on the backlog baseline. */
const unrecordedEvidence = <const TText extends string>(
  reason: Stated<TText>,
): ProcessedFieldEvidence => ({ kind: "unrecorded", reason });

const providedField = <const THow extends string>(
  how: Stated<THow>,
  evidence: ProcessedFieldEvidence,
): ProvidedProcessedField => ({
  disposition: "provided",
  how,
  evidence,
  [STATED]: true,
});

const skippedField = <const TText extends string>(
  reason: ProcessedFieldSkipReason,
  justification: Stated<TText>,
  evidence: ProcessedFieldEvidence,
): SkippedProcessedField => ({
  disposition: "skipped",
  reason,
  justification,
  evidence,
  [STATED]: true,
});

export type ProcessedFieldDeclaration = Readonly<
  Record<ProcessedFieldId, ProcessedFieldDisposition>
>;

const PARAGRAPH_NUMBERS_FROM_TEXT =
  "courtParagraphNumbers moves the court's leading [N] / N. / N) marker into ParagraphBlock.number when the decision's paragraphs read as one numbering";

const AT_RIS_PARAGRAPH_NUMBERS = skippedField(
  PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
  "RIS full texts carry outline numbering ('1.2. Zur Situation') kept as text; whether the Supreme Court's recent decisions print citable margin numbers has not been checked against a recording",
  unrecordedEvidence(
    "the recorded RIS texts are a regional court and tribunals; no recent Supreme Court full text is recorded",
  ),
);

/**
 * Every source's disposition of every processed field.
 *
 * Evidence paths are relative to `apps/api`.
 */
export const PROCESSED_FIELD_INVENTORY = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    "court-paragraph-numbers": providedField(
      PARAGRAPH_NUMBERS_FROM_TEXT,
      recordedEvidence(
        "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-regional-finaldoc-district.json.gz",
        "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-regional-finaldoc-appellate.json.gz",
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-regional-17-c-33-2019.finaldoc.json.gz",
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-regional-26-c-151-2021.finaldoc.json.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.CZ_NS]: {
    "court-paragraph-numbers": providedField(
      PARAGRAPH_NUMBERS_FROM_TEXT,
      recordedEvidence(
        "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-ns-page.json.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    "court-paragraph-numbers": providedField(
      PARAGRAPH_NUMBERS_FROM_TEXT,
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-nss-10-as-124-2025.html.gz",
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-nss-22-as-35-2026.html.gz",
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-nss-10-azs-28-2026.html.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.CZ_US]: {
    "court-paragraph-numbers": providedField(
      PARAGRAPH_NUMBERS_FROM_TEXT,
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-us-iv-us-422-26.html.gz",
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-us-iii-us-2429-24.html.gz",
        "src/handlers/case-law/ingestion/parsers/__fixtures__/cz-us-iv-us-1394-24.html.gz",
        "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-us-page.json.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.NOT_EXTRACTED,
      "general-court decisions can number their reasoning ('1. Okresný súd …' in a seeded decision) and the PDF parser keeps the number as text; it is not run through the shared extractor until a recorded PDF shows its paragraphs number correctly",
      unrecordedEvidence(
        "the two general-court PDFs checked on 2026-10-12 (a district and a regional decision) had unnumbered reasoning; the seeded decision's document was unavailable",
      ),
    ),
  },
  [ADAPTER_KEYS.SK_US]: {
    "court-paragraph-numbers": providedField(
      PARAGRAPH_NUMBERS_FROM_TEXT,
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/sk-us-iii-us-265-2026.content.json.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.NOT_EXTRACTED,
      "some common-court reasons number their points ('1.' on its own line) and the number stays in the text",
      unrecordedEvidence(
        "the recorded SAOS details do not include a numbered reasoning",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_SN]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "the PDF parser keeps hanging-indent numbered paragraphs as text; whether they are the court's citable numbering is unchecked",
      unrecordedEvidence("no Supreme Court PDF is recorded"),
    ),
  },
  [ADAPTER_KEYS.PL_KIO]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "the recorded rulings number operative points ('1. umarza', '3.1.'), which are not paragraph numbering; numbered reasoning is unchecked",
      unrecordedEvidence(
        "no recording has been checked for numbered reasoning",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_TK]: {
    "court-paragraph-numbers": providedField(
      "parsePlTkText takes the publisher's .wyrok_akapitNr cell as ParagraphBlock.number",
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/pl-tk-case-sk-14-11.html.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_NSA]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.NOT_EXTRACTED,
      "the reasons are numbered ('1. Wyrokiem z …', '2. Skargę kasacyjną …') and the parser keeps the number as text",
      recordedEvidence(
        "src/handlers/case-law/ingestion/adapters/__fixtures__/pl-nsa-rows.json",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "numbered units open their first paragraph as printed; the recorded documents show roman units only",
      unrecordedEvidence(
        "no recording has been checked for numbered reasoning",
      ),
    ),
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_UVS]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_VERG]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_BKS]: {
    "court-paragraph-numbers": AT_RIS_PARAGRAPH_NUMBERS,
  },
  [ADAPTER_KEYS.AT_FINDOK]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.SOURCE_LACKS,
      "Federal Finance Court decisions in Findok are unnumbered running paragraphs",
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/at-findok-152649.zip",
      ),
    ),
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    "court-paragraph-numbers": providedField(
      "parseEcjDecisionHtml reads the point number from the marker's id (point N) into ParagraphBlock.number",
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62022CJ0128.en.html.gz",
      ),
    ),
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    "court-paragraph-numbers": providedField(
      "parseHuBhgyDecision strips the leading [N] into ParagraphBlock.number",
      recordedEvidence(
        "src/handlers/case-law/ingestion/parsers/__fixtures__/hu-bhgy-decision.docx",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_KIS]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "tax rulings and explanations; whether any series numbers its reasoning is unchecked",
      unrecordedEvidence(
        "no recording has been checked for numbered reasoning",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_UODO]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "decision units carry outline markers kept as text with listDepth; whether they are citable paragraph numbers is unchecked",
      unrecordedEvidence(
        "the recorded decision has not been classified against the numbering check",
      ),
    ),
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "the PDF parser has no paragraph-number handling; the recorded PDFs have not been checked for numbered reasoning",
      unrecordedEvidence(
        "the recorded PDFs have not been checked for numbered reasoning",
      ),
    ),
  },
  [ADAPTER_KEYS.CZ_UOHS]: {
    "court-paragraph-numbers": providedField(
      PARAGRAPH_NUMBERS_FROM_TEXT,
      recordedEvidence(
        "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-uohs-2026-R0137.pdf",
        "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-uohs-2026-S0383.pdf",
      ),
    ),
  },
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: {
    "court-paragraph-numbers": skippedField(
      PROCESSED_FIELD_SKIP_REASONS.UNASSESSED,
      "some state courts print paragraph numbers (¶ N); the opinion parsers keep them as text and the corpus has not been sampled for them",
      unrecordedEvidence(
        "the recorded opinions have not been sampled for ¶-numbered courts",
      ),
    ),
  },
} as const satisfies Record<ProcessedFieldSourceKey, ProcessedFieldDeclaration>;
