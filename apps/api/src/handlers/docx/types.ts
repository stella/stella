// Shared types for DOCX generation modes (b) and (c).

import { isFieldPath } from "@stll/template-conditions";

// ── Common ────────────────────────────────────────────────

export type RevisionAuthor = {
  name: string;
  /** ISO 8601 date string, e.g. "2026-02-17T12:00:00Z" */
  date: string;
};

export type TextFormat = {
  bold?: boolean;
  italic?: boolean;
};

// ── Mode (b): Template filling ────────────────────────────

export type DiscoveredPlaceholder = {
  name: string;
  count: number;
};

export type RichRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
};

export type RichPatchValue = string | { paragraphs: { runs: RichRun[] }[] };

export type FillTemplateResult = {
  buffer: Buffer;
  unmatchedPlaceholders: string[];
  unusedValues: string[];
  structureErrors: TemplateStructureError[];
};

// ── Mode (c): Tracked-changes editing ─────────────────────

export type DocxEdit =
  | {
      kind: "insert";
      paragraphIndex: number;
      charOffset?: number;
      text: string;
      format?: TextFormat;
    }
  | {
      kind: "delete";
      paragraphIndex: number;
      charOffset: number;
      length: number;
    }
  | {
      kind: "replace";
      paragraphIndex: number;
      charOffset: number;
      length: number;
      text: string;
      format?: TextFormat;
    };

export type DocxComment = {
  paragraphIndex: number;
  charOffset: number;
  length: number;
  text: string;
};

export type DocxEditSet = {
  edits: DocxEdit[];
  comments: DocxComment[];
  author: RevisionAuthor;
};

export type DiffStats = {
  wordsAdded: number;
  wordsRemoved: number;
};

export type DiffResult = {
  edits: DocxEdit[];
  /** Paragraph indices from rewrites that didn't match any
   *  extracted paragraph (typo or stale index). */
  skippedRewrites: number[];
  stats: DiffStats;
};

export type EditWithTrackingResult = {
  buffer: Buffer;
  /** Edit paragraph indices that didn't exist in the document. */
  skippedEdits: number[];
  /** Comment paragraph indices that didn't exist. */
  skippedComments: number[];
  /** OOXML structural violations (non-blocking warnings). */
  validationViolations?:
    | {
        rule: string;
        message: string;
        element?: string | undefined;
      }[]
    | undefined;
};

export type ParagraphRewrite = {
  paragraphIndex: number;
  /** Full rewritten paragraph text. */
  newText: string;
};

export type ParagraphSource = "header" | "body" | "footer";

export type ExtractedParagraph = {
  index: number;
  text: string;
  style?: string | undefined;
  /** Which part of the document this paragraph came from. */
  source?: ParagraphSource | undefined;
  /** True when all (or majority of) text runs are bold. */
  bold?: boolean | undefined;
  /** Font size in half-points from the first run (24 = 12pt). */
  fontSize?: number | undefined;
  /** Paragraph alignment from `w:jc`. */
  alignment?: "left" | "center" | "right" | "both" | undefined;
  /** True when the paragraph is a block directive. */
  isDirective?: boolean | undefined;
  /** Which directive this paragraph represents. */
  directiveKind?: BlockDirectiveKind | undefined;
  /** The expression inside the directive (empty for `#else`). */
  directiveExpression?: string | undefined;
};

/**
 * Which revision view the extracted text represents.
 *
 * - `"accepted"` — deleted text is excluded, inserted text is
 *   included. This is the text as it would appear if all tracked
 *   changes were accepted (Word's "No Markup" view).
 */
export type RevisionView = "accepted";

export type ExtractedDocument = {
  paragraphs: ExtractedParagraph[];
  charCount: number;
  /** Which revision view this text represents. */
  view: RevisionView;
};

// ── Template data model (extended) ───────────────────────

export type TemplateDataValue =
  | string
  | number
  | boolean
  | RichPatchValue
  | TemplateDataValue[]
  | { [key: string]: TemplateDataValue };

export type TemplateData = Record<string, TemplateDataValue>;

export type BlockDirectiveKind =
  | "if"
  | "elseif"
  | "else"
  | "endif"
  | "each"
  | "endeach";

export type BlockDirective = {
  kind: BlockDirectiveKind;
  expression: string;
  paragraphIndex: number;
};

export type IfBranch = {
  condition: string;
  contentStart: number;
  contentEnd: number;
};

export type IfBlock = {
  kind: "if";
  branches: IfBranch[];
  directiveParagraphs: number[];
};

export type EachBlock = {
  kind: "each";
  arrayPath: string;
  contentStart: number;
  contentEnd: number;
  directiveParagraphs: number[];
};

export type Block = IfBlock | EachBlock;

export type TemplateFieldKind = "string" | "boolean" | "array" | "object";

export type DiscoveredField = {
  path: string;
  kind: TemplateFieldKind;
  itemFields?: DiscoveredField[];
  count: number;
  /** Condition expression that must be true for this
   *  field to be visible in the fill form. Absent when
   *  the field is always visible. */
  visibleWhen?: string;
};

export type TemplateStructureError = {
  message: string;
  paragraphIndex: number;
  directive: string;
  /** Which container this error originated from. */
  source?: ParagraphSource;
};

export type DiscoveredTemplate = {
  placeholders: DiscoveredPlaceholder[];
  fields: DiscoveredField[];
  structureErrors: TemplateStructureError[];
};

// ── Custom XML Manifest ─────────────────────────────────

export const INPUT_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "date",
  "select",
] as const;

export type InputType = (typeof INPUT_TYPES)[number];

export type PartInputType = "text" | "select";

/** One part of a composite field's value (see {@link FieldMeta.parts}). */
export type FieldPart = {
  /** Part key referenced by the field's format; same charset as field paths. */
  key: string;
  label?: string | undefined;
  inputType: PartInputType;
  /** Allowed values when {@link inputType} is "select". */
  options?: string[] | undefined;
  /** Regex matched against the whole part value at fill time. */
  pattern?: string | undefined;
};

/** Registries a lookup field can resolve against. Mirrors the slugs of
 *  `BUSINESS_REGISTRY_DISPATCH`; extend as more registries gain fill-time
 *  lookup support. */
export const LOOKUP_REGISTRIES = ["krs"] as const;

export type LookupRegistry = (typeof LOOKUP_REGISTRIES)[number];

/**
 * Registry lookup configuration (see {@link FieldMeta.lookup}): the person
 * filling enters only the registry number; at fill time the company is
 * resolved via the business-registry dispatch and the marker is filled with
 * the rendered company details.
 */
export type FieldLookup = {
  registry: LookupRegistry;
  /**
   * Optional AI instruction that formats the registry hit into the final
   * string (e.g. "[company name], with its seat in [seat], KRS [number]").
   * Without it (or with no model provider) a deterministic "name, seat"
   * rendering is used.
   */
  aiFormat?: string | undefined;
};

export const DATE_FORMAT_STYLES = ["long", "medium", "short", "iso"] as const;

export type DateFormatStyle = (typeof DATE_FORMAT_STYLES)[number];

/**
 * Locale-aware date rendering (see {@link FieldMeta.dateFormat}): the
 * submitted ISO date is formatted via `Intl.DateTimeFormat` in the document's
 * language at fill time (e.g. cs long → "13. června 2028"); "iso" leaves the
 * submitted value as-is.
 */
export type FieldDateFormat = {
  /** BCP-47 language tag of the document, e.g. "cs", "de", "pl". */
  locale: string;
  style: DateFormatStyle;
};

export type FieldValidation = {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
};

export type FieldMeta = {
  path: string;
  label?: string | undefined;
  /**
   * Short guidance for the person filling the field (expected format, where
   * to find the value, …). Shown as the input's placeholder in the fill form
   * and included in AI prompts so prefill maps source text to the right
   * field. Kept short (~200 chars, enforced by the config UI).
   */
  hint?: string | undefined;
  inputType?: InputType | undefined;
  options?: string[] | undefined;
  validation?: FieldValidation | undefined;
  required?: boolean | undefined;
  /**
   * When set, the field's value is drafted by AI at fill time from this
   * instruction (e.g. "Draft the scope of this power of attorney"), unless the
   * user supplies a value. The model provider is injected at the fill boundary;
   * with no provider the field is simply left unfilled.
   */
  aiPrompt?: string | undefined;
  /**
   * When true, the user-entered value is a stub that AI rewrites at fill time
   * to fit the surrounding text of each marker occurrence (declension and
   * phrasing differ per sentence in inflected languages). With no model
   * provider, or on any model failure, the stub fills every occurrence as-is.
   */
  aiAdapt?: boolean | undefined;
  /**
   * Composite field: the value is entered as several parts (e.g. a select for
   * a professional title plus a free-text name) that are validated and joined
   * by {@link format} into the single string the document's one {{marker}} is
   * filled with. Present iff `format` is present; a field with parts ignores
   * its own inputType for input rendering.
   */
  parts?: FieldPart[] | undefined;
  /** Join template over part keys, `{{key}}` syntax (e.g. "{{position}} {{name}}").
   *  Present iff `parts` is present. */
  format?: string | undefined;
  /**
   * Dependent select: path of another field whose submitted value(s) supply
   * this field's allowed options at fill time (e.g. the user first enters a
   * list of parties, and this field must be one of them). Static {@link
   * options} act as a fallback while the source field is empty.
   */
  optionsFrom?: string | undefined;
  /**
   * Registry lookup field: the submitted value is a registry number (e.g. a
   * KRS number) that is resolved against the configured business registry at
   * fill time and replaced with the rendered company details.
   */
  lookup?: FieldLookup | undefined;
  /**
   * Formula field: the value is derived from other fields via an arithmetic
   * expression (evaluated by `evaluateNumericExpression`) at fill time, e.g.
   * `min(rent * (1 + index / 100), rent * 1.05)`. Derived, never
   * user-submitted; mutually exclusive with the other value sources
   * ({@link aiPrompt}, {@link aiAdapt}, {@link lookup}, {@link parts}).
   */
  formula?: string | undefined;
  /**
   * Locale-aware rendering for a "date" {@link inputType} field: the
   * submitted ISO date (the date input's value) is formatted in this locale
   * and style before substitution — and before any AI step, so a field that
   * also sets {@link aiAdapt} hands the formatted date to the per-occurrence
   * adapter as the stub.
   */
  dateFormat?: FieldDateFormat | undefined;
};

/**
 * Matches `NamedCondition` from `@stll/template-conditions`.
 * Kept here for co-location with `TemplateManifest`.
 */
export type NamedCondition = {
  name: string;
  expression: string;
  label?: string;
};

export type TemplateManifest = {
  version: number;
  fields: FieldMeta[];
  conditions: NamedCondition[];
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInputType = (value: unknown): value is InputType =>
  INPUT_TYPES.some((inputType) => inputType === value);

const isFieldValidation = (value: unknown): value is FieldValidation => {
  if (!isRecordLike(value)) {
    return false;
  }

  return (
    (value["required"] === undefined ||
      typeof value["required"] === "boolean") &&
    (value["minLength"] === undefined ||
      typeof value["minLength"] === "number") &&
    (value["maxLength"] === undefined ||
      typeof value["maxLength"] === "number") &&
    (value["min"] === undefined || typeof value["min"] === "number") &&
    (value["max"] === undefined || typeof value["max"] === "number") &&
    (value["pattern"] === undefined || typeof value["pattern"] === "string")
  );
};

const isPartInputType = (value: unknown): value is PartInputType =>
  value === "text" || value === "select";

export const isFieldPart = (value: unknown): value is FieldPart =>
  isRecordLike(value) &&
  typeof value["key"] === "string" &&
  isFieldPath(value["key"]) &&
  (value["label"] === undefined || typeof value["label"] === "string") &&
  isPartInputType(value["inputType"]) &&
  (value["options"] === undefined ||
    (Array.isArray(value["options"]) &&
      value["options"].every((option) => typeof option === "string"))) &&
  (value["pattern"] === undefined || typeof value["pattern"] === "string");

const isLookupRegistry = (value: unknown): value is LookupRegistry =>
  LOOKUP_REGISTRIES.some((registry) => registry === value);

const isDateFormatStyle = (value: unknown): value is DateFormatStyle =>
  DATE_FORMAT_STYLES.some((style) => style === value);

/** Structurally malformed BCP-47 tags make `Intl` throw a RangeError; a
 *  well-formed but unknown tag passes and merely falls back to the default
 *  locale at format time. */
export const isPlausibleLocale = (value: string): boolean => {
  try {
    Intl.DateTimeFormat.supportedLocalesOf(value);
    return true;
  } catch {
    return false;
  }
};

export const isFieldDateFormat = (value: unknown): value is FieldDateFormat =>
  isRecordLike(value) &&
  typeof value["locale"] === "string" &&
  isPlausibleLocale(value["locale"]) &&
  isDateFormatStyle(value["style"]);

export const isFieldLookup = (value: unknown): value is FieldLookup =>
  isRecordLike(value) &&
  isLookupRegistry(value["registry"]) &&
  (value["aiFormat"] === undefined || typeof value["aiFormat"] === "string");

export const isFieldMeta = (value: unknown): value is FieldMeta => {
  if (!isRecordLike(value) || typeof value["path"] !== "string") {
    return false;
  }

  // parts and format describe one composite value together: parts without a
  // join format (or vice versa) cannot be rendered, so reject the half-shape.
  if ((value["parts"] === undefined) !== (value["format"] === undefined)) {
    return false;
  }

  // A formula field's value is derived at fill time, never user-entered, so
  // the other value-source mechanisms cannot coexist with it.
  if (
    value["formula"] !== undefined &&
    (value["aiPrompt"] !== undefined ||
      value["aiAdapt"] !== undefined ||
      value["lookup"] !== undefined ||
      value["parts"] !== undefined)
  ) {
    return false;
  }

  return (
    (value["label"] === undefined || typeof value["label"] === "string") &&
    (value["hint"] === undefined || typeof value["hint"] === "string") &&
    (value["inputType"] === undefined || isInputType(value["inputType"])) &&
    (value["options"] === undefined ||
      (Array.isArray(value["options"]) &&
        value["options"].every((option) => typeof option === "string"))) &&
    (value["validation"] === undefined ||
      isFieldValidation(value["validation"])) &&
    (value["required"] === undefined ||
      typeof value["required"] === "boolean") &&
    (value["aiPrompt"] === undefined ||
      typeof value["aiPrompt"] === "string") &&
    (value["aiAdapt"] === undefined || typeof value["aiAdapt"] === "boolean") &&
    (value["parts"] === undefined ||
      (Array.isArray(value["parts"]) &&
        value["parts"].length > 0 &&
        value["parts"].every(isFieldPart))) &&
    (value["format"] === undefined || typeof value["format"] === "string") &&
    (value["optionsFrom"] === undefined ||
      (typeof value["optionsFrom"] === "string" &&
        isFieldPath(value["optionsFrom"]))) &&
    (value["lookup"] === undefined || isFieldLookup(value["lookup"])) &&
    (value["formula"] === undefined || typeof value["formula"] === "string") &&
    (value["dateFormat"] === undefined ||
      isFieldDateFormat(value["dateFormat"]))
  );
};

export const isNamedCondition = (value: unknown): value is NamedCondition =>
  isRecordLike(value) &&
  typeof value["name"] === "string" &&
  typeof value["expression"] === "string" &&
  (value["label"] === undefined || typeof value["label"] === "string");

const isRichRun = (value: unknown): value is RichRun =>
  isRecordLike(value) &&
  typeof value["text"] === "string" &&
  (value["bold"] === undefined || typeof value["bold"] === "boolean") &&
  (value["italic"] === undefined || typeof value["italic"] === "boolean");

const isRichPatchValueObject = (value: unknown): value is RichPatchValue =>
  isRecordLike(value) &&
  Array.isArray(value["paragraphs"]) &&
  value["paragraphs"].every(
    (paragraph) =>
      isRecordLike(paragraph) &&
      Array.isArray(paragraph["runs"]) &&
      paragraph["runs"].every(isRichRun),
  );

const TEMPLATE_DATA_MAX_DEPTH = 64;

const isTemplateDataValueAtDepth = (
  value: unknown,
  depth: number,
): value is TemplateDataValue => {
  if (depth > TEMPLATE_DATA_MAX_DEPTH) {
    return false;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isTemplateDataValueAtDepth(item, depth + 1));
  }
  if (isRichPatchValueObject(value)) {
    return true;
  }
  if (isRecordLike(value)) {
    return Object.values(value).every((item) =>
      isTemplateDataValueAtDepth(item, depth + 1),
    );
  }
  return false;
};

export const isTemplateDataValue = (
  value: unknown,
): value is TemplateDataValue => isTemplateDataValueAtDepth(value, 0);

export const isTemplateData = (value: unknown): value is TemplateData =>
  isRecordLike(value) &&
  Object.values(value).every((item) => isTemplateDataValueAtDepth(item, 0));

export const isTemplateManifest = (value: unknown): value is TemplateManifest =>
  isRecordLike(value) &&
  typeof value["version"] === "number" &&
  Number.isFinite(value["version"]) &&
  Array.isArray(value["fields"]) &&
  value["fields"].every(isFieldMeta) &&
  Array.isArray(value["conditions"]) &&
  value["conditions"].every(isNamedCondition);

export type ResolvedField = {
  path: string;
  kind: TemplateFieldKind;
  count: number;
  label?: string | undefined;
  /** Mirrors {@link FieldMeta.hint}: the fill form shows it as the input's
   *  placeholder; AI prefill includes it when mapping source text. */
  hint?: string | undefined;
  inputType?: InputType | undefined;
  options?: string[] | undefined;
  validation?: FieldValidation | undefined;
  required?: boolean | undefined;
  /** Mirrors {@link FieldMeta.aiAdapt}: the fill form shows an AI-adaptation
   *  hint next to the field's input when set. */
  aiAdapt?: boolean | undefined;
  /** Mirrors {@link FieldMeta.parts}: the fill form renders one input per part. */
  parts?: FieldPart[] | undefined;
  /** Mirrors {@link FieldMeta.format}. */
  format?: string | undefined;
  /** Mirrors {@link FieldMeta.optionsFrom}: the fill form derives the select's
   *  options live from the referenced field's current value(s). */
  optionsFrom?: string | undefined;
  /** Mirrors {@link FieldMeta.lookup}: the fill form shows a registry-lookup
   *  hint and checks the registry-number format before submit. */
  lookup?: FieldLookup | undefined;
  /** Mirrors {@link FieldMeta.formula}: the value is derived at fill time, so
   *  the fill form renders no input for the field. */
  formula?: string | undefined;
  /** Mirrors {@link FieldMeta.dateFormat}: the fill form can preview how the
   *  entered date will render in the document's language. */
  dateFormat?: FieldDateFormat | undefined;
  itemFields?: ResolvedField[] | undefined;
  /** Condition expression that must be true for this
   *  field to be visible in the fill form. */
  visibleWhen?: string | undefined;
};
