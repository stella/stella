import { type DirectiveKind, DIRECTIVE_KINDS } from "@stll/template-conditions";

/**
 * Human-readable grammar reference for the `{{...}}` markers a DOCX template
 * uses. Single source of truth for the *set* of directives is
 * {@link DIRECTIVE_KINDS} in `@stll/template-conditions`: the
 * {@link DIRECTIVE_DESCRIPTIONS} record below is keyed by {@link DirectiveKind},
 * so adding or removing a directive in `markers.ts` is a compile error here
 * until the prose is updated.
 *
 * The wording is hand-written (the regex literals in `markers.ts` are not
 * user-facing), but the inventory it documents is derived, never duplicated.
 */

/**
 * Canonical URI of the marker-grammar resource. Owned here with the text it
 * addresses, so the resource registry and the tool descriptions that point
 * agents at it cannot drift apart.
 */
export const TEMPLATE_MARKER_REFERENCE_URI =
  "stella://reference/template-markers";

type DirectiveDoc = {
  /** Short label shown as the bullet heading. */
  title: string;
  /** One-line explanation. */
  detail: string;
  /** A single minimal example marker. */
  example: string;
};

const DIRECTIVE_DESCRIPTIONS = {
  placeholder: {
    title: "Fillable value",
    detail:
      "Any dotted path is a fillable field. Use dotted segments to group " +
      "(`{{company.name}}`) and numeric segments — never brackets — to index " +
      "repeats (`{{attorneys.0.name}}`). Identical paths anywhere in the " +
      "document collapse to one field and one question.",
    example: "{{company.name}}",
  },
  if: {
    title: "Conditional block (open)",
    detail:
      "Include the enclosed paragraphs only when the condition holds. Block " +
      "markers must each occupy their own paragraph.",
    example: "{{#if is_company}} … {{/if}}",
  },
  elseif: {
    title: "Conditional block (alternate branch)",
    detail: "An additional branch inside an `{{#if}}` … `{{/if}}` block.",
    example: "{{#elseif is_individual}}",
  },
  else: {
    title: "Conditional block (fallback branch)",
    detail: "The fallback branch inside an `{{#if}}` … `{{/if}}` block.",
    example: "{{#else}}",
  },
  endif: {
    title: "Conditional block (close)",
    detail: "Closes the matching `{{#if}}` block.",
    example: "{{/if}}",
  },
  each: {
    title: "Repeating block (open)",
    detail:
      "Repeat the enclosed paragraphs once per item in a list. Reference an " +
      "item's fields with the list path as prefix (`{{attorneys.name}}`).",
    example: "{{#each attorneys}} {{attorneys.name}} {{/each}}",
  },
  endeach: {
    title: "Repeating block (close)",
    detail: "Closes the matching `{{#each}}` block.",
    example: "{{/each}}",
  },
  index: {
    title: "Loop position",
    detail:
      "The 1-based position of the current item within the innermost enclosing " +
      "`{{#each}}` loop.",
    example: "{{@index}}",
  },
  count: {
    title: "Loop size",
    detail:
      "The total number of items in the innermost enclosing `{{#each}}` loop.",
    example: "{{@count}}",
  },
  clause: {
    title: "Clause slot",
    detail:
      "Insert a managed clause by name. Append `:vN` to pin a version or " +
      "`:latest` to always take the newest; omit the suffix for the default.",
    example: "{{@clause:Confidentiality:v3}}",
  },
  num: {
    title: "Numbering anchor",
    detail:
      "Defines an auto-incrementing number under a key (sections, schedules, " +
      "…). Repeating the same key continues the same sequence.",
    example: "{{@num:section}}",
  },
  ref: {
    title: "Numbering cross-reference",
    detail:
      "Renders the number previously assigned to a `{{@num:Key}}` anchor with " +
      "the same key, so cross-references stay in sync.",
    example: "{{@ref:section}}",
  },
} as const satisfies Record<DirectiveKind, DirectiveDoc>;

const NON_DIRECTIVE_RULES = [
  {
    title: "Lookup output formats",
    detail:
      "When a field resolves from a registry/lookup, each named-format key " +
      "selects a rendering (`{{company.address}}`) and a bare path uses the " +
      "first format (`{{company}}`). Both address the same single lookup, so " +
      "dotted format markers do not make `company` a grouping path: it stays " +
      "the one field the person filling enters a registry number into.",
  },
  {
    title: "Block markers in a table",
    detail:
      "A block marker pair (`#if` or `#each` family) confined to ONE table row " +
      "acts on the whole row: the row repeats per item, or is dropped when no " +
      "branch wins. Opening and closing markers must not straddle a row " +
      "boundary.",
  },
  {
    title: "Markers Word splits into runs",
    detail:
      "Word often splits a marker across several runs (`w:r`) inside one " +
      "paragraph; discovery and fill join a paragraph's run text before " +
      "scanning, so a split marker still resolves. A marker must never span " +
      "two paragraphs or two table cells.",
  },
  {
    title: "Bilingual / multi-column documents",
    detail:
      "Mark every language or column occurrence of the same value with the " +
      "SAME path so it stays one field and one question. Do not invent " +
      "language-specific path variants.",
  },
  {
    title: "Markers vs. field configuration",
    detail:
      "Markers decide only WHICH values are fillable. How each field behaves " +
      "(input type, options, validation, who fills it) is a separate field " +
      "configuration, never inside the DOCX: pass it as save_template's " +
      "`fields` overlay, documented in the template-fields reference resource.",
  },
] as const;

const renderDirective = (kind: DirectiveKind): string => {
  const { title, detail, example } = DIRECTIVE_DESCRIPTIONS[kind];
  return `- ${title} (${kind}): ${detail}\n  Example: ${example}`;
};

const renderRule = (rule: { title: string; detail: string }): string =>
  `- ${rule.title}: ${rule.detail}`;

/**
 * Build the marker-grammar reference text. Directive bullets are emitted in the
 * canonical {@link DIRECTIVE_KINDS} order so the rendered output tracks the
 * source-of-truth inventory.
 */
export const buildMarkerReference = (): string => {
  const directiveLines = DIRECTIVE_KINDS.map(renderDirective).join("\n");
  const ruleLines = NON_DIRECTIVE_RULES.map(renderRule).join("\n");

  return [
    "stella template marker grammar (`{{...}}`)",
    "",
    "Write a normal DOCX and embed these markers as literal text. Inline " +
      "markers (fillable values, clause slots, numbering) sit within a " +
      "paragraph; block markers (#if / #each families) each occupy their own " +
      "paragraph.",
    "",
    "Marker kinds:",
    directiveLines,
    "",
    "Grammar rules:",
    ruleLines,
  ].join("\n");
};
