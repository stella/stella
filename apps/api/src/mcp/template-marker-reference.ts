import {
  DATE_FORMAT_STYLES,
  DIRECTIVE_KINDS,
  FILTER_NAMES,
  LOOP_PROPERTIES,
  type DirectiveKind,
  type FilterName,
} from "@stll/template-conditions";

import { INPUT_TYPES, LOOKUP_REGISTRIES } from "@/api/lib/docx/types";
import {
  ATTORNEY_REFS,
  CONTACT_FIELDS,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "@/api/lib/template-binding/binding-sources";

/**
 * Human-readable grammar reference for the docxtpl dialect of Jinja a DOCX
 * template is written in. Single source of truth for the *set* of directives is
 * {@link DIRECTIVE_KINDS}, and for the *set* of filters {@link FILTER_NAMES},
 * both in `@stll/template-conditions`: the records below are keyed by those
 * unions, so adding or removing either in `markers.ts` is a compile error here
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
      "(`{{ company.name }}`) and numeric segments — never brackets — to " +
      "index repeats (`{{ attorneys.0.name }}`). Identical paths anywhere in " +
      "the document collapse to one field and one question. A `| filter` " +
      "chain on the marker configures the field (see below).",
    example: "{{ company.name }}",
  },
  if: {
    title: "Conditional block (open)",
    detail:
      "Include the enclosed paragraphs only when the condition holds. A tag " +
      "sits alone in its paragraph; `{%p ... %}` says so explicitly and " +
      "`{%tr ... %}` says the table row is the unit.",
    example: "{% if is_company %} … {% endif %}",
  },
  elif: {
    title: "Conditional block (alternate branch)",
    detail: "An additional branch inside an `{% if %}` … `{% endif %}` block.",
    example: "{% elif is_individual %}",
  },
  else: {
    title: "Conditional block (fallback branch)",
    detail: "The fallback branch inside an `{% if %}` … `{% endif %}` block.",
    example: "{% else %}",
  },
  endif: {
    title: "Conditional block (close)",
    detail: "Closes the matching `{% if %}` block.",
    example: "{% endif %}",
  },
  for: {
    title: "Repeating block (open)",
    detail:
      "Repeat the enclosed paragraphs once per item in a list. The loop names " +
      "its item, and the body addresses fields through that name — not " +
      "through the list path.",
    example: "{% for attorney in attorneys %} {{ attorney.name }} {% endfor %}",
  },
  endfor: {
    title: "Repeating block (close)",
    detail: "Closes the matching `{% for %}` block.",
    example: "{% endfor %}",
  },
  loop: {
    title: "Loop counters",
    detail:
      "Facts about the current iteration of the innermost enclosing " +
      `\`{% for %}\`: ${LOOP_PROPERTIES.map((property) => `\`loop.${property}\``).join(", ")} ` +
      "(`index` is 1-based, `index0` is 0-based, `length` is the item count). " +
      "They read the same way inside an `{% if %}` condition.",
    example: "{{ loop.index }} of {{ loop.length }}",
  },
  clause: {
    title: "Clause slot",
    detail:
      "Insert a managed clause by name. A second argument pins a version " +
      '(`"v3"`) or always takes the newest (`"latest"`); omit it for the ' +
      "default.",
    example: '{{ clause("Confidentiality", "v3") }}',
  },
  num: {
    title: "Numbering anchor",
    detail:
      "Defines an auto-incrementing number under a key (sections, schedules, " +
      "…). Repeating the same key continues the same sequence.",
    example: '{{ num("section") }}',
  },
  ref: {
    title: "Numbering cross-reference",
    detail:
      'Renders the number previously assigned to a `num("key")` anchor with ' +
      "the same key, so cross-references stay in sync.",
    example: '{{ ref("section") }}',
  },
} as const satisfies Record<DirectiveKind, DirectiveDoc>;

type FilterDoc = {
  /** The filter as it is written, arguments included. */
  usage: string;
  /** What it decides about the field. */
  detail: string;
};

const FILTER_DESCRIPTIONS = {
  text: { usage: "text", detail: "A plain text input. This is the default." },
  number: { usage: "number", detail: "A numeric input." },
  checkbox: { usage: "checkbox", detail: "A yes/no input." },
  date: {
    usage: 'date("pl-long")',
    detail:
      "A date input, rendered in that BCP-47 locale and style. The styles " +
      `are ${DATE_FORMAT_STYLES.join(", ")}.`,
  },
  select: {
    usage: 'select("company", "person")',
    detail: "A choice between the listed values.",
  },
  options_from: {
    usage: 'options_from("company_type")',
    detail:
      "A dependent choice: another field's entered values supply the options.",
  },
  label: { usage: 'label("Deposit")', detail: "The question label." },
  hint: { usage: 'hint("Two months rent")', detail: "Fill guidance." },
  required: { usage: "required", detail: "The fill rejects an empty value." },
  pattern: {
    usage: 'pattern("^[0-9]{10}$")',
    detail: "A regular expression the complete value must match.",
  },
  min: { usage: "min(0)", detail: "Smallest accepted number." },
  max: { usage: "max(100)", detail: "Largest accepted number." },
  min_length: { usage: "min_length(2)", detail: "Shortest accepted text." },
  max_length: { usage: "max_length(200)", detail: "Longest accepted text." },
  min_items: {
    usage: "min_items(1)",
    detail: "Fewest rows a repeated field accepts.",
  },
  max_items: {
    usage: "max_items(10)",
    detail: "Most rows a repeated field accepts.",
  },
  ai: {
    usage: 'ai("Summarize the dispute", adapt=false, sees_document=false)',
    detail:
      "AI produces the value. Give the instruction for a field AI drafts, or " +
      "`adapt=true` for a field the person fills with a stub AI rewrites; " +
      "`sees_document=true` puts the rendered document in the prompt, which " +
      "costs tokens per fill.",
  },
  lookup: {
    usage: 'lookup("krs", full="[name], [street], [city]")',
    detail:
      "A business registry resolves the value: the person enters only the " +
      "registry number. Each named argument is one `[token]` rendering of the " +
      "same hit, addressed as `{{ path.key }}`; the first is what a bare " +
      `\`{{ path }}\` prints. The registries are ${LOOKUP_REGISTRIES.join(", ")}.`,
  },
  matter: {
    usage: 'matter("reference")',
    detail: `The matter itself: ${MATTER_FIELDS.join(", ")}.`,
  },
  contact: {
    usage: 'contact("email")',
    detail: `The matter's client contact: ${CONTACT_FIELDS.join(", ")}.`,
  },
  party: {
    usage: 'party("seller", "email")',
    detail:
      `Another contact on the matter, by role. Roles: ${WORKSPACE_CONTACT_ROLES.join(", ")}. ` +
      `Fields: ${CONTACT_FIELDS.join(", ")}.`,
  },
  attorney: {
    usage: 'attorney("lead", "name")',
    detail:
      `A user on the matter, by standing. Refs: ${ATTORNEY_REFS.join(", ")}. ` +
      `Fields: ${USER_FIELDS.join(", ")}.`,
  },
  firm: {
    usage: 'firm("name")',
    detail: `The organization running the matter: ${FIRM_FIELDS.join(", ")}.`,
  },
  formula: {
    usage: 'formula("base_rent * 12")',
    detail: "Arithmetic over other fields; nobody is asked for the value.",
  },
  condition: {
    usage: "condition(\"company_type == 'company'\")",
    detail:
      "A boolean rule for a path an `{% if %}` tag reads. A boolean field " +
      "WITHOUT it is asked as a yes/no question instead.",
  },
} as const satisfies Record<FilterName, FilterDoc>;

const NON_DIRECTIVE_RULES = [
  {
    title: "Conditions",
    detail:
      "An `{% if %}` / `{% elif %}` expression takes dotted paths, string, " +
      "number and boolean literals, `==`, `!=`, `<`, `<=`, `>`, `>=`, " +
      '`"value" in path` for membership, `path is defined` / ' +
      "`path is not defined` for presence, `not`, `and`, `or`, and " +
      "parentheses. `loop.*` reads the same as in a value marker.",
  },
  {
    title: "Loop items are addressed by the loop's own name",
    detail:
      "`{% for attorney in attorneys %}` binds `attorney`, so an item's field " +
      "is `{{ attorney.name }}`. Writing `{{ name }}` fills from a top-level " +
      "field instead, so every repeated row renders the same value. Nested " +
      "loops nest names, and an inner loop over an item's own list is " +
      "`{% for f in attorney.fields %}`.",
  },
  {
    title: "Filters configure the field, in the document",
    detail:
      "Chain filters on a value marker to say what the field is: " +
      '`{{ deposit | number | label("Kaution") | required | min(0) }}`. Put ' +
      "them on ONE occurrence of a path; repeating the identical chain is " +
      "fine, two occurrences that disagree are refused and name both " +
      `paragraphs. Without filters a field is a plain ${INPUT_TYPES.at(0) ?? "text"} input.`,
  },
  {
    title: "Block markers in a table",
    detail:
      "A tag pair (`{% if %}` or `{% for %}` family) confined to ONE table " +
      "row acts on the whole row: the row repeats per item, or is dropped " +
      "when no branch wins. Inside such a row the pair may either own its " +
      "paragraphs or hug the row's text — the opener directly in FRONT of one " +
      "cell's text and the closer directly BEHIND a later cell's text, which " +
      "keeps the row readable as a table. A repeating row: first cell " +
      "`{% for d in deliverables %}{{ d.item }}`, last cell " +
      "`{{ d.fee }}{% endfor %}`. A conditional row: first cell " +
      "`{% if penalty %}Late fee`, last cell `{{ penalty_amount }}{% endif %}`. " +
      "The two halves must sit in DIFFERENT cells of the same row; nothing " +
      "may precede the opener or follow the closer in those cells, a branch " +
      "(`{% elif %}`, `{% else %}`) must own its paragraph, one pair per row " +
      "only, and the pair must not straddle a row boundary.",
  },
  {
    title: "Markers Word splits into runs",
    detail:
      "Word often splits a marker across several runs (`w:r`) inside one " +
      "paragraph; discovery and fill join a paragraph's run text before " +
      "scanning, so a split marker still resolves. Word's typographic quotes " +
      "and non-breaking spaces inside a marker are normalised too. A marker " +
      "must never span two paragraphs or two table cells.",
  },
  {
    title: "Bilingual / multi-column documents",
    detail:
      "Mark every language or column occurrence of the same value with the " +
      "SAME path so it stays one field and one question. Do not invent " +
      "language-specific path variants.",
  },
  {
    title: "What the dialect does NOT run",
    detail:
      "`{% set %}`, `{% macro %}`, `{% include %}`, `{% extends %}`, " +
      "`{% raw %}` and `{% with %}` are not supported, and `{{ }}` prints a " +
      "value rather than evaluating one: no arithmetic, no method calls, no " +
      "Python literals, no filters outside the list above. Arithmetic belongs " +
      'in a `formula("…")` filter. The older `{{#if}}` / `{{#each}}` / ' +
      "`{{@clause:…}}` dialect is gone; a leftover marker in that shape is " +
      "reported with the exact Jinja that replaces it.",
  },
] as const;

const renderDirective = (kind: DirectiveKind): string => {
  const { title, detail, example } = DIRECTIVE_DESCRIPTIONS[kind];
  return `- ${title} (${kind}): ${detail}\n  Example: ${example}`;
};

const renderFilter = (name: FilterName): string => {
  const { detail, usage } = FILTER_DESCRIPTIONS[name];
  return `- \`${usage}\`: ${detail}`;
};

const renderRule = (rule: { title: string; detail: string }): string =>
  `- ${rule.title}: ${rule.detail}`;

/**
 * Build the marker-grammar reference text. Directive bullets are emitted in the
 * canonical {@link DIRECTIVE_KINDS} order, and filter bullets in
 * {@link FILTER_NAMES} order, so the rendered output tracks the source-of-truth
 * inventories.
 */
export const buildMarkerReference = (): string => {
  const directiveLines = DIRECTIVE_KINDS.map(renderDirective).join("\n");
  const filterLines = FILTER_NAMES.map(renderFilter).join("\n");
  const ruleLines = NON_DIRECTIVE_RULES.map(renderRule).join("\n");

  return [
    "stella template markers (the docxtpl dialect of Jinja)",
    "",
    "Write a normal DOCX and embed these markers as literal text. `{{ ... }}` " +
      "prints a value; `{% ... %}` opens or closes a block and sits alone in " +
      "its paragraph (`{%p ... %}` says so explicitly, `{%tr ... %}` makes the " +
      "table row the unit). Inside a table row a pair may instead wrap the " +
      "row's own text — see the table rule.",
    "",
    "Marker kinds:",
    directiveLines,
    "",
    "Field-configuration filters, chained on a value marker with `|`:",
    filterLines,
    "",
    "Grammar rules:",
    ruleLines,
  ].join("\n");
};
