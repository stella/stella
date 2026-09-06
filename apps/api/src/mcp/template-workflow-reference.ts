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
  saveTemplate: "save_template",
  listTemplates: "list_templates",
  setPracticeJurisdictions: "set_practice_jurisdictions",
  fillTemplate: "fill_template",
  saveFilledTemplate: "save_filled_template",
  sendFeedback: "send_feedback",
  uploadDocumentVersion: "upload_document_version",
} as const satisfies Record<string, McpToolName>;

export const TEMPLATE_WORKFLOW_TOOL_NAMES = Object.values(TOOL);

const {
  fillTemplate: FILL_TEMPLATE,
  listTemplates: LIST_TEMPLATES,
  saveFilledTemplate: SAVE_FILLED_TEMPLATE,
  saveTemplate: SAVE_TEMPLATE,
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
      `${TEMPLATE_MARKER_REFERENCE_URI} is the \`{{...}}\` marker grammar; ` +
      `${TEMPLATE_FIELD_REFERENCE_URI} is the field configuration. Read both ` +
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
      `${SAVE_TEMPLATE} with \`name\`, the DOCX, and no \`fields\`. Two ways ` +
      `to send it: \`file\`, a host file reference (the shape ` +
      `${UPLOAD_DOCUMENT_VERSION} takes), up to ${MAX_DOCX_MEGABYTES} MB; or ` +
      "`docx_base64`, base64 of the raw bytes, for a small document only " +
      `(at most ${MAX_INLINE_DOCX_BYTES} bytes decoded), because the whole ` +
      "call must fit one MCP request frame. Never strip parts out to fit " +
      "that; use `file`. Returns `templateId`, `name`, `fieldCount` and " +
      "`warnings[]` (`code`, `path`, `message`, `hint`): markers the save " +
      "accepted that will not do what you meant. Fix them in the DOCX and " +
      "create again before configuring. Discovery decides which paths exist, " +
      "so configure in a second call rather than guessing paths here.",
  },
  {
    title: "Read the discovered paths back",
    detail:
      `${LIST_TEMPLATES} with \`template_id\`. Returns \`fields[]\` (\`path\`, ` +
      "`label`, `inputType`, `required`, `hint`, `options`, `optionsFrom`, " +
      "`formats`, `aiPrompt`, `aiAdapt`, `parts`, `format`, `dateFormat`), " +
      "`arrays[]` (one entry per `{{#each}}` loop: its `path` plus the " +
      "`itemFieldPaths` it repeats), `conditions[]`, `computed[]` " +
      "(`name` + `expression`) and the same `warnings[]`. Compare " +
      "`fields[].path` against the markers " +
      "you wrote: a path you expected and do not see was not discovered. Fix " +
      "the document and create the template again before configuring — " +
      "configuration cannot add a field the DOCX does not contain.",
  },
  {
    title: "Configure the fields",
    detail:
      `${SAVE_TEMPLATE} with \`template_id\` and a \`fields\` overlay, and no ` +
      "`docx_base64` and no `name`. Every entry's `path` must be one " +
      `${LIST_TEMPLATES} reported; an undiscovered path is refused. The ` +
      "overlay decides who fills each field (person, AI, registry lookup, " +
      "matter or contact binding, formula) — see " +
      `${TEMPLATE_FIELD_REFERENCE_URI}. The response echoes the full ` +
      `configuration in the ${LIST_TEMPLATES} detail shape, \`warnings[]\` ` +
      "included: the overlay recomputes them, so a condition that removes " +
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
      "unless `allow_unused_values` is true. Show the preview to the user " +
      "before persisting.",
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
  "with live `{{markers}}` is what the user asked for; otherwise collect the " +
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
    title: "Item fields are prefixed by the loop path",
    detail:
      "Inside `{{#each X}}`, an item's field is `{{X.field}}`, not " +
      "`{{field}}`. The loop path plus its `itemFieldPaths` is what " +
      `${LIST_TEMPLATES} reports under \`arrays\`.`,
  },
  {
    title: "Block markers own their paragraph, or wrap a table row",
    detail:
      "Each `{{#if}}` / `{{#each}}` opener and closer sits alone in its own " +
      "paragraph, and a pair either shares a block-level parent or is " +
      "confined to a single table row (which repeats the row). Within one row " +
      "the pair may instead prefix a cell's text and suffix a LATER cell's " +
      "text — `{{#each deliverables}}{{deliverables.item}}` in one cell and " +
      "`{{deliverables.fee}}{{/each}}` in another act on the whole row; both " +
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
    "The order to call things in. A template is created from a DOCX first " +
      "and configured second, because configuration can only name paths the " +
      "DOCX already contains.",
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
