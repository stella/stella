import type * as v from "valibot";

import {
  DATE_FORMAT_STYLES,
  INPUT_TYPES,
  LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH,
  LOOKUP_FORMATS_MAX,
  LOOKUP_REGISTRIES,
} from "@/api/lib/docx/types";
import {
  ATTORNEY_REFS,
  CONTACT_FIELDS,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "@/api/lib/template-binding/binding-sources";
import type {
  templateFieldInputSchema,
  TemplateFieldSourceInput,
} from "@/api/mcp/template-field-input";
import { TEMPLATE_MARKER_REFERENCE_URI } from "@/api/mcp/template-marker-reference";

/**
 * Human-readable reference for `configure_template_fields`. Every MCP
 * client pays a tool's advertised `inputSchema` on connect, so the
 * per-property guidance lives here — pulled on demand — while the schema
 * carries the structure plus one short line per property.
 *
 * The same properties are writable in the document as marker filters, which is
 * where an author should put them; this tool is the way to set them without
 * rewriting the DOCX. The filter catalogue lives with the marker grammar.
 *
 * Both inventories below are keyed by their source of truth
 * ({@link templateFieldInputSchema}'s own keys, and the `source` union's own
 * branches), so a new field property or source branch is a compile error here
 * until it is documented. Value lists (input types, registries, contact fields) render
 * from the same constants the schema validates against, never a hand-copied
 * list.
 */

/**
 * Canonical URI of the field-configuration resource. Owned here with the text
 * it addresses, so the resource registry and the tool descriptions that point
 * agents at it cannot drift apart.
 */
export const TEMPLATE_FIELD_REFERENCE_URI =
  "stella://reference/template-fields";

type FieldConfigProperty = keyof v.InferInput<typeof templateFieldInputSchema>;

/** Every `source` branch the wire schema declares, derived from the union
 *  itself so the inventory below cannot miss one. */
type TemplateFieldSourceType = TemplateFieldSourceInput["type"];

const TEMPLATE_FIELD_SOURCE_TYPES = [
  "person",
  "ai",
  "lookup",
  "contact",
  "party",
  "matter",
  "attorney",
  "firm",
  "formula",
  "condition",
] as const satisfies readonly TemplateFieldSourceType[];

// Totality in the other direction: a branch the list above forgets is a
// compile error here, so the reference documents every one.
true satisfies Exclude<
  TemplateFieldSourceType,
  (typeof TEMPLATE_FIELD_SOURCE_TYPES)[number]
> extends never
  ? true
  : never;

const FIELD_PROPERTY_DOCS = {
  path: "Must match a `{{ marker }}` in the DOCX. Identical paths anywhere in the document are one field and one question.",
  label: "Question label shown to the person filling the field.",
  hint: "Short fill guidance shown with the input.",
  input_type: `Input control: ${INPUT_TYPES.join(", ")}. Defaults to text.`,
  options: "Allowed values for a select field.",
  options_from:
    "Dependent select: the path of another field whose entered values supply this field's options. Use instead of `options`.",
  validation:
    "Constraints checked at fill time: `required`, `min_length`/`max_length`, `min`/`max`, `pattern` (a regex matched against the complete value), `min_items`/`max_items` for repeated fields.",
  required: "Whether the fill form rejects an empty value.",
  source:
    "Who fills the field. ONE object with a `type`; the branches are listed below. Omit it for a field the person fills.",
  date_format: `Locale-aware rendering for a date field: \`locale\` is a BCP-47 tag (\`cs\`, \`de\`, \`pl\`), \`style\` is one of ${DATE_FORMAT_STYLES.join(", ")}.`,
} as const satisfies Record<FieldConfigProperty, string>;

/** One branch of the `source` union, keyed by its `type`. Total over the
 *  union the wire schema declares, so a new branch is a compile error here
 *  until it is documented. */
type SourceBranchDoc = {
  /** What fills the field under this branch. */
  detail: string;
  /** The branch's own properties beside `type`, already rendered. */
  properties: readonly string[];
};

const SOURCE_BRANCH_DOCS = {
  person: {
    detail:
      "The person filling enters the value. This is the default; omit `source` entirely for it.",
    properties: [],
  },
  ai: {
    detail:
      "AI produces the value at fill time. Give `prompt` for a field AI drafts (the fill form shows no input), or `adapt: true` for a field the person fills with a stub AI rewrites per occurrence. Exactly one of the two.",
    properties: [
      "`prompt`: the drafting instruction",
      "`adapt`: rewrite the entered value per occurrence",
      "`sees_document`: include the rendered document in the prompt, which costs tokens per fill",
    ],
  },
  lookup: {
    detail:
      "A business registry resolves the value. The person filling enters only the registry number; the company is resolved at fill time and rendered through `formats`.",
    properties: [
      `\`registry\`: one of ${LOOKUP_REGISTRIES.join(", ")}`,
      "`formats`: named renderings of the resolved hit; omit for the company name alone",
    ],
  },
  contact: {
    detail: "The matter's client contact, resolved server-side at fill time.",
    properties: [`\`field\`: ${CONTACT_FIELDS.join(", ")}`],
  },
  party: {
    detail: "Another contact on the matter, picked by its role.",
    properties: [
      `\`role\`: ${WORKSPACE_CONTACT_ROLES.join(", ")}`,
      `\`field\`: ${CONTACT_FIELDS.join(", ")}`,
    ],
  },
  matter: {
    detail: "The matter itself.",
    properties: [`\`field\`: ${MATTER_FIELDS.join(", ")}`],
  },
  attorney: {
    detail: "A user on the matter, picked by their standing on it.",
    properties: [
      `\`ref\`: ${ATTORNEY_REFS.join(", ")}`,
      `\`field\`: ${USER_FIELDS.join(", ")}`,
    ],
  },
  firm: {
    detail: "The organization running the workspace.",
    properties: [`\`field\`: ${FIRM_FIELDS.join(", ")}`],
  },
  formula: {
    detail: "Arithmetic derived from other fields.",
    properties: ["`expression`: for example `base_rent * 12`"],
  },
  condition: {
    detail:
      "A boolean rule for a field a `{% if field_path %}` tag references. A boolean field WITHOUT a condition source is asked as a yes/no question instead.",
    properties: ["`expression`: for example `amount > 1000`"],
  },
} as const satisfies Record<TemplateFieldSourceType, SourceBranchDoc>;

const renderSourceBranch = (type: TemplateFieldSourceType): string => {
  const { detail, properties } = SOURCE_BRANCH_DOCS[type];
  const propertyPart =
    properties.length === 0 ? "" : ` ${properties.join("; ")}.`;
  return `- \`{ "type": "${type}" }\` — ${detail}${propertyPart}`;
};

/**
 * Build the field-configuration reference text. Property bullets follow the
 * declaration order of {@link FIELD_PROPERTY_DOCS}; source branches follow
 * {@link TEMPLATE_FIELD_SOURCE_TYPES}.
 */
export const buildFieldReference = (): string => {
  const propertyLines = Object.entries(FIELD_PROPERTY_DOCS)
    .map(([property, detail]) => `- \`${property}\`: ${detail}`)
    .join("\n");
  const sourceLines =
    TEMPLATE_FIELD_SOURCE_TYPES.map(renderSourceBranch).join("\n");

  return [
    "stella template field configuration (`configure_template_fields`)",
    "",
    "A marker's filter chain is the primary way to configure a field, and it " +
      "lives in the DOCX: " +
      '`{{ deposit | number | label("Kaution") | required }}`. See ' +
      `${TEMPLATE_MARKER_REFERENCE_URI} for the filters. This tool configures ` +
      "the same properties from outside the document, for a template whose " +
      "markers you are not rewriting; where both say something, this wins.",
    "",
    "Send one entry per field path. Every entry's `path` must match a marker " +
      "in the template, unknown properties are rejected, and an entry " +
      "replaces the configuration of the path it names. An entry that cannot " +
      "be applied is reported in `issues[]` on its own; the rest of the call " +
      "still applies.",
    "",
    "Field properties:",
    propertyLines,
    "",
    "Who fills a field is ONE property, `source`, with a `type` that picks " +
      "exactly one branch. There is nothing to combine and nothing to keep " +
      "consistent: a field has one source or none.",
    sourceLines,
    "",
    "Registry lookup formats: each `formats` entry renders the same resolved " +
      "hit through its own `[token]` template. Every entry is addressed by " +
      "`{{path.key}}` in the document; the first entry is additionally the " +
      "default a bare `{{path}}` marker renders. A template may therefore " +
      "carry only keyed markers, and `path` is then configured as the lookup " +
      "even though no `{{path}}` marker exists. At most " +
      `${LOOKUP_FORMATS_MAX} formats per field, each template at most ` +
      `${LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH} characters.`,
    "",
    "A contact, party, matter, attorney or firm source resolves by key, " +
      "never by display label, so renaming a label never breaks a saved " +
      "binding.",
  ].join("\n");
};
