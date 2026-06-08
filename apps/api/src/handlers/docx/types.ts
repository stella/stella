// Shared types for DOCX generation modes (b) and (c).

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

export type InputType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "date"
  | "select";

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

/**
 * A field whose value is derived from other fields via an arithmetic
 * expression (evaluated by `evaluateNumericExpression`) at fill time, e.g.
 * `{ name: "rent_indexed", expression: "min(rent*(1+index/100), rent*1.05)" }`.
 */
export type ComputedField = {
  name: string;
  expression: string;
  label?: string;
};

export type TemplateManifest = {
  version: number;
  fields: FieldMeta[];
  conditions: NamedCondition[];
  // Optional: manifests authored before computed fields existed omit it.
  computed?: ComputedField[];
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInputType = (value: unknown): value is InputType => {
  switch (value) {
    case "text":
    case "textarea":
    case "number":
    case "boolean":
    case "date":
    case "select":
      return true;
    default:
      return false;
  }
};

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

export const isFieldMeta = (value: unknown): value is FieldMeta => {
  if (!isRecordLike(value) || typeof value["path"] !== "string") {
    return false;
  }

  return (
    (value["label"] === undefined || typeof value["label"] === "string") &&
    (value["inputType"] === undefined || isInputType(value["inputType"])) &&
    (value["options"] === undefined ||
      (Array.isArray(value["options"]) &&
        value["options"].every((option) => typeof option === "string"))) &&
    (value["validation"] === undefined ||
      isFieldValidation(value["validation"])) &&
    (value["required"] === undefined ||
      typeof value["required"] === "boolean") &&
    (value["aiPrompt"] === undefined || typeof value["aiPrompt"] === "string")
  );
};

export const isNamedCondition = (value: unknown): value is NamedCondition =>
  isRecordLike(value) &&
  typeof value["name"] === "string" &&
  typeof value["expression"] === "string" &&
  (value["label"] === undefined || typeof value["label"] === "string");

export const isComputedField = (value: unknown): value is ComputedField =>
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
  value["conditions"].every(isNamedCondition) &&
  // `computed` is optional for backward compatibility with manifests
  // authored before computed fields existed.
  (value["computed"] === undefined ||
    (Array.isArray(value["computed"]) &&
      value["computed"].every(isComputedField)));

export type ResolvedField = {
  path: string;
  kind: TemplateFieldKind;
  count: number;
  label?: string | undefined;
  inputType?: InputType | undefined;
  options?: string[] | undefined;
  validation?: FieldValidation | undefined;
  required?: boolean | undefined;
  itemFields?: ResolvedField[] | undefined;
  /** Condition expression that must be true for this
   *  field to be visible in the fill form. */
  visibleWhen?: string | undefined;
};
