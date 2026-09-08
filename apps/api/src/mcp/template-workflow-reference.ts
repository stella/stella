import type { McpToolName } from "@/api/lib/api-handlers";
import {
  MAX_DOCX_MEGABYTES,
  MAX_INLINE_DOCX_BYTES,
} from "@/api/mcp/template-docx-limits";
import { TEMPLATE_FIELD_REFERENCE_URI } from "@/api/mcp/template-field-reference";
import { TEMPLATE_MARKER_REFERENCE_URI } from "@/api/mcp/template-marker-reference";

/**
 * End-to-end procedure for driving stella's template machinery from the MCP
 * surface alone. The two grammar references say what a marker and a field
 * configuration are; neither says which tool to call in which order, that
 * create-then-configure is two steps, or that a fill can be previewed before
 * anything is persisted. An agent that has only the tool list has to discover
 * that order by trial, so it is written down here.
 *
 * Every tool this document names is typed as {@link McpToolName}, so a rename
 * or removal in the registry is a compile error here rather than prose that
 * quietly points at a tool that no longer exists.
 */

/**
 * Canonical URI of the workflow resource. Owned here with the text it
 * addresses, so the resource registry and the server instructions that point
 * agents at it cannot drift apart.
 */
export const TEMPLATE_WORKFLOW_REFERENCE_URI =
  "stella://reference/template-workflow";

/**
 * The tools the procedure below names. Typed against the registry union, and
 * asserted present in the rendered text by `resources.test.ts`, so neither
 * half can drift from the other.
 */
const TOOL = {
  createTemplate: "create_template",
  configureTemplateFields: "configure_template_fields",
  listTemplates: "list_templates",
  setPracticeJurisdictions: "set_practice_jurisdictions",
  fillTemplate: "fill_template",
  saveFilledTemplate: "save_filled_template",
  sendFeedback: "send_feedback",
  uploadDocumentVersion: "upload_document_version",
} as const satisfies Record<string, McpToolName>;

export const TEMPLATE_WORKFLOW_TOOL_NAMES = Object.values(TOOL);

const {
  configureTemplateFields: CONFIGURE_TEMPLATE_FIELDS,
  createTemplate: CREATE_TEMPLATE,
  fillTemplate: FILL_TEMPLATE,
  listTemplates: LIST_TEMPLATES,
  saveFilledTemplate: SAVE_FILLED_TEMPLATE,
  sendFeedback: SEND_FEEDBACK,
  setPracticeJurisdictions: SET_PRACTICE_JURISDICTIONS,
  uploadDocumentVersion: UPLOAD_DOCUMENT_VERSION,
} = TOOL;

type WorkflowStep = {
  /** Short label shown as the step heading. */
  title: string;
  /** What to call, with the inputs and response fields that matter. */
  detail: string;
};

const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  {
    title: "Read the grammar",
    detail:
      `${TEMPLATE_MARKER_REFERENCE_URI} is the marker grammar: the docxtpl ` +
      "dialect of Jinja, including the filters that configure a field in the " +
      `document. ${TEMPLATE_FIELD_REFERENCE_URI} is what each of those ` +
      "filters means, in the shape the configure tool writes them. Read both " +
      "before authoring or configuring anything.",
  },
  {
    title: "Author markers in the ORIGINAL document",
    detail:
      "Add markers as literal text to the .docx the user gave you and send " +
      "those bytes back verbatim. Never rebuild, re-render, or strip parts: " +
      "macros, ActiveX, OLE objects, embedded fonts, and tracked changes all " +
      "survive the save. The stored template and every document filled from " +
      "it are named and typed as .docx whatever the source file was called, " +
      "so a macro-enabled package keeps its parts but not its .docm name.",
  },
  {
    title: "Create the template",
    detail:
      `${CREATE_TEMPLATE} with \`name\` and the DOCX. Two ways to send it: ` +
      `\`file\`, a host file reference (the shape ` +
      `${UPLOAD_DOCUMENT_VERSION} takes), up to ${MAX_DOCX_MEGABYTES} MB; or ` +
      "`docx_base64`, base64 of the raw bytes, for a small document only " +
      `(at most ${MAX_INLINE_DOCX_BYTES} bytes decoded), because the whole ` +
      "call must fit one MCP request frame. Never strip parts out to fit " +
      "that; use `file`. Send one of the two: a call carrying both stores " +
      "the attached `file` and ignores the inline bytes, and says so in " +
      "`warnings[]`. Returns `templateId`, `fieldCount`, the discovered " +
      "`fields[]`, `arrays[]`, `conditions[]` and `computed[]`, and " +
      "`warnings[]` (`code`, `path`, `message`, `hint`): markers the create " +
      "accepted that will not do what you meant. Fix them in the DOCX and " +
      "send the corrected file back with this `template_id`, which publishes " +
      "a new version rather than a second template. It also returns " +
      "`configure`: the " +
      `exact ${CONFIGURE_TEMPLATE_FIELDS} call for this template, one entry ` +
      "per configurable path (loop item paths included) with the source each " +
      "field already has, read off the markers. Copy it and edit the entries " +
      "that should differ; do not spell the paths yourself.",
  },
  {
    title: "Read the discovered paths back",
    detail:
      `${CREATE_TEMPLATE} already returned this, and ${LIST_TEMPLATES} with ` +
      "`template_id` returns it again (`configure` included) for a template " +
      "you did not just " +
      "create. `fields[]` (`path`, " +
      "`label`, `input_type`, `required`, `hint`, `options`, `options_from`, " +
      "`date_format`, and `source`: who fills the field, " +
      "as one object with a `type`), " +
      "`arrays[]` (one entry per `{% for %}` loop: its `path` plus the " +
      "`itemFieldPaths` it repeats), `conditions[]`, `computed[]` " +
      "(each `path` + its `condition` or `formula`) and the same " +
      "`warnings[]`. Compare `fields[].path` against the markers you wrote: a " +
      "path you expected and do not see was not discovered. Fix the document " +
      `and send it back to ${CREATE_TEMPLATE} with this \`template_id\`: ` +
      "configuration cannot add a field the DOCX does not contain, because " +
      "the configuration is written into the marker itself.",
  },
  {
    title: "Configure the fields",
    detail:
      `${CONFIGURE_TEMPLATE_FIELDS} with \`template_id\` and \`fields\`. Every ` +
      `entry's \`path\` must be one ${CREATE_TEMPLATE} or ${LIST_TEMPLATES} ` +
      "reported. Each entry's `source` is " +
      "ONE object naming who fills that field (`person`, `ai`, `lookup`, " +
      "`contact`, `party`, `matter`, `attorney`, `firm`, `formula`, " +
      "`condition`); omit it for a field the person fills — see " +
      `${TEMPLATE_FIELD_REFERENCE_URI}. The response echoes the full ` +
      `configuration in the ${LIST_TEMPLATES} detail shape, plus ` +
      "`issues[]` (`path`, `index`, `message`, `hint`): one entry per " +
      "configuration that could NOT be applied. The call rewrites whatever " +
      "carries the field — its own markers, the `{% if %}` and `{% elif %}` " +
      "tags a `condition` source's expression replaces, or the keyed markers " +
      "that render a `lookup` source's hit — and publishes the document, so " +
      "a property you send " +
      "replaces what the marker said and one you leave out keeps it; naming " +
      "a `source` replaces the whole answer to who fills the field. The call " +
      "is best effort: an entry naming a path the document has nothing to " +
      "carry it with, a value " +
      "the marker grammar cannot spell (a `{` or `}` in a label), or a " +
      "property the schema refuses is reported on its own and the entries " +
      "beside it are still applied, so read `issues[]` and resend only the " +
      "entries it names. Only a template-level problem (not found, no " +
      "permission, an unreadable document) fails the whole call. `warnings[]` comes back too: the " +
      "change recomputes them, so a condition that removes " +
      "its own input or a lookup on a disabled registry shows up here. A " +
      "`lookup` " +
      "field resolves at fill time only for a registry the organization has " +
      'enabled; a disabled one fails the fill with "The <registry> registry ' +
      'is disabled for this organization." Registries are enabled by the ' +
      `organization's practice jurisdictions (${SET_PRACTICE_JURISDICTIONS}) ` +
      "or by an admin enabling that tool in stella's tool catalogue; the " +
      "per-registry override is not settable over MCP.",
  },
  {
    title: "Preview the fill",
    detail:
      `${FILL_TEMPLATE} with \`template_id\` and \`values\`, a path-to-value ` +
      'map (`{"tenant.name":"ACME"}`). An `arrays[]` path takes an array of ' +
      "objects, not flat dotted keys. No document is created, but the fill " +
      "is recorded: a fill row and an EXECUTE audit event are written before " +
      "the completion gate runs, so a preview that is then rejected as " +
      "incomplete still appears in the audit log. `output_mode` " +
      "defaults to `text`: `paragraphs` (the rendered paragraphs and table " +
      "cells), `charCount`, `truncated`, `completionStatus` (`complete` or " +
      "`partial`), `templateName`, `fileName`, `unmatchedPlaceholders`, " +
      '`unusedValues`, `structureErrors`. `output_mode: "docx"` returns the ' +
      "same fill with `text` and the base64 archive in `docxBase64` instead; " +
      "ask for it only when you keep the bytes. Unknown value keys fail " +
      "unless `allow_unused_values` is true. Write a date field's value as " +
      "ISO YYYY-MM-DD; the unambiguous alternatives are read too (1. 10. " +
      "2026, 1 October 2026, and a month name in the field's own locale), " +
      "while a spelling that reads two ways (01/02/2026) is refused with " +
      "both readings named. Show the preview to the user before persisting.",
  },
  {
    title: "Persist into a matter",
    detail:
      `${SAVE_FILLED_TEMPLATE} with \`action\` (\`create_document\`, ` +
      "optionally under `parent_id`, or `create_version` with `entity_id`), " +
      "`template_id`, `matter_id`, `values`, and an `idempotency_key` unique " +
      "to this save — reuse it only to recover the same timed-out request. " +
      "The fill happens server-side; no byte upload. Returns the entity and " +
      "version identifiers plus `unmatchedPlaceholders` and `unusedValues`.",
  },
];

const COMPLETION_GATE_NOTE =
  `Completion gate: both ${FILL_TEMPLATE} and ${SAVE_FILLED_TEMPLATE} take ` +
  "`completion_mode` (default `require_complete`) and run one gate. Under " +
  "the default, an unfilled placeholder or a failed AI draft is a " +
  "`validation_error` naming every offending path, and the persisting tool " +
  "refuses before anything is written. `allow_partial` lets the same fill " +
  `through instead: ${FILL_TEMPLATE} reports \`completionStatus: "partial"\` ` +
  `and ${SAVE_FILLED_TEMPLATE} writes the document with the shortfall in ` +
  "`unmatchedPlaceholders` and `aiFieldErrors`. Set it only when a document " +
  "with live markers is what the user asked for; otherwise collect the " +
  "missing values and retry. A missing required value is refused in either " +
  "mode, before the gate.";

const AUTHORING_RULES = [
  {
    title: "One path per value, in every language",
    detail:
      "Mark every language or column occurrence of the same value with the " +
      "SAME path. Identical paths collapse to one field and one question; " +
      "language-specific variants create duplicate questions.",
  },
  {
    title: "Item fields are addressed through the loop's own name",
    detail:
      "`{% for attorney in attorneys %}` binds `attorney`, so an item's " +
      "field is `{{ attorney.name }}`, not `{{ name }}`. The array path plus " +
      `its \`itemFieldPaths\` is what ${LIST_TEMPLATES} reports under ` +
      "`arrays`.",
  },
  {
    title: "Block tags own their paragraph, or wrap a table row",
    detail:
      "Each `{% if %}` / `{% for %}` opener and closer sits alone in its own " +
      "paragraph, and a pair either shares a block-level parent or is " +
      "confined to a single table row (which repeats the row). Within one row " +
      "the pair may instead prefix a cell's text and suffix a LATER cell's " +
      "text — `{% for d in deliverables %}{{ d.item }}` in one cell and " +
      "`{{ d.fee }}{% endfor %}` in another act on the whole row; both " +
      "halves must be in the same row and in different cells. A pair that " +
      "straddles a table boundary is refused either way, and how it is " +
      "refused depends on how it was written: a pair whose markers each own " +
      "their paragraph is reported as a structure error and its markers are " +
      "emptied, so the fill continues without expanding them, while a pair " +
      "sharing its paragraphs with text is reported as an unclosed and an " +
      "orphaned inline marker and both stay in the document as literal text.",
  },
] as const;

const renderStep = ({ detail, title }: WorkflowStep, index: number): string =>
  `${index + 1}. ${title}. ${detail}`;

const renderRule = (rule: { title: string; detail: string }): string =>
  `- ${rule.title}: ${rule.detail}`;

/** Build the template-workflow reference text. */
export const buildWorkflowReference = (): string => {
  const stepLines = WORKFLOW_STEPS.map(renderStep).join("\n");
  const ruleLines = AUTHORING_RULES.map(renderRule).join("\n");

  return [
    "stella template workflow (author, configure, fill, save)",
    "",
    "The order to call things in. The DOCX is the template: a field's " +
      "configuration lives in its marker's filter chain, so a template is " +
      "created from a document first and configured second, and configuring " +
      "it publishes a document with the new filters written in.",
    "",
    "Procedure:",
    stepLines,
    "",
    COMPLETION_GATE_NOTE,
    "",
    "Rules that are easy to get wrong:",
    ruleLines,
    "",
    "Errors: a failed tool returns one text content of " +
      '`{"error":{"code","message","hint"}}` with isError set. A validation ' +
      "failure adds `issues[]`, each with the offending input's dot-`path` " +
      "(`values.tenant.name`, `fields.0.path`) and a `message`. Read `hint`: " +
      "it states the next call.",
    "",
    `Something missing or wrong here? File it with ${SEND_FEEDBACK}.`,
  ].join("\n");
};
