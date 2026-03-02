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

export type DiffResult = {
  edits: DocxEdit[];
  /** Paragraph indices from rewrites that didn't match any
   *  extracted paragraph (typo or stale index). */
  skippedRewrites: number[];
};

export type EditWithTrackingResult = {
  buffer: Buffer;
  /** Edit paragraph indices that didn't exist in the document. */
  skippedEdits: number[];
  /** Comment paragraph indices that didn't exist. */
  skippedComments: number[];
  /** OOXML structural violations (non-blocking warnings). */
  validationViolations?: Array<{
    rule: string;
    message: string;
    element?: string;
  }>;
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
  style?: string;
  /** Which part of the document this paragraph came from. */
  source?: ParagraphSource;
  /** True when all (or majority of) text runs are bold. */
  bold?: boolean;
  /** Font size in half-points from the first run (24 = 12pt). */
  fontSize?: number;
  /** Paragraph alignment from `w:jc`. */
  alignment?: "left" | "center" | "right" | "both";
  /** True when the paragraph is a block directive. */
  isDirective?: boolean;
  /** Which directive this paragraph represents. */
  directiveKind?: BlockDirectiveKind;
  /** The expression inside the directive (empty for `#else`). */
  directiveExpression?: string;
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
  label?: string;
  inputType?: InputType;
  options?: string[];
  validation?: FieldValidation;
  required?: boolean;
};

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

export type ResolvedField = {
  path: string;
  kind: TemplateFieldKind;
  count: number;
  label?: string;
  inputType?: InputType;
  options?: string[];
  validation?: FieldValidation;
  required?: boolean;
  itemFields?: ResolvedField[];
};
