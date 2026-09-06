// Shared types for DOCX generation modes (b) and (c).

import * as v from "valibot";

import { BUSINESS_REGISTRY_SLUGS } from "@stll/api-contract";
import type { ExtractedDocxParagraph } from "@stll/folio-core/server";
import {
  type BlockDirectiveKind,
  type ConditionNode,
  DATE_FORMAT_STYLES,
  type DateFormatStyle,
  type FieldDateFormat,
  conditionNodeSchema,
  isFieldPath,
} from "@stll/template-conditions";

import type { TemplateWarning } from "@/api/lib/docx/template-warnings";
import {
  fieldSourceSchema,
  fieldSourceToolInputSchema,
  type FieldSource,
} from "@/api/lib/template-binding/binding-sources";

export type { FieldSource } from "@/api/lib/template-binding/binding-sources";
export { isFieldSource } from "@/api/lib/template-binding/binding-sources";
export { DATE_FORMAT_STYLES };
export type { DateFormatStyle, FieldDateFormat };

// ── Common ────────────────────────────────────────────────

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

export type ParagraphRewrite = {
  paragraphIndex: number;
  /** Full rewritten paragraph text. */
  newText: string;
};

export type ParagraphSource = ExtractedDocxParagraph["source"];

export type ExtractedParagraph = Omit<ExtractedDocxParagraph, "source"> & {
  /** Which part of the document this paragraph came from. */
  source?: ParagraphSource | undefined;
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
  /** Marker mistakes that parse but almost certainly do not do what the author
   *  meant. Never blocks a save; reported so it is fixed before the first
   *  fill. */
  warnings: TemplateWarning[];
  /** Paths a `{{#if}}` / `{{#elseif}}` expression reads, sorted. Distinguishes
   *  a condition driver from a value marker, which the field list alone
   *  cannot: a path can be both. */
  conditionPaths: string[];
};

// ── Custom XML Manifest ─────────────────────────────────

export const INPUT_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
] as const;

export type InputType = (typeof INPUT_TYPES)[number];

export type PartInputType = "text" | "select";

/** Canonical parsed part of a composite field value. */
export type FieldPart = v.InferOutput<typeof fieldPartSchema>;

/** Registries a lookup field can resolve against. Single-sourced from the
 *  dispatch table's slug set, so every registry the fill boundary can resolve
 *  (`BUSINESS_REGISTRY_DISPATCH`) is offered as a lookup target. */
export const LOOKUP_REGISTRIES = BUSINESS_REGISTRY_SLUGS;

export type LookupRegistry = (typeof LOOKUP_REGISTRIES)[number];

/**
 * Registry lookup configuration (see {@link FieldMeta.lookup}): the person
 * filling enters only the registry number; at fill time the company is
 * resolved via the business-registry dispatch and the marker is filled with
 * the rendered company details.
 */
/**
 * One named output format for a lookup field (see {@link FieldLookup.formats}).
 * The author enters the registry number once; each format renders the SAME
 * resolved hit through its own [token] template. The FIRST format is the
 * default, addressed by the bare marker `{{path}}`; every later format is
 * addressed by a dotted marker `{{path.key}}` in the document.
 */
export type FieldLookupFormat = v.InferOutput<typeof fieldLookupFormatSchema>;

/** Upper bound on named formats per lookup field; keeps the manifest small and
 *  the per-fill render work bounded. */
export const LOOKUP_FORMATS_MAX = 10;

/** Max length of a single format template, mirroring the config UI's limit. */
export const LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH = 2000;

/** A format key is one field-path segment: letters, digits, underscore, dash;
 *  no dots (the dot separates the field path from the key in the marker). */
const LOOKUP_FORMAT_KEY_RE = /^[\p{L}\p{N}_-]+$/u;

export const isLookupFormatKey = (value: string): boolean =>
  LOOKUP_FORMAT_KEY_RE.test(value);

export type FieldLookup = v.InferOutput<typeof fieldLookupSchema>;

export const isFieldLookupFormat = (
  value: unknown,
): value is FieldLookupFormat => v.is(fieldLookupFormatSchema, value);

export type FieldValidation = v.InferOutput<typeof fieldValidationSchema>;

/** Canonical parsed field metadata. Runtime validation, MCP schema generation,
 * and downstream TypeScript all derive from {@link fieldMetaSchema}. */
export type FieldMeta = v.InferOutput<typeof fieldMetaSchema>;

export type TemplateManifest = {
  version: number;
  fields: FieldMeta[];
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const describedString = (description: string) =>
  v.pipe(v.string(), v.description(description));

const fieldPathSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.check(isFieldPath, "Invalid field path"),
    v.description(description),
  );

export const fieldPartSchema = v.strictObject({
  key: fieldPathSchema("Part key used in format"),
  label: v.optional(describedString("Part label")),
  inputType: v.pipe(
    v.picklist(["text", "select"]),
    v.description("Part input control"),
  ),
  options: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description("Allowed values for a select part"),
    ),
  ),
  pattern: v.optional(describedString("Regex for the whole part value")),
});

export const fieldLookupFormatSchema = v.strictObject({
  key: v.pipe(
    v.string(),
    v.check(isLookupFormatKey, "Invalid lookup format key"),
    v.description("Format key, addressed as {{path.key}}"),
  ),
  template: v.pipe(
    v.string(),
    v.maxLength(LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH),
    v.description("[token] rendering of the registry hit"),
  ),
});

export const fieldLookupSchema = v.pipe(
  v.strictObject({
    registry: v.pipe(
      v.picklist(LOOKUP_REGISTRIES),
      v.description("Business registry to query"),
    ),
    formats: v.pipe(
      v.array(fieldLookupFormatSchema),
      v.minLength(1),
      v.maxLength(LOOKUP_FORMATS_MAX),
      v.description("Named renderings; the first is the default"),
    ),
  }),
  v.description("Who fills = business-registry lookup"),
);

export const fieldDateFormatSchema = v.pipe(
  v.strictObject({
    locale: v.pipe(
      v.string(),
      v.check(isPlausibleLocale, "Invalid BCP-47 locale"),
      v.description("BCP-47 language tag"),
    ),
    style: v.pipe(
      v.picklist(DATE_FORMAT_STYLES),
      v.description("Date rendering style"),
    ),
  }),
  v.description("Date rendering config"),
);

/** Shared with the snake_case MCP mirror in `mcp/template-field-input.ts`, so
 *  both surfaces advertise the same line. */
export const FIELD_VALIDATION_DESCRIPTION = "Field-level value constraints";
export const FIELD_PARTS_DESCRIPTION = "Composite field parts";

export const fieldValidationObjectSchema = v.strictObject({
  required: v.optional(v.pipe(v.boolean(), v.description("Value is required"))),
  minLength: v.optional(
    v.pipe(v.number(), v.finite(), v.description("Minimum string length")),
  ),
  maxLength: v.optional(
    v.pipe(v.number(), v.finite(), v.description("Maximum string length")),
  ),
  min: v.optional(
    v.pipe(v.number(), v.finite(), v.description("Minimum numeric value")),
  ),
  max: v.optional(
    v.pipe(v.number(), v.finite(), v.description("Maximum numeric value")),
  ),
  pattern: v.optional(describedString("Regex for the whole value")),
  minItems: v.optional(
    v.pipe(v.number(), v.finite(), v.description("Minimum repeated items")),
  ),
  maxItems: v.optional(
    v.pipe(v.number(), v.finite(), v.description("Maximum repeated items")),
  ),
});

export const fieldValidationSchema = v.pipe(
  fieldValidationObjectSchema,
  v.description(FIELD_VALIDATION_DESCRIPTION),
);

/** Property names per derived-source mode, per surface. The persisted model is
 *  camelCase and the MCP tool input is snake_case, so a conflict message must
 *  quote the spelling the caller actually sent. Total over the mode union: a
 *  new derived source is a compile error here until both spellings exist. */
export const DERIVED_SOURCE_PROPERTIES = {
  "ai-adapt": { camel: "aiAdapt", snake: "ai_adapt" },
  "ai-prompt": { camel: "aiPrompt", snake: "ai_prompt" },
  condition: { camel: "condition", snake: "condition" },
  formula: { camel: "formula", snake: "formula" },
  lookup: { camel: "lookup", snake: "lookup" },
  parts: { camel: "parts", snake: "parts" },
  source: { camel: "source", snake: "source" },
} as const satisfies Record<
  DerivedSourceMode,
  { camel: string; snake: string }
>;

type DerivedSourceMode =
  | "ai-adapt"
  | "ai-prompt"
  | "condition"
  | "formula"
  | "lookup"
  | "parts"
  | "source";

/** `lookup`, `parts` and `source` are only presence-checked, so the parts shape
 *  stays open: the snake_case MCP mirror passes its own part objects. */
type DerivedSourceFields = {
  aiAdapt?: boolean | undefined;
  aiPrompt?: string | undefined;
  condition?: string | undefined;
  conditionAst?: ConditionNode | undefined;
  formula?: string | undefined;
  lookup?: FieldLookup | undefined;
  parts?: readonly unknown[] | undefined;
  source?: FieldSource | undefined;
};

const activeDerivedSourceModes = ({
  aiAdapt,
  aiPrompt,
  condition,
  conditionAst,
  formula,
  lookup,
  parts,
  source,
}: DerivedSourceFields): DerivedSourceMode[] => {
  const modes: DerivedSourceMode[] = [];
  if (aiAdapt === true) {
    modes.push("ai-adapt");
  }
  if (aiPrompt !== undefined) {
    modes.push("ai-prompt");
  }
  if (condition !== undefined || conditionAst !== undefined) {
    modes.push("condition");
  }
  if (formula !== undefined) {
    modes.push("formula");
  }
  if (lookup !== undefined) {
    modes.push("lookup");
  }
  if (parts !== undefined) {
    modes.push("parts");
  }
  if (source !== undefined) {
    modes.push("source");
  }
  return modes;
};

export const hasCompatibleDerivedSources = (
  fields: DerivedSourceFields,
): boolean => activeDerivedSourceModes(fields).length <= 1;

/**
 * The rejection message for a field that names more than one derived source.
 * "Mutually exclusive" alone leaves the caller to guess which of the seven
 * properties collided and on which entry, so both are named here.
 */
export const describeDerivedSourceConflict = (
  fields: DerivedSourceFields & { path?: string | undefined },
  spelling: "camel" | "snake",
): string => {
  const properties = activeDerivedSourceModes(fields).map(
    (mode) => `\`${DERIVED_SOURCE_PROPERTIES[mode][spelling]}\``,
  );
  const at = fields.path === undefined ? "" : ` on "${fields.path}"`;
  return (
    "Derived field sources are mutually exclusive: " +
    `${properties.join(", ")} are set together${at}. Keep exactly one.`
  );
};

const FIELD_SOURCE_DESCRIPTION = "Who fills = matter or contact data";

/**
 * Every description below is advertised in `save_template`'s `inputSchema`,
 * which each MCP client downloads on connect, so they stay one short line that
 * names the property's role. The per-property guidance (examples, who fills a
 * field, the binding kinds and their keys) lives in the `template-fields`
 * reference resource — see `mcp/template-field-reference.ts`.
 */
const fieldMetaObjectSchema = v.strictObject({
  path: fieldPathSchema("Field path; must match a {{marker}}"),
  label: v.optional(describedString("Field label")),
  hint: v.optional(describedString("Fill hint for the person filling")),
  inputType: v.optional(
    v.pipe(v.picklist(INPUT_TYPES), v.description("Input control type")),
  ),
  options: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description("Allowed values for a select field"),
    ),
  ),
  validation: v.optional(fieldValidationSchema),
  required: v.optional(v.pipe(v.boolean(), v.description("Value is required"))),
  aiPrompt: v.optional(describedString("Who fills = AI: drafting instruction")),
  aiAdapt: v.optional(
    v.pipe(v.boolean(), v.description("Who fills = person + AI")),
  ),
  aiSeesDocument: v.optional(
    v.pipe(v.boolean(), v.description("AI field also sees the document")),
  ),
  parts: v.optional(
    v.pipe(
      v.array(fieldPartSchema),
      v.minLength(1),
      v.description(FIELD_PARTS_DESCRIPTION),
    ),
  ),
  format: v.optional(describedString("Join template over the part keys")),
  optionsFrom: v.optional(
    fieldPathSchema("Dependent select: source field path"),
  ),
  lookup: v.optional(fieldLookupSchema),
  source: v.optional(
    v.pipe(fieldSourceSchema, v.description(FIELD_SOURCE_DESCRIPTION)),
  ),
  formula: v.optional(describedString("Arithmetic over other fields")),
  condition: v.optional(describedString("Boolean rule for an {{#if}} marker")),
  conditionAst: v.optional(
    v.pipe(
      conditionNodeSchema,
      v.description("Canonical condition AST for manifest round-tripping"),
    ),
  ),
  dateFormat: v.optional(fieldDateFormatSchema),
});

export const hasCompleteCompositeField = ({
  format,
  parts,
}: {
  format?: string | undefined;
  parts?: readonly unknown[] | undefined;
}): boolean => (parts === undefined) === (format === undefined);

const fieldMetaSchema = v.pipe(
  fieldMetaObjectSchema,
  v.check(
    (field: v.InferOutput<typeof fieldMetaObjectSchema>) =>
      hasCompleteCompositeField(field),
    "parts and format must be provided together",
  ),
  v.check(
    (field: v.InferOutput<typeof fieldMetaObjectSchema>) =>
      hasCompatibleDerivedSources(field),
    (issue) => describeDerivedSourceConflict(issue.input, "camel"),
  ),
);

/** Model-facing subset: conditionAst is the persisted canonical form, not an
 * authoring input. This schema derives its public fields from the persisted
 * object schema and applies the same named invariant predicates. */
export const fieldMetaToolInputObjectSchema = v.strictObject({
  ...v.omit(fieldMetaObjectSchema, ["conditionAst"]).entries,
  source: v.optional(
    v.pipe(fieldSourceToolInputSchema, v.description(FIELD_SOURCE_DESCRIPTION)),
  ),
});

export const fieldMetaToolInputSchema = v.pipe(
  fieldMetaToolInputObjectSchema,
  v.check(
    (field: v.InferOutput<typeof fieldMetaToolInputObjectSchema>) =>
      hasCompleteCompositeField(field),
    "parts and format must be provided together",
  ),
  v.check(
    (field: v.InferOutput<typeof fieldMetaToolInputObjectSchema>) =>
      hasCompatibleDerivedSources(field),
    (issue) => describeDerivedSourceConflict(issue.input, "camel"),
  ),
);

export const isFieldPart = (value: unknown): value is FieldPart =>
  v.is(fieldPartSchema, value);

export const isFieldDateFormat = (value: unknown): value is FieldDateFormat =>
  v.is(fieldDateFormatSchema, value);

export const isFieldLookup = (value: unknown): value is FieldLookup =>
  v.is(fieldLookupSchema, value);

export const isFieldMeta = (value: unknown): value is FieldMeta =>
  v.is(fieldMetaSchema, value);

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
  value["fields"].every(isFieldMeta);

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
  /** Mirrors {@link FieldMeta.aiPrompt}: AI-drafted fields render no
   *  fill-form input (the model writes them at fill time). */
  aiPrompt?: string | undefined;
  /** Mirrors {@link FieldMeta.aiSeesDocument}: opts an AI-drafted field into
   *  receiving the document text in its generator prompt. */
  aiSeesDocument?: boolean | undefined;
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
  /** Mirrors {@link FieldMeta.source}: the value is resolved from a contact
   *  record at fill time, so the fill form renders no input for the field. */
  source?: FieldSource | undefined;
  /** Mirrors {@link FieldMeta.formula}: the value is derived at fill time, so
   *  the fill form renders no input for the field. */
  formula?: string | undefined;
  /** Mirrors {@link FieldMeta.condition}: a boolean derived by rule at fill
   *  time, so the fill form renders no input (computed/derived); a plain
   *  boolean field without a condition is asked as a yes/no question instead. */
  condition?: string | undefined;
  /** Mirrors {@link FieldMeta.conditionAst}: the AST-backed form for boolean
   *  condition rules that cannot be represented by the string grammar. */
  conditionAst?: ConditionNode | undefined;
  /** Mirrors {@link FieldMeta.dateFormat}: the fill form can preview how the
   *  entered date will render in the document's language. */
  dateFormat?: FieldDateFormat | undefined;
  itemFields?: ResolvedField[] | undefined;
  /** Condition expression that must be true for this
   *  field to be visible in the fill form. */
  visibleWhen?: string | undefined;
};
