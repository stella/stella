import { type DirectiveKind, DIRECTIVE_KINDS } from "@stll/template-conditions";

/**
 * Human-readable grammar reference for the `{{...}}` markers a DOCX template
 * uses. Single source of truth for the *set* of directives is
 * {@link DIRECTIVE_KINDS} in `@stll/template-conditions`: the
 * {@link DIRECTIVE_DESCRIPTIONS} record below is keyed by {@link DirectiveKind},
 * so adding or removing a directive in `markers.ts` is a compile error here
 * until the prose is updated. The companion test additionally asserts every
 * kind's token appears in the rendered text, so the reference can never drift
 * from the canonical grammar.
 *
 * The wording is hand-written (the regex literals in `markers.ts` are not
 * user-facing), but the inventory it documents is derived, never duplicated.
 */

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
      "When a field resolves from a registry/lookup, a bare path uses the " +
      "default format (`{{company}}`); a named-format key selects a specific " +
      "rendering (`{{company.address}}`).",
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
      "(input type, options, who fills it — a person, AI, or a lookup — and " +
      "date format) is configured AFTER creation in Template Studio or via the " +
      "REST manifest overlay, never inside the DOCX.",
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
