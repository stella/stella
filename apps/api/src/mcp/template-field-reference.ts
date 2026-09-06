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
  type BindingSourceKind,
  BINDING_SOURCE_KINDS,
  CONTACT_FIELDS,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "@/api/lib/template-binding/binding-sources";
import type { templateFieldInputSchema } from "@/api/mcp/template-field-input";
import { TEMPLATE_MARKER_REFERENCE_URI } from "@/api/mcp/template-marker-reference";

/**
 * Human-readable reference for `save_template`'s `fields` overlay. Every MCP
 * client pays a tool's advertised `inputSchema` on connect, so the
 * per-property guidance lives here — pulled on demand — while the schema
 * carries the structure plus one short line per property.
 *
 * Both inventories below are keyed by their source of truth
 * ({@link templateFieldInputSchema}'s own keys, {@link BindingSourceKind}), so
 * a new field property or binding kind is a compile error here until it is
 * documented. Value lists (input types, registries, contact fields) render
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

const FIELD_PROPERTY_DOCS = {
  path: "Must match a `{{marker}}` in the DOCX. Identical paths anywhere in the document are one field and one question.",
  label: "Question label shown to the person filling the field.",
  hint: "Short fill guidance shown with the input.",
  input_type: `Input control: ${INPUT_TYPES.join(", ")}. Defaults to text.`,
  options: "Allowed values for a select field.",
  options_from:
    "Dependent select: the path of another field whose entered values supply this field's options. Use instead of `options`.",
  validation:
    "Constraints checked at fill time: `required`, `min_length`/`max_length`, `min`/`max`, `pattern` (a regex matched against the complete value), `min_items`/`max_items` for repeated fields.",
  required: "Whether the fill form rejects an empty value.",
  ai_prompt:
    "Who fills = AI. The instruction the model follows to draft the value at fill time; the fill form shows no input for the field.",
  ai_adapt:
    "Who fills = person + AI. The entered value is a stub the model rewrites for each occurrence in the document.",
  ai_sees_document:
    "Include the rendered document in this AI field's prompt. It costs tokens per fill, so set it only when the value depends on the surrounding text.",
  parts:
    "Composite field: one entry per sub-input (`key`, `label`, `input_type` text or select, `options`, `pattern`). Set `format` alongside it.",
  format:
    "Join template over the composite part keys, for example `{{title}} {{name}}`. Required with `parts`, meaningless without.",
  lookup: `Who fills = business-registry lookup. \`registry\` is one of: ${LOOKUP_REGISTRIES.join(", ")}. The person filling enters only the registry number; the company is resolved at fill time and rendered through \`formats\`.`,
  source:
    "Who fills = matter or contact data resolved server-side at fill time (see the binding kinds below). The fill form shows no input for the field.",
  formula:
    "Who fills = arithmetic derived from other fields, for example `base_rent * 12`.",
  condition:
    "Boolean rule expression for a field referenced by a `{{#if field_path}}` marker. A boolean field without a condition is asked as a yes/no question instead.",
  date_format: `Locale-aware rendering for a date field: \`locale\` is a BCP-47 tag (\`cs\`, \`de\`, \`pl\`), \`style\` is one of ${DATE_FORMAT_STYLES.join(", ")}.`,
} as const satisfies Record<FieldConfigProperty, string>;

type BindingSourceDoc = {
  /** Which record the binding resolves at fill time. */
  detail: string;
  /** The extra selector this kind requires beside `field`, if any. */
  selector: { property: string; values: readonly string[] } | null;
  /** Allowed `field` keys for this kind. */
  fields: readonly string[];
};

const BINDING_SOURCE_DOCS = {
  contact: {
    detail: "The matter's client contact.",
    selector: null,
    fields: CONTACT_FIELDS,
  },
  party: {
    detail: "Another contact on the matter, picked by its role.",
    selector: { property: "role", values: WORKSPACE_CONTACT_ROLES },
    fields: CONTACT_FIELDS,
  },
  matter: {
    detail: "The matter itself.",
    selector: null,
    fields: MATTER_FIELDS,
  },
  attorney: {
    detail: "A user on the matter, picked by their standing on it.",
    selector: { property: "ref", values: ATTORNEY_REFS },
    fields: USER_FIELDS,
  },
  firm: {
    detail: "The organization running the workspace.",
    selector: null,
    fields: FIRM_FIELDS,
  },
} as const satisfies Record<BindingSourceKind, BindingSourceDoc>;

const renderBindingSource = (kind: BindingSourceKind): string => {
  const { detail, fields, selector } = BINDING_SOURCE_DOCS[kind];
  const selectorPart =
    selector === null
      ? ""
      : ` \`${selector.property}\`: ${selector.values.join(", ")}.`;
  return `- \`kind: "${kind}"\` — ${detail}${selectorPart} \`field\`: ${fields.join(", ")}.`;
};

/**
 * Build the field-configuration reference text. Property bullets follow the
 * declaration order of {@link FIELD_PROPERTY_DOCS}; binding kinds follow the
 * canonical {@link BINDING_SOURCE_KINDS} order.
 */
export const buildFieldReference = (): string => {
  const propertyLines = Object.entries(FIELD_PROPERTY_DOCS)
    .map(([property, detail]) => `- \`${property}\`: ${detail}`)
    .join("\n");
  const bindingLines = BINDING_SOURCE_KINDS.map(renderBindingSource).join("\n");

  return [
    "stella template field configuration (`save_template` `fields`)",
    "",
    "Markers decide WHICH values are fillable; a field configuration decides " +
      "how each one behaves. Configuration never lives in the DOCX. See " +
      `${TEMPLATE_MARKER_REFERENCE_URI} for the marker grammar.`,
    "",
    "The overlay is strict: every entry's `path` must match a marker in the " +
      "template, unknown properties are rejected, and the entries you pass " +
      "replace the configuration of the paths they name.",
    "",
    "Field properties:",
    propertyLines,
    "",
    "Who fills a field: a person, unless the field says otherwise. " +
      "`ai_prompt`, `ai_adapt`, `condition`, `formula`, `lookup`, `parts`, and " +
      "`source` are mutually exclusive — at most one per field.",
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
    "Contact and matter bindings (`source`):",
    bindingLines,
    "",
    "A binding resolves by key, never by display label, so renaming a label " +
      "never breaks a saved binding.",
  ].join("\n");
};
