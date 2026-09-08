/**
 * Template authoring eval: the authoring half of `template-fill.ts`. Can a
 * model turn a source document into a stella template through the production
 * contract — the right `{{markers}}` in the right paragraphs, then
 * `create_template` and `configure_template_fields` — and are the reference
 * resources clear enough that a lower-tier model gets there?
 *
 * The model sees exactly what an external MCP client sees: the marker-grammar
 * and field-configuration resources verbatim (`buildMarkerReference()`,
 * `buildFieldReference()`), both authoring tools with their production names,
 * descriptions and input schemas, the source document, and a short brief
 * naming the field paths to use. The tools are backed in memory by the same
 * code the services run: `create_template` decodes the bytes, validates them
 * with `validateDocxBuffer` and reads the field list with
 * `deriveManifestFromDocx`; `configure_template_fields` calls
 * `configureTemplateDocument`, which writes each entry into the marker that
 * carries it and derives the manifest back out of the rewritten document. The
 * DB and S3 are the only steps left out. The document IS the template, so a
 * configure call replaces the bytes the run holds and the manifest is never
 * anything but what those bytes say. The saved template is then filled with
 * fixed values through the real `fillTemplateDocx`, so the round trip is
 * scored on rendered bytes.
 *
 * `write_docx` is NOT a stella tool. It stands in for the DOCX writer an MCP
 * client runs locally: a language model cannot emit zip bytes, and making it
 * copy kilobytes of base64 would measure transcription, not authoring. It
 * returns a reference that expands to the file's real base64 at the
 * `create_template` boundary, so every production validation still runs on
 * real bytes.
 *
 * Scored per run:
 *
 *   steps         the four steps of the workflow, separately, so a report
 *                 says WHICH one the model could not get through:
 *                 authored (the right markers, no grammar trap, the source
 *                 wording kept), created (create_template accepted the
 *                 document), configured (every configuration ENTRY landed,
 *                 and the brief's configuration present), filled (the fill
 *                 round trip rendered cleanly)
 *   outcome       pass / partial / invalid-docx / no-call / error
 *   missing/extra discovered field paths against the set the brief names
 *   traps         named grammar mistakes, one column per code in
 *                 GRAMMAR_TRAP_CODES, which is where they are documented; a
 *                 second list here would only drift from it
 *   overlay       entry-level production validation issues: the entries a
 *                 best-effort configure refused, schema rejections, a `path`
 *                 matching no marker, and a value no marker can spell. These
 *                 fail `configured`.
 *   dropped       properties the tool site dropped out of entries that
 *                 otherwise applied (a retired key such as `parts`). The
 *                 entry landed, so a drop is reported and fails no step.
 *   config        field configuration the brief asked for and did not get
 *   fidelity      source wording the template dropped instead of keeping
 *   round trip    leftover `{{`, blank repeated rows, a conditional row that
 *                 was not dropped, a date outside its requested locale, and
 *                 a fill the engine refused outright. These fail `filled`,
 *                 never `configured`: the entries had already landed.
 *   error         exact provider or stream error for the run, including the
 *                 turn deadline: a turn the timer aborts says so instead of
 *                 looking like a model that stopped calling tools
 *   tokens, ms
 *
 * Every call the advertised schema rejected before the handler ran is kept in
 * the run trace. A pass rate without the payload the model actually sent
 * cannot say whether the model or the contract failed.
 *
 * A valid `write_docx` result still earns marker, grammar and fidelity credit
 * when the turn ends before `create_template`; it remains a partial outcome
 * because configuration and the fill round trip never completed.
 *
 * The `syntax-quiz` task has no DOCX: the grammar questions answered as one
 * JSON object, scored exactly. Its wrong answers are reported in the
 * `missing` column, and it reaches none of the four workflow steps.
 *
 * Registry lookups and contact bindings are neutralized before the fill: the
 * eval has no matter and must not call a business registry, so those fields
 * are scored as configuration and their markers are then rewritten without the
 * binding, which leaves the fill substituting the task's fixed values.
 *
 * Usage (from apps/api):
 *   bun run eval:template-authoring
 *   bun run eval:template-authoring -- --models anthropic::claude-haiku-4-5-20251001
 *   bun run eval:template-authoring -- --task cs-nda --runs 3 --json out.json
 *   bun run eval:template-authoring -- --rescore out.json --json rescored.json
 *
 * `--rescore` replays a previous run's recorded tool calls — the authored
 * document, the create call, every configure call, in order — through the
 * save, configure and fill path a live run takes, with no model turn, and
 * prints the same tables. It is how a harness or engine change is measured
 * against runs already paid for; `--task` narrows it the same way it narrows
 * a live run.
 */
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";
import * as slimdom from "slimdom";
import * as v from "valibot";

import { filtersFromFieldConfig, formatDate } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { resolveCaching } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  streamChatChunks,
  toolCallEndInputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import { deriveManifestFromDocx } from "@/api/lib/docx/derived-manifest";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import {
  isElement,
  MAIN_DOCUMENT_PART_PATH,
  paragraphText,
  W_NS,
} from "@/api/lib/docx/ooxml";
import { mergeManifestWithDiscovery } from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import {
  fieldConfigurationIssuePath,
  type FieldConfigurationIssue,
} from "@/api/lib/templates/configure-field-input";
import { configureTemplateDocument } from "@/api/lib/templates/configure-template-document";
import {
  fillTemplateDocx,
  type FillTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { buildFieldReference } from "@/api/mcp/template-field-reference";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";
import {
  CONFIGURE_TEMPLATE_FIELDS_TOOL_DEFINITION,
  CREATE_TEMPLATE_TOOL_DEFINITION,
  parseConfigureEntries,
} from "@/api/mcp/template-tools";
import type { McpToolInputSchema } from "@/api/mcp/tool-types";
import type { NullAsAbsentInputSchema } from "@/api/mcp/tool-utils";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { runEvalModelTurn } from "./lib/model-turn";
import type {
  AuthoredBlock,
  AuthoringRunScore,
  AuthoringSteps,
  GrammarTrapCounts,
  RoundTripDefects,
  SaveAttempt,
} from "./lib/template-authoring-score";
import {
  AUTHORING_STEP_NAMES,
  checkSourceFidelity,
  cleanRoundTrip,
  comparePaths,
  detectGrammarTraps,
  GRAMMAR_TRAP_CODES,
  isEntryOverlayIssue,
  scoreAuthoringRun,
  scoreSyntaxQuiz,
} from "./lib/template-authoring-score";

// A bare id resolves through whichever configured provider rates it (GPT
// models may come from OpenAI or OpenRouter); Claude ids are pinned to
// Anthropic so a non-Anthropic default provider cannot claim them.
const DEFAULT_MODELS = [
  "anthropic::claude-haiku-4-5-20251001",
  "anthropic::claude-sonnet-5",
  "gpt-5.6-luna",
];
const DEFAULT_RUNS = 1;
// Every run is a paid request; keep a typo from turning into a bill.
const MAX_RUNS = 20;
// A whole document plus its field overlay and the following save call, with
// room for a reasoning model's thinking tokens, which share this budget.
const MAX_OUTPUT_TOKENS = 48_000;
const MAX_ITERATIONS = 10;
/**
 * The deadline for a WHOLE turn: the model's own thinking, every tool round
 * trip, and the agent loop's iterations share it. A three-step workflow needs
 * more of it than a single request does, and a turn that runs out is reported
 * as an error rather than as a model that stopped calling tools.
 */
const MODEL_TURN_TIMEOUT_MS = 600_000;

const CREATE_TEMPLATE_TOOL_NAME = "create_template";
const CONFIGURE_FIELDS_TOOL_NAME = "configure_template_fields";
const WRITE_DOCX_TOOL_NAME = "write_docx";
const ANSWER_SYNTAX_TOOL_NAME = "answer_syntax_questions";

const AUTHORING_SYSTEM_PROMPT = [
  "You are stella, a drafting assistant for lawyers. The user gives you a",
  "source document and asks for a reusable template. Work in three steps.",
  "First mark the fillable values with {{ markers }} and write the file with",
  `${WRITE_DOCX_TOOL_NAME}. Second call ${CREATE_TEMPLATE_TOOL_NAME} with a`,
  "name and, as docx_base64, the exact string write_docx returned; send no",
  "template_id. It answers with the field paths the document",
  `declares and the configure call to make next. Third call`,
  `${CONFIGURE_FIELDS_TOOL_NAME} with that template_id and one fields entry`,
  "per path — for anything the marker's own filters did not already say. Keep",
  "the document's wording exactly as given; only replace the values that",
  "become fields. The two reference resources below are the complete grammar",
  "and configuration contract; follow them literally.",
].join(" ");

// The quiz executes no authoring tool, so it must not be told to call them:
// a prompt naming unavailable tools would score prompt/tool mismatch rather
// than grammar comprehension.
const QUIZ_SYSTEM_PROMPT = [
  "You are stella, a drafting assistant for lawyers. Answer the user's",
  `questions about the template marker grammar by calling the one tool you`,
  "have. The two reference resources below are the complete grammar and",
  "configuration contract; answer from them literally.",
].join(" ");

const REFERENCE_RESOURCES = [
  "=== stella://reference/template-markers ===",
  buildMarkerReference(),
  "",
  "=== stella://reference/template-fields ===",
  buildFieldReference(),
].join("\n");

// ── Fixture building ─────────────────────────────────────

const WRAP = (paragraphs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.join("")}</w:body></w:document>`;

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const P = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

// A newline inside a cell starts a new paragraph, so a row-repeat can put its
// `{% for %}` opener in a paragraph of its own inside the first cell.
const TC = (text: string): string =>
  `<w:tc>${text.split("\n").map(P).join("")}</w:tc>`;

const TR = (...cells: readonly string[]): string =>
  `<w:tr>${cells.join("")}</w:tr>`;

const TBL = (...rows: readonly string[]): string =>
  `<w:tbl>${rows.join("")}</w:tbl>`;

const blockXml = (block: AuthoredBlock): string =>
  block.type === "paragraph"
    ? P(block.text)
    : TBL(...block.rows.map((row) => TR(...row.map(TC))));

// Mirrors `makeDocx` in `apps/api/src/lib/docx/docx-integration.test.ts`: the
// minimal OPC package discovery and the fill service need (document part,
// content types, package relationship).
const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  zip.file(
    "[Content_Types].xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      "</Types>",
    ].join(""),
  );
  zip.file(
    "_rels/.rels",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
      "</Relationships>",
    ].join(""),
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const buildDocx = async (blocks: readonly AuthoredBlock[]): Promise<Buffer> =>
  await makeDocx(WRAP(blocks.map(blockXml)));

/**
 * Read a DOCX back into blocks. Used twice: to derive the source text the
 * model reads from the fixture's real bytes (never from a parallel string
 * constant that could drift), and to inspect the filled output's rows.
 */
const readDocxBlocks = async (buffer: Buffer): Promise<AuthoredBlock[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file(MAIN_DOCUMENT_PART_PATH)?.async("string");
  if (xml === undefined) {
    return panic("DOCX has no word/document.xml");
  }
  const document = slimdom.parseXmlDocument(xml);
  const body = document.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return panic("DOCX has no w:body");
  }
  const blocks: AuthoredBlock[] = [];
  for (const child of body.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName === "p") {
      blocks.push({ type: "paragraph", text: paragraphText(child) });
      continue;
    }
    if (child.localName === "tbl") {
      const rows = [...child.getElementsByTagNameNS(W_NS, "tr")].map((row) =>
        [...row.getElementsByTagNameNS(W_NS, "tc")].map((cell) =>
          [...cell.getElementsByTagNameNS(W_NS, "p")]
            .map(paragraphText)
            .join("\n")
            .trim(),
        ),
      );
      blocks.push({ type: "table", rows });
    }
  }
  return blocks;
};

/** Every paragraph of a document, table cells included, in order. */
const authoredParagraphs = (blocks: readonly AuthoredBlock[]): string[] =>
  blocks.flatMap((block) =>
    block.type === "paragraph"
      ? [block.text]
      : block.rows.flatMap((row) => [...row]),
  );

/** The document as the model reads it: one line per paragraph, a table
 *  rendered as pipe-separated rows so its shape survives into the prompt. */
const renderBlocks = (blocks: readonly AuthoredBlock[]): string =>
  blocks
    .map((block) =>
      block.type === "paragraph"
        ? block.text
        : [
            "[table]",
            ...block.rows.map((row) => `| ${row.join(" | ")} |`),
            "[/table]",
          ].join("\n"),
    )
    .join("\n");

type FilledDocument = {
  /** Every paragraph, table cells included, joined by newlines. */
  text: string;
  /** Tables in document order, as rows of cell text. */
  tables: (readonly (readonly string[])[])[];
};

const readFilledDocument = async (buffer: Buffer): Promise<FilledDocument> => {
  const blocks = await readDocxBlocks(buffer);
  const lines: string[] = [];
  const tables: (readonly (readonly string[])[])[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      lines.push(block.text);
      continue;
    }
    tables.push(block.rows);
    for (const row of block.rows) {
      lines.push(row.join(" | "));
    }
  }
  return { text: lines.join("\n"), tables };
};

// ── The production template tool definitions ─────────────

/**
 * Inputs this harness cannot serve, hidden from the advertised schema the way
 * a real client hides them. `file` is a HOST file reference: the host fills
 * it in from its own transport, and this harness has none — `write_docx`
 * stands in for a writer running locally, so the document reaches the tool as
 * `docx_base64`. The chat surface hides the same property for the same reason
 * (`unavailableInputParams` in the registry's ref-field map).
 *
 * Advertising an input nothing can fill measures the model against a client
 * configuration that does not exist: two models filled `file` with a
 * fabricated reference beside a fabricated base64 string and were refused for
 * sending two document sources, every attempt, in every task.
 */
const UNSERVED_TOOL_INPUTS: Partial<Record<string, readonly string[]>> = {
  create_template: ["file"],
};

/** The advertised JSON Schema minus the properties this harness cannot fill.
 *  Validation still runs the production schema, which accepts their absence. */
const advertisedWithoutUnservedInputs = (
  name: string,
  inputSchema: McpToolInputSchema,
): McpToolInputSchema => {
  const hidden = UNSERVED_TOOL_INPUTS[name];
  if (hidden === undefined) {
    return inputSchema;
  }
  const properties = Object.fromEntries(
    Object.entries(inputSchema.properties ?? {}).filter(
      ([property]) => !hidden.includes(property),
    ),
  );
  return { ...inputSchema, properties };
};

/**
 * The tool schema the model sees: the exact wire schema every MCP client is
 * served for this tool (each definition declares the projection waiver its
 * `check` / `partial_check` actions need, so the projection is taken from
 * there rather than re-derived).
 *
 * Validation is deliberately NOT done here. Production parses the input inside
 * the tool site and hands the parsed value to the handler, which is best
 * effort for some calls — an overlay entry it cannot apply comes back in
 * `issues[]` while the entries beside it still apply. A transport that
 * pre-validated would turn such a call into a refusal the production server
 * never makes, and the handler would never run to record the attempt. One
 * validation, in the one place production does it.
 */
const productionToolSchema = (definition: {
  name: string;
  inputSchema: McpToolInputSchema;
  inputSchemaSource: NullAsAbsentInputSchema;
}) => {
  const schema = toTanStackToolSchema(definition.inputSchemaSource);
  const advertised = advertisedWithoutUnservedInputs(
    definition.name,
    definition.inputSchema,
  );
  const wireSchema = () => advertised;
  return {
    ...schema,
    "~standard": {
      ...schema["~standard"],
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: wireSchema, output: wireSchema },
    },
  };
};

// ── In-memory template store ─────────────────────────────

/**
 * `fillTemplateDocx` resolves organization registry credentials, so
 * every fill needs a working `scopedDb`, not a throwing stub.
 */
const buildStubScopedDb = (): ScopedDb => {
  const run = (fn: (tx: unknown) => unknown) =>
    fn({
      query: { businessRegistryCredentials: { findMany: () => [] } },
    });
  // SAFETY: the fill's registry dispatch only reads
  // `businessRegistryCredentials.findMany`; the fixture has no stored keys.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrows a stub to the real ScopedDb signature
  return run as unknown as ScopedDb;
};

type SaveOutcome =
  | { status: "invalid-docx"; reason: string }
  | { status: "rejected"; issues: string[] }
  | {
      status: "saved";
      buffer: Buffer;
      manifest: TemplateManifest;
      /** What the configuration could not apply, unformatted, as the engine
       *  and the tool site reported it: an entry that did not land, or one
       *  property dropped out of an entry that did. The rest were applied,
       *  so this is a defect list, not a rejection. */
      issues: readonly FieldConfigurationIssue[];
      /** Field paths after the document's own configuration is folded back
       *  into discovery: a lookup parent's named-format markers disappear here
       *  exactly as they do for a stored template. */
      resolvedPaths: string[];
      /** Every path a configuration may name, loop item paths included: what
       *  the production create response hands back as its `configure`
       *  skeleton. */
      configurablePaths: string[];
      structureErrors: string[];
    };

/** A call that produced a document: what the round trip fills and the score
 *  reads. A configure call always lands here, with the entries it could not
 *  apply in `issues`. */
type SavedTemplate = Extract<SaveOutcome, { status: "saved" }>;

type SaveCall = {
  /** Which step of the workflow the call was. */
  step: "create" | "configure";
  /** The saved document read back from its bytes, for trap detection. */
  blocks: readonly AuthoredBlock[];
  overlay: readonly FieldMeta[];
  outcome: SaveOutcome;
};

const validationIssues = (issues: readonly v.BaseIssue<unknown>[]): string[] =>
  issues.map(
    (issue) =>
      `${issue.path?.map((part) => String(part.key)).join(".") ?? "<root>"}: ${issue.message}`,
  );

/** Every path the configuration validator accepts: a marker of its own, a
 *  loop root, or a field of a loop's item. Mirrors what the production create
 *  response spells out as its configure skeleton. */
const configurableTemplatePaths = (
  discovered: Awaited<ReturnType<typeof discoverTemplate>>,
): string[] => {
  const paths: string[] = [];
  const visit = (
    field: { path: string; itemFields?: { path: string }[] | undefined },
    prefix: string,
  ): void => {
    const path = prefix === "" ? field.path : `${prefix}.${field.path}`;
    paths.push(path);
    for (const item of field.itemFields ?? []) {
      visit(item, path);
    }
  };
  for (const field of discovered.fields) {
    visit(field, "");
  }
  return paths;
};

/**
 * One saved document, described the way the run scores it. Everything but the
 * issue list is read back off the bytes, so nothing the eval reports can
 * disagree with the document it holds.
 */
const savedTemplate = async ({
  buffer,
  issues,
  manifest,
}: {
  buffer: Buffer;
  issues: readonly FieldConfigurationIssue[];
  manifest: TemplateManifest;
}): Promise<SavedTemplate> => {
  const discovered = await discoverTemplate(buffer);
  return {
    status: "saved",
    buffer,
    manifest,
    issues,
    resolvedPaths: mergeManifestWithDiscovery(manifest, discovered).map(
      (field) => field.path,
    ),
    configurablePaths: configurableTemplatePaths(discovered),
    structureErrors: discovered.structureErrors.map(
      (error) => `${error.directive}: ${error.message}`,
    ),
  };
};

/**
 * The DB-free half of `createStoredTemplate`: the base64 decode and
 * `validateDocxBuffer` in the same order and with the same rejections, then
 * the manifest the document's own markers declare. The DB insert, the S3
 * write and the per-org limit are the only steps left out.
 *
 * Creation configures nothing: whatever the markers say is what the new
 * template has, and `configure_template_fields` is how that changes.
 */
const createTemplateInMemory = async (
  docxBase64: string,
): Promise<SaveOutcome> => {
  const buffer = Buffer.from(docxBase64, "base64");
  if (buffer.byteLength === 0) {
    return {
      status: "invalid-docx",
      reason: "docx_base64 is not valid base64",
    };
  }
  const validation = await validateDocxBuffer(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  if (!validation.valid) {
    return { status: "invalid-docx", reason: validation.error };
  }
  return await savedTemplate({
    buffer,
    issues: [],
    manifest: await deriveManifestFromDocx(buffer),
  });
};

/**
 * The DB-free half of `configureTemplateFields`: the same
 * `configureTemplateDocument` call the service makes between its S3 read and
 * its republish, so the entries the eval counts as applied are the ones the
 * production server would have written.
 *
 * The bytes it returns replace the run's document. There is no second store to
 * refine: an entry that lands is an edit to a marker, and the next call reads
 * the document that edit produced.
 */
const configureTemplateInMemory = async ({
  buffer,
  entries,
}: {
  buffer: Buffer;
  entries: readonly FieldMeta[];
}): Promise<SavedTemplate> =>
  await savedTemplate(await configureTemplateDocument({ buffer, entries }));

// ── The round trip ───────────────────────────────────────

const withoutExternalSource = ({
  lookup: _lookup,
  source: _source,
  ...field
}: FieldMeta): FieldMeta => field;

/**
 * A registry lookup would call a business registry and a `source` binding
 * needs a matter; neither belongs in a deterministic eval. Both are scored as
 * configuration, then taken off the markers that declare them, so the fill
 * substitutes the fixed values the task supplies for those markers instead of
 * resolving anything.
 *
 * The document is the only place a binding lives, so this is a rewrite of the
 * document, and it is always a value marker's: a `{% for %}` opener carries
 * the repeat's own filters and nothing else, so an array root can never reach
 * here with a lookup or a binding on it.
 */
const neutralizeExternalSources = async (
  saved: SavedTemplate,
): Promise<Buffer> => {
  const { buffer } = await writeFieldFilters(
    saved.buffer,
    saved.manifest.fields.flatMap((field) =>
      field.lookup === undefined && field.source === undefined
        ? []
        : [
            {
              path: field.path,
              filters: filtersFromFieldConfig(withoutExternalSource(field)),
            },
          ],
    ),
  );
  return buffer;
};

type RoundTripResult = {
  defects: RoundTripDefects;
  text: string;
};

const runRoundTrip = async ({
  saved,
  task,
  organizationId,
}: {
  saved: SavedTemplate;
  task: EvalTask;
  organizationId: SafeId<"organization">;
}): Promise<RoundTripResult> => {
  const buffer = await neutralizeExternalSources(saved);
  const source: FillTemplateSource = {
    name: task.name,
    fileName: `${task.id}.docx`,
    buffer,
  };
  const filled = await fillTemplateDocx({
    source,
    // The engine formats in place (a loop row's date is written back into
    // the row object), so the shared task fixture must not reach it.
    values: structuredClone(task.fillValues),
    scopedDb: buildStubScopedDb(),
    organizationId,
    requiredFields: "allow-partial",
  });
  if ("usageRejection" in filled || "requiredFieldsRejection" in filled) {
    return panic("allow-partial fill returned a rejection");
  }
  if ("error" in filled) {
    // The fill never rendered, so there is nothing to inspect. It is the
    // round trip that failed: the entries the call carried had all landed.
    return {
      defects: { ...cleanRoundTrip(), fillError: filled.error },
      text: "",
    };
  }
  const document = await readFilledDocument(filled.buffer);
  const leftoverMarkers = [...document.text.matchAll(/\{\{/gu)].length;
  return {
    defects: {
      ...task.checkRoundTrip(document),
      leftoverMarkers,
      fillError: null,
    },
    text: document.text,
  };
};

// ── Tasks ─────────────────────────────────────────────────

/** A task inspects what rendered, so the defects only the fill itself can
 *  report are not its to return. */
type TaskRoundTripCheck = Omit<
  RoundTripDefects,
  "leftoverMarkers" | "fillError"
>;

type EvalTask = {
  id: string;
  name: string;
  /** The source document, before any marker. */
  source: readonly AuthoredBlock[];
  /** The request, naming the field paths the template must use. */
  brief: string;
  /** Field paths discovery must report once the overlay is folded in. */
  expectedPaths: readonly string[];
  /** Paths a person answers as a yes/no question: a `condition` on one of
   *  them is the tick-box confusion, not a rule. */
  booleanInputPaths: readonly string[];
  /** Source wording no marker replaces, so the template must keep it
   *  verbatim. Without this a bare skeleton of markers would score a pass. */
  preservedPhrases: readonly string[];
  /** Fixed values for the round trip, keyed by the paths the brief names. */
  fillValues: Record<string, unknown>;
  /** Configuration the brief asked for, checked on the saved manifest. */
  checkConfig: (fields: readonly FieldMeta[]) => string[];
  checkRoundTrip: (document: FilledDocument) => TaskRoundTripCheck;
};

const fieldAt = (
  fields: readonly FieldMeta[],
  path: string,
): FieldMeta | undefined => fields.find((field) => field.path === path);

const POA_SIGNING_DATE = "2026-03-12";
const POA_DATE_FORMAT = { locale: "pl", style: "long" } as const;
const POA_ATTORNEYS = [
  "Anna Zielińska",
  "Marek Dąbrowski",
  "Piotr Lewandowski",
];

const POA_SOURCE: AuthoredBlock[] = [
  { type: "paragraph", text: "PEŁNOMOCNICTWO / POWER OF ATTORNEY" },
  {
    type: "paragraph",
    text:
      "Wektor Logistyka sp. z o.o., z siedzibą przy ul. Prosta 51, 00-838 " +
      "Warszawa, wpisana do Krajowego Rejestru Sądowego pod numerem KRS " +
      "0000123456 (dalej „Mocodawca”),",
  },
  {
    type: "paragraph",
    text:
      "Wektor Logistyka sp. z o.o., with its registered office at ul. Prosta " +
      "51, 00-838 Warszawa, entered in the National Court Register under KRS " +
      "number 0000123456 (the “Principal”),",
  },
  {
    type: "paragraph",
    text:
      "niniejszym ustanawia pełnomocnikami: Anna Zielińska, Marek Dąbrowski, " +
      "Piotr Lewandowski.",
  },
  {
    type: "paragraph",
    text:
      "hereby appoints as its attorneys: Anna Zielińska, Marek Dąbrowski, " +
      "Piotr Lewandowski.",
  },
  {
    type: "paragraph",
    text:
      "Zakres pełnomocnictwa: reprezentowanie Mocodawcy przed sądami " +
      "powszechnymi i organami administracji.",
  },
  {
    type: "paragraph",
    text:
      "Scope of this power of attorney: representing the Principal before the " +
      "common courts and administrative authorities.",
  },
  { type: "paragraph", text: "Warszawa, dnia 12 marca 2026 r." },
  {
    type: "paragraph",
    text: "Tomasz Nowicki, Prezes Zarządu / President of the Management Board",
  },
];

const NDA_PENALTY_CLAUSE =
  "Za každé porušení povinnosti mlčenlivosti se sjednává smluvní pokuta ve " +
  "výši 100 000 Kč.";

const NDA_SOURCE: AuthoredBlock[] = [
  { type: "paragraph", text: "DOHODA O MLČENLIVOSTI" },
  {
    type: "paragraph",
    text:
      "Tato dohoda se uzavírá mezi společností Aurea Systems s.r.o. a " +
      "společností Bohemia Data a.s.",
  },
  { type: "paragraph", text: "Dohoda nabývá účinnosti dne 1. dubna 2026." },
  { type: "paragraph", text: NDA_PENALTY_CLAUSE },
  { type: "paragraph", text: "Tato dohoda se řídí právem České republiky." },
];

const SOW_DELIVERABLES = [
  { item: "Site survey", due_date: "2026-10-01", fee: "4 000" },
  { item: "Equipment install", due_date: "2026-10-15", fee: "12 500" },
  { item: "Final handover", due_date: "2026-11-01", fee: "3 200" },
];

const SOW_EXPENSES_ROW_TEXT = "Expenses reimbursed at cost";

const SOW_SOURCE: AuthoredBlock[] = [
  { type: "paragraph", text: "STATEMENT OF WORK" },
  {
    type: "paragraph",
    text: "Statement of Work for Riverside Logistics a.s.",
  },
  {
    type: "table",
    rows: [
      ["Deliverable", "Due date", "Fee (EUR)"],
      ...SOW_DELIVERABLES.map(({ item, due_date, fee }) => [
        item,
        due_date,
        fee,
      ]),
      [SOW_EXPENSES_ROW_TEXT, "on invoice", "at cost"],
    ],
  },
  { type: "paragraph", text: "Fees are invoiced monthly in arrears." },
];

const RENT_SOURCE: AuthoredBlock[] = [
  { type: "paragraph", text: "MIETVERTRAG" },
  { type: "paragraph", text: "Vermieterin: Ingrid Baumann" },
  { type: "paragraph", text: "Mieter: Lukas Vogt" },
  { type: "paragraph", text: "Mietobjekt: Hauptstraße 14, 80331 München" },
  { type: "paragraph", text: "Die monatliche Kaltmiete beträgt 1250 EUR." },
  { type: "paragraph", text: "Die Jahresmiete beträgt 15000 EUR." },
];

const NDA_LAW_OPTIONS = [
  "České republiky",
  "Slovenské republiky",
  "Anglie a Walesu",
];

const normalizeFormula = (formula: string): string =>
  formula.replaceAll(/\s+/gu, "").toLowerCase();

const digitsOf = (text: string): string => text.replaceAll(/\D/gu, "");

const TASKS: EvalTask[] = [
  {
    id: "pl-en-poa",
    name: "Pełnomocnictwo / Power of Attorney",
    source: POA_SOURCE,
    brief: [
      "Make this bilingual power of attorney a reusable template. The Polish",
      "and English paragraphs say the same things, so the same value must",
      "carry the same path in both.",
      "",
      "Fields:",
      "- the principal company (name, registered office, KRS number) is ONE",
      "  registry-lookup field at path `company` on registry `krs`: its",
      "  default format renders the company name, a named format `address`",
      "  renders the registered office, and a named format `krs` renders the",
      "  registry number.",
      "- the three attorneys are a repeat at path `attorneys`, each item's",
      "  name at `attorneys.name`.",
      "- the signing date is `signing_date`, a date field rendered in Polish",
      "  long form (locale `pl`, style `long`).",
      "- `signatory_name` and `signatory_role` are plain values.",
      "- the scope of the power of attorney is `scope`, drafted by AI at fill",
      "  time from an instruction you write.",
    ].join("\n"),
    expectedPaths: [
      "company",
      "attorneys",
      "signing_date",
      "signatory_name",
      "signatory_role",
      "scope",
    ],
    booleanInputPaths: [],
    preservedPhrases: [
      "PEŁNOMOCNICTWO / POWER OF ATTORNEY",
      "wpisana do Krajowego Rejestru Sądowego pod numerem KRS",
      "entered in the National Court Register under KRS number",
      "niniejszym ustanawia pełnomocnikami",
      "hereby appoints as its attorneys",
      "Zakres pełnomocnictwa",
      "Scope of this power of attorney",
      "Warszawa, dnia",
    ],
    fillValues: {
      company: "Wektor Logistyka sp. z o.o.",
      "company.address": "ul. Prosta 51, 00-838 Warszawa",
      "company.krs": "0000123456",
      attorneys: POA_ATTORNEYS.map((name) => ({ name })),
      signing_date: POA_SIGNING_DATE,
      signatory_name: "Tomasz Nowicki",
      signatory_role: "Prezes Zarządu",
      scope:
        "reprezentowanie Mocodawcy przed sądami powszechnymi i organami administracji",
    },
    checkConfig: (fields) => {
      const defects: string[] = [];
      const company = fieldAt(fields, "company");
      const lookup = company?.lookup;
      if (lookup === undefined) {
        defects.push("company has no lookup");
      } else {
        if (lookup.registry !== "krs") {
          defects.push(`company lookup registry ${lookup.registry}`);
        }
        const keys = new Set(lookup.formats.map((format) => format.key));
        for (const key of ["address", "krs"]) {
          if (!keys.has(key)) {
            defects.push(`company lookup has no "${key}" format`);
          }
        }
      }
      const signingDate = fieldAt(fields, "signing_date");
      if (signingDate?.inputType !== "date") {
        defects.push("signing_date is not a date field");
      }
      const dateFormat = signingDate?.dateFormat;
      if (dateFormat?.locale !== "pl" || dateFormat.style !== "long") {
        defects.push("signing_date date_format is not pl/long");
      }
      const scope = fieldAt(fields, "scope");
      if (scope?.aiPrompt === undefined || scope.aiPrompt.trim() === "") {
        defects.push("scope has no ai_prompt");
      }
      return defects;
    },
    checkRoundTrip: ({ text }) => {
      const expectedDate =
        formatDate(POA_SIGNING_DATE, POA_DATE_FORMAT) ??
        panic("the fixed signing date does not format");
      return {
        blankRepeatedRows: POA_ATTORNEYS.filter((name) => !text.includes(name))
          .length,
        conditionalRowKept: false,
        dateLocaleMismatch: !text.includes(expectedDate),
      };
    },
  },
  {
    id: "cs-nda",
    name: "Dohoda o mlčenlivosti",
    source: NDA_SOURCE,
    brief: [
      "Udělej z této dohody o mlčenlivosti šablonu.",
      "",
      "Pole:",
      "- `strana_a` a `strana_b` jsou obyčejné hodnoty.",
      "- `ucinnost_od` je datum.",
      `- \`rozhodne_pravo\` je výběr z možností: ${NDA_LAW_OPTIONS.map(
        (option) => `„${option}”`,
      ).join(", ")}.`,
      "- `smluvni_pokuta` je zaškrtávací pole ano/ne, které vyplňuje člověk.",
      "  Odstavec o smluvní pokutě se do dokumentu dostane jen tehdy, když je",
      "  zaškrtnuté.",
    ].join("\n"),
    expectedPaths: [
      "strana_a",
      "strana_b",
      "ucinnost_od",
      "rozhodne_pravo",
      "smluvni_pokuta",
    ],
    booleanInputPaths: ["smluvni_pokuta"],
    preservedPhrases: [
      "DOHODA O MLČENLIVOSTI",
      "Tato dohoda se uzavírá mezi společností",
      "Dohoda nabývá účinnosti dne",
      NDA_PENALTY_CLAUSE,
      "Tato dohoda se řídí právem",
    ],
    fillValues: {
      strana_a: "Aurea Systems s.r.o.",
      strana_b: "Bohemia Data a.s.",
      ucinnost_od: "2026-04-01",
      rozhodne_pravo: "České republiky",
      // Filled false on purpose: a penalty clause left outside an `{% if %}`
      // survives the fill, which is the only way to tell a real conditional
      // from an ordinary paragraph the model happened not to touch.
      smluvni_pokuta: false,
    },
    checkConfig: (fields) => {
      const defects: string[] = [];
      const law = fieldAt(fields, "rozhodne_pravo");
      if (law?.inputType !== "select") {
        defects.push("rozhodne_pravo is not a select");
      }
      const options = new Set(law?.options);
      for (const option of NDA_LAW_OPTIONS) {
        if (!options.has(option)) {
          defects.push(`rozhodne_pravo is missing option "${option}"`);
        }
      }
      const penalty = fieldAt(fields, "smluvni_pokuta");
      if (penalty?.inputType !== "boolean") {
        defects.push("smluvni_pokuta is not a boolean");
      }
      if (penalty?.condition !== undefined) {
        defects.push("smluvni_pokuta carries a condition");
      }
      if (fieldAt(fields, "ucinnost_od")?.inputType !== "date") {
        defects.push("ucinnost_od is not a date field");
      }
      return defects;
    },
    checkRoundTrip: ({ text }) => ({
      blankRepeatedRows: 0,
      // The flag is false, so an `{% if %}`-wrapped clause is gone; an
      // unconditional paragraph is still here.
      conditionalRowKept: digitsOf(text).includes("100000"),
      dateLocaleMismatch: false,
    }),
  },
  {
    id: "en-sow-table",
    name: "Statement of Work",
    source: SOW_SOURCE,
    brief: [
      "Make this statement of work a reusable template.",
      "",
      "Fields:",
      "- `client_name` is a plain value.",
      "- the deliverables are one table row per item: a repeat at path",
      "  `deliverables`, with the opening and closing markers inside that one",
      "  row, and the item values at `deliverables.item`,",
      "  `deliverables.due_date` and `deliverables.fee`.",
      "- the expenses row is conditional on `expenses_reimbursed`, a yes/no",
      "  field a person answers: the whole row disappears when it is false.",
      "  Its opening and closing markers stay inside that one row.",
    ].join("\n"),
    expectedPaths: ["client_name", "deliverables", "expenses_reimbursed"],
    booleanInputPaths: ["expenses_reimbursed"],
    preservedPhrases: [
      "STATEMENT OF WORK",
      "Statement of Work for",
      "Deliverable",
      "Due date",
      "Fee (EUR)",
      "Fees are invoiced monthly in arrears.",
    ],
    fillValues: {
      client_name: "Riverside Logistics a.s.",
      deliverables: SOW_DELIVERABLES,
      expenses_reimbursed: false,
    },
    checkConfig: (fields) => {
      const defects: string[] = [];
      const flag = fieldAt(fields, "expenses_reimbursed");
      if (flag?.inputType !== "boolean") {
        defects.push("expenses_reimbursed is not a boolean");
      }
      if (flag?.condition !== undefined) {
        defects.push("expenses_reimbursed carries a condition");
      }
      return defects;
    },
    checkRoundTrip: ({ tables }) => {
      const rows = tables.at(0) ?? [];
      const isDeliverableRow = (row: readonly string[]): boolean =>
        SOW_DELIVERABLES.some((deliverable) =>
          (row.at(0) ?? "").includes(deliverable.item),
        );
      // Exactly one row per deliverable, with every cell filled. Matching a
      // single row would pass a table that kept the literal source rows
      // alongside the repeated ones, or expanded the repeat twice.
      const blankRepeatedRows = SOW_DELIVERABLES.filter((deliverable) => {
        const matches = rows.filter((candidate) =>
          (candidate.at(0) ?? "").includes(deliverable.item),
        );
        const row = matches.at(0);
        return (
          matches.length !== 1 ||
          row === undefined ||
          row.slice(0, 3).some((cell) => cell.trim() === "")
        );
      }).length;
      // The flag is false, so nothing but the header and the three
      // deliverables may remain. A row emptied of its text but left in the
      // table counts as kept: today's engine strips the paragraphs of a
      // row-mode `{% if %}` without removing the row.
      return {
        blankRepeatedRows,
        conditionalRowKept: rows.slice(1).some((row) => !isDeliverableRow(row)),
        dateLocaleMismatch: false,
      };
    },
  },
  {
    id: "de-rent",
    name: "Mietvertrag",
    source: RENT_SOURCE,
    brief: [
      "Mach aus diesem Mietvertrag eine wiederverwendbare Vorlage.",
      "",
      "Felder:",
      "- `landlord_name` kommt aus dem Mandantenkontakt (Anzeigename), nicht",
      "  aus einer Eingabe.",
      "- `tenant_name` ist ein einfacher Wert.",
      "- Die Anschrift des Mietobjekts steht als drei Felder im Dokument:",
      "  `property_address.street`, `property_address.postal_code` und",
      "  `property_address.city`. Die Interpunktion dazwischen schreibst du",
      "  als Dokumenttext.",
      "- `base_rent` ist eine Zahl (die monatliche Kaltmiete).",
      "- `annual_rent` wird aus `base_rent` berechnet: `base_rent * 12`.",
    ].join("\n"),
    expectedPaths: [
      "landlord_name",
      "tenant_name",
      "property_address.street",
      "property_address.postal_code",
      "property_address.city",
      "base_rent",
      "annual_rent",
    ],
    booleanInputPaths: [],
    preservedPhrases: [
      "MIETVERTRAG",
      "Vermieterin:",
      "Mieter:",
      "Mietobjekt:",
      "Die monatliche Kaltmiete beträgt",
      "Die Jahresmiete beträgt",
    ],
    fillValues: {
      landlord_name: "Ingrid Baumann",
      tenant_name: "Lukas Vogt",
      property_address: {
        street: "Hauptstraße 14",
        postal_code: "80331",
        city: "München",
      },
      base_rent: 1250,
    },
    checkConfig: (fields) => {
      const defects: string[] = [];
      const landlord = fieldAt(fields, "landlord_name");
      const source = landlord?.source;
      if (source === undefined) {
        defects.push("landlord_name has no source binding");
      } else if (source.kind !== "contact" || source.field !== "displayName") {
        defects.push(`landlord_name binding is ${source.kind}/${source.field}`);
      }
      // The address is three fields with the punctuation between them written
      // as document text: composites are configuration a marker cannot carry,
      // and they go with the overlay.
      for (const key of ["street", "postal_code", "city"]) {
        if (fieldAt(fields, `property_address.${key}`) === undefined) {
          defects.push(`property_address.${key} is not a field`);
        }
      }
      if (fieldAt(fields, "base_rent")?.inputType !== "number") {
        defects.push("base_rent is not a number");
      }
      const formula = fieldAt(fields, "annual_rent")?.formula;
      if (formula === undefined) {
        defects.push("annual_rent has no formula");
      } else if (normalizeFormula(formula) !== "base_rent*12") {
        defects.push(`annual_rent formula is "${formula}"`);
      }
      return defects;
    },
    checkRoundTrip: ({ text }) => ({
      // The address parts and the derived annual rent must all render, with
      // the document's own punctuation joining the three.
      blankRepeatedRows:
        (text.includes("Hauptstraße 14, 80331 München") ? 0 : 1) +
        (digitsOf(text).includes("15000") ? 0 : 1),
      conditionalRowKept: false,
      dateLocaleMismatch: false,
    }),
  },
];

// ── Syntax quiz ───────────────────────────────────────────

const SYNTAX_QUIZ_QUESTIONS = {
  loop_closer: {
    question: "Which tag closes a `{% for attorney in attorneys %}` block?",
    expected: "{% endfor %}",
  },
  item_reference: {
    question:
      "Inside `{% for attorney in attorneys %}`, which marker renders the current item's `name`?",
    expected: "{{ attorney.name }}",
  },
  legacy_marker_supported: {
    question:
      "Is `{{#each attorneys}}` still a supported way to open a loop? true or false.",
    expected: false,
  },
  first_item_reference: {
    question:
      "Outside any loop, which marker renders the FIRST attorney's `name`?",
    expected: "{{ attorneys.0.name }}",
  },
  condition_for_tick_box: {
    question:
      "A person ticks a yes/no box that drives `{% if penalty_applies %}`. Does `penalty_applies` need a `condition(...)` filter? true or false.",
    expected: false,
  },
  block_marker_own_paragraph: {
    question:
      "Outside a table row, must a block tag (`{% for %}`, `{% if %}`, `{% endfor %}`, `{% endif %}`) occupy a paragraph of its own? true or false.",
    expected: true,
  },
  bilingual_same_path: {
    question:
      "The same signing date appears in a Polish and an English paragraph. Do both occurrences use the same marker path? true or false.",
    expected: true,
  },
  lookup_format_marker: {
    question:
      "A lookup field at path `company` declares a named format with key `address`. Which marker renders that format?",
    expected: "{{ company.address }}",
  },
} as const;

type QuizKey = keyof typeof SYNTAX_QUIZ_QUESTIONS;

const SYNTAX_QUIZ_ANSWER_SCHEMA = v.strictObject({
  loop_closer: v.string(),
  item_reference: v.string(),
  legacy_marker_supported: v.boolean(),
  first_item_reference: v.string(),
  condition_for_tick_box: v.boolean(),
  block_marker_own_paragraph: v.boolean(),
  bilingual_same_path: v.boolean(),
  lookup_format_marker: v.string(),
});

type AnswerKey = keyof v.InferInput<typeof SYNTAX_QUIZ_ANSWER_SCHEMA>;

// Totality: a question with no answer property (or the reverse) is a compile
// error here, so the schema cannot drift from the question list.
true satisfies [
  Exclude<QuizKey, AnswerKey>,
  Exclude<AnswerKey, QuizKey>,
] extends [never, never]
  ? true
  : never;

/** The expected answers, keyed exactly like the question list. Built by
 *  reading each question's `expected`, so a new question carries its answer
 *  with it. */
const SYNTAX_QUIZ_EXPECTED: Record<QuizKey, string | boolean> = {
  loop_closer: SYNTAX_QUIZ_QUESTIONS.loop_closer.expected,
  item_reference: SYNTAX_QUIZ_QUESTIONS.item_reference.expected,
  legacy_marker_supported:
    SYNTAX_QUIZ_QUESTIONS.legacy_marker_supported.expected,
  first_item_reference: SYNTAX_QUIZ_QUESTIONS.first_item_reference.expected,
  condition_for_tick_box: SYNTAX_QUIZ_QUESTIONS.condition_for_tick_box.expected,
  block_marker_own_paragraph:
    SYNTAX_QUIZ_QUESTIONS.block_marker_own_paragraph.expected,
  bilingual_same_path: SYNTAX_QUIZ_QUESTIONS.bilingual_same_path.expected,
  lookup_format_marker: SYNTAX_QUIZ_QUESTIONS.lookup_format_marker.expected,
};

const SYNTAX_QUIZ_QUESTION_COUNT = Object.keys(SYNTAX_QUIZ_QUESTIONS).length;

const SYNTAX_QUIZ_PROMPT = [
  `Answer these ${SYNTAX_QUIZ_QUESTION_COUNT} questions about the stella`,
  `template marker grammar by calling ${ANSWER_SYNTAX_TOOL_NAME} exactly`,
  "once. Give each marker answer as the complete marker including its braces.",
  "",
  ...Object.entries(SYNTAX_QUIZ_QUESTIONS).map(
    ([key, { question }]) => `- ${key}: ${question}`,
  ),
].join("\n");

// ── Tools ─────────────────────────────────────────────────

const authoredBlockSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("paragraph"),
    text: v.pipe(v.string(), v.description("The paragraph's complete text.")),
  }),
  v.strictObject({
    type: v.literal("table"),
    rows: v.pipe(
      v.array(v.array(v.string())),
      v.minLength(1),
      v.description("Rows of cells, each cell's complete text."),
    ),
  }),
]);

const WRITE_DOCX_INPUT_SCHEMA = v.strictObject({
  blocks: v.pipe(
    v.array(authoredBlockSchema),
    v.minLength(1),
    v.description("The document in order: paragraphs and tables."),
  ),
});

const WRITE_DOCX_DESCRIPTION =
  "Write the marked-up document to a .docx file. This stands in for the DOCX " +
  "writer an MCP client runs locally. Pass `blocks` in document order, one " +
  "entry per paragraph or per table; a newline inside a table cell starts a " +
  "new paragraph in that cell. Returns `docx_base64`, a SHORT reference " +
  `string. Copy that string verbatim into ${CREATE_TEMPLATE_TOOL_NAME}'s ` +
  "`docx_base64`; it expands to the file's real bytes at the boundary. Never " +
  "write base64 yourself: this host has no file transport, so the reference " +
  "is the only way the document reaches the tool.";

type ToolTrace = { name: string; input: unknown };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message inside a refused tool result, for the trace. */
const toolErrorText = (result: unknown): string => {
  const content = isPlainRecord(result) ? result["content"] : undefined;
  const [first] = Array.isArray(content) ? content : [];
  return isPlainRecord(first) && typeof first["text"] === "string"
    ? first["text"]
    : "validation_error";
};
type WrittenDocx = { ref: string; blocks: AuthoredBlock[]; buffer: Buffer };

const EVAL_TEMPLATE_ID = "00000000-0000-4000-8000-00000000e7a1";

/**
 * The tools of one run, plus the replay entry point a recorded trace goes
 * through. A model turn calls the handlers through `tools`; `--rescore` calls
 * the same handlers with the same inputs through `replay`. One
 * implementation, so a rescored run and a live one cannot drift.
 */
type AuthoringToolSet = {
  tools: AnyServerTool[];
  replay: (call: ToolTrace) => Promise<void>;
};

const createAuthoringTools = ({
  trace,
  saveCalls,
  writeCalls,
}: {
  trace: ToolTrace[];
  saveCalls: SaveCall[];
  writeCalls: WrittenDocx[];
}): AuthoringToolSet => {
  const written = new Map<string, Buffer>();
  // The one template this run may create: the bytes the last accepted call
  // left, plus the display name configure echoes back the way production
  // describes it. Bytes are the whole template, so a configure call writes
  // into these and the result becomes them; a second configure then refines
  // the first one's document exactly as it does a stored one.
  let stored: { buffer: Buffer; name: string | undefined } | null = null;

  const handleWriteDocx = async ({
    blocks,
  }: v.InferOutput<typeof WRITE_DOCX_INPUT_SCHEMA>) => {
    trace.push({ name: WRITE_DOCX_TOOL_NAME, input: { blocks } });
    const ref = `docx#${String(written.size + 1)}`;
    const authored: AuthoredBlock[] = blocks.map((block) =>
      block.type === "paragraph"
        ? { type: "paragraph", text: block.text }
        : { type: "table", rows: block.rows },
    );
    const buffer = await buildDocx(authored);
    writeCalls.push({ ref, blocks: authored, buffer });
    written.set(ref, buffer);
    // Named after the parameter it feeds: copying a value into a property of
    // the same name is one step, inferring the mapping is a guess.
    return { docx_base64: ref, bytes: buffer.byteLength };
  };

  /** Record one attempt at the create/configure pair, in the shape scoring
   *  reads: the saved document's blocks, the overlay it carried, the outcome. */
  const recordAttempt = async ({
    outcome,
    overlay,
    step,
  }: {
    outcome: SaveOutcome;
    overlay: readonly FieldMeta[];
    step: SaveCall["step"];
  }): Promise<void> => {
    saveCalls.push({
      step,
      // Traps are read off the document that was actually saved, not off the
      // write_docx input, so they describe the bytes the contract received.
      blocks:
        outcome.status === "saved" ? await readDocxBlocks(outcome.buffer) : [],
      overlay,
      outcome,
    });
  };

  const handleCreateTemplate = async (input: unknown) => {
    trace.push({ name: CREATE_TEMPLATE_TOOL_NAME, input });
    const parsed = v.safeParse(
      CREATE_TEMPLATE_TOOL_DEFINITION.inputSchemaSource,
      input,
    );
    if (!parsed.success) {
      const issues = validationIssues(parsed.issues);
      await recordAttempt({
        outcome: { status: "rejected", issues },
        overlay: [],
        step: "create",
      });
      return { error: "validation_error", issues };
    }
    const ref = parsed.output.docx_base64;
    if (ref === undefined) {
      const issues = [
        "docx_base64 is required: pass the reference write_docx returned",
      ];
      await recordAttempt({
        outcome: { status: "rejected", issues },
        overlay: [],
        step: "create",
      });
      return { error: "validation_error", issues };
    }
    // A reference expands to the bytes write_docx wrote; anything else is
    // taken as real base64, so a client that does hold the file still works.
    const writtenDocx = written.get(ref.trim());
    const outcome = await createTemplateInMemory(
      writtenDocx?.toString("base64") ?? ref,
    );
    await recordAttempt({ outcome, overlay: [], step: "create" });
    if (outcome.status === "invalid-docx") {
      return { error: "validation_error", issues: [outcome.reason] };
    }
    if (outcome.status === "rejected") {
      return { error: "validation_error", issues: outcome.issues };
    }
    stored = { buffer: outcome.buffer, name: parsed.output.name };
    return {
      templateId: EVAL_TEMPLATE_ID,
      name: parsed.output.name,
      fieldCount: outcome.manifest.fields.length,
      // The next call, spelled out, exactly as the production response does.
      configure: {
        template_id: EVAL_TEMPLATE_ID,
        fields: outcome.configurablePaths.map((path) => ({
          path,
          source: { type: "person" },
        })),
      },
    };
  };

  const handleConfigureFields = async (input: unknown) => {
    trace.push({ name: CONFIGURE_FIELDS_TOOL_NAME, input });
    // The tool site's own reader, not a second one: it is best effort per
    // property and per entry, so what the eval counts as a contract rejection
    // is what the production server returns.
    const parsed = parseConfigureEntries(
      isPlainRecord(input) ? input : { fields: input },
    );
    if (parsed.type === "rejected") {
      const issues = [`the call was refused: ${toolErrorText(parsed.result)}`];
      await recordAttempt({
        outcome: { status: "rejected", issues },
        overlay: [],
        step: "configure",
      });
      return { error: "validation_error", issues };
    }
    const overlay = parsed.fields;
    if (stored === null) {
      const issues = [
        `template_id: no template exists yet; call ${CREATE_TEMPLATE_TOOL_NAME} first`,
      ];
      await recordAttempt({
        outcome: { status: "rejected", issues },
        overlay,
        step: "configure",
      });
      return { error: "not_found", issues };
    }
    // The run holds one template. Any other id names a template production
    // would not find, so the overlay must not reach the stored document.
    if (parsed.templateId !== EVAL_TEMPLATE_ID) {
      const issues = [
        `template_id: no template ${parsed.templateId} exists; pass the template_id ${CREATE_TEMPLATE_TOOL_NAME} returned`,
      ];
      await recordAttempt({
        outcome: { status: "rejected", issues },
        overlay,
        step: "configure",
      });
      return { error: "not_found", issues };
    }
    const outcome = await configureTemplateInMemory({
      buffer: stored.buffer,
      entries: overlay,
    });
    // The entries were written into the markers, so the document they produced
    // IS the template from here on.
    stored = { ...stored, buffer: outcome.buffer };
    // `configureTemplateDocument` only saw the entries the schema accepted, so
    // it counts positions in THAT list. The model counts positions in the list
    // it sent, so the positions are translated back before the two lists meet,
    // exactly as the tool site does it.
    const documentIssues = outcome.issues.map((issue) => {
      const index =
        parsed.applied.at(issue.index) ??
        panic(`configure issue names applied entry ${String(issue.index)}`);
      return {
        path: fieldConfigurationIssuePath(index, issue.property),
        index,
        message: issue.message,
        hint: issue.hint,
      };
    });
    const issues = [...parsed.issues, ...documentIssues].toSorted(
      (left, right) => left.index - right.index,
    );
    // The properties and entries the tool site dropped, and the ones the
    // document refused, are what the call reported, so they are what the run
    // is scored on.
    await recordAttempt({
      outcome: { ...outcome, issues },
      overlay,
      step: "configure",
    });
    return {
      name: stored.name,
      issues: issues.map(
        ({ hint, message, path }) => `${path}: ${message} ${hint}`,
      ),
      fields: outcome.manifest.fields.map((field) => ({ path: field.path })),
    };
  };

  const tools = [
    toolDefinition({
      name: WRITE_DOCX_TOOL_NAME,
      description: WRITE_DOCX_DESCRIPTION,
      inputSchema: toTanStackToolSchema(WRITE_DOCX_INPUT_SCHEMA),
    }).server(handleWriteDocx),
    toolDefinition({
      name: CREATE_TEMPLATE_TOOL_NAME,
      description: CREATE_TEMPLATE_TOOL_DEFINITION.description,
      inputSchema: productionToolSchema(CREATE_TEMPLATE_TOOL_DEFINITION),
    }).server(handleCreateTemplate),
    toolDefinition({
      name: CONFIGURE_FIELDS_TOOL_NAME,
      description: CONFIGURE_TEMPLATE_FIELDS_TOOL_DEFINITION.description,
      inputSchema: productionToolSchema(
        CONFIGURE_TEMPLATE_FIELDS_TOOL_DEFINITION,
      ),
    }).server(handleConfigureFields),
  ];

  const replay = async ({ input, name }: ToolTrace): Promise<void> => {
    if (name === WRITE_DOCX_TOOL_NAME) {
      const parsed = v.safeParse(WRITE_DOCX_INPUT_SCHEMA, input);
      // A recorded write_docx input passed this schema before the handler ran
      // live; anything else authored no document then either.
      if (parsed.success) {
        await handleWriteDocx(parsed.output);
      }
      return;
    }
    if (name === CREATE_TEMPLATE_TOOL_NAME) {
      await handleCreateTemplate(input);
      return;
    }
    if (name === CONFIGURE_FIELDS_TOOL_NAME) {
      await handleConfigureFields(input);
    }
    // Anything else is a `(raw)` entry, which never reached a handler live.
  };

  return { tools, replay };
};

const createQuizTool = ({
  trace,
  answers,
}: {
  trace: ToolTrace[];
  answers: Record<string, unknown>[];
}): AuthoringToolSet => {
  const handleAnswer = async (input: Record<string, unknown>) => {
    trace.push({ name: ANSWER_SYNTAX_TOOL_NAME, input });
    answers.push({ ...input });
    return await Promise.resolve({ received: true });
  };
  return {
    tools: [
      toolDefinition({
        name: ANSWER_SYNTAX_TOOL_NAME,
        description: `Answer the ${SYNTAX_QUIZ_QUESTION_COUNT} marker-grammar questions. Every property is required.`,
        inputSchema: toTanStackToolSchema(SYNTAX_QUIZ_ANSWER_SCHEMA),
      }).server(handleAnswer),
    ],
    // A recorded answer is what the handler already stored, so it replays as
    // it stands: re-validating it here would refuse an answer the live turn
    // scored.
    replay: async ({ input, name }) => {
      if (name === ANSWER_SYNTAX_TOOL_NAME && isPlainRecord(input)) {
        await handleAnswer(input);
      }
    },
  };
};

// ── CLI ───────────────────────────────────────────────────

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  jsonPath: string | null;
  /** A previous run's JSON to replay instead of calling any model. */
  rescorePath: string | null;
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: DEFAULT_MODELS,
    runs: DEFAULT_RUNS,
    taskFilter: null,
    jsonPath: null,
    rescorePath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv.at(index);
    const value = argv.at(index + 1);
    if (flag === undefined || value === undefined) {
      continue;
    }
    switch (flag) {
      case "--models":
        options.models = value.split(",").map((id) => id.trim());
        index += 1;
        break;
      case "--runs":
        options.runs = Math.min(
          MAX_RUNS,
          Math.max(1, Number.parseInt(value, 10) || DEFAULT_RUNS),
        );
        index += 1;
        break;
      case "--task":
        options.taskFilter = value;
        index += 1;
        break;
      case "--json":
        options.jsonPath = value;
        index += 1;
        break;
      case "--rescore":
        options.rescorePath = value;
        index += 1;
        break;
      default:
        break;
    }
  }
  return options;
};

// ── Model turn ────────────────────────────────────────────

type ModelTurn = {
  error: string | null;
  finalText: string;
  latencyMs: number;
  usage: TokenUsage | null;
  /** Raw tool-call inputs, so a call the schema rejected before the handler
   *  ran is still visible to scoring. */
  rawCalls: ToolTrace[];
};

const runModelTurn = async ({
  model,
  prompt,
  systemPrompt,
  tools,
}: {
  model: ResolvedTanStackTextModel;
  prompt: string;
  /** Must describe only the tools this turn actually registers. */
  systemPrompt: string;
  tools: AnyServerTool[];
}): Promise<ModelTurn> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "fast",
    scopeKey: null,
  });
  const system = `${systemPrompt}\n\n${REFERENCE_RESOURCES}`;
  const rawCalls: ToolTrace[] = [];
  const callNames = new Map<string, string>();
  let finalText = "";
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs: MODEL_TURN_TIMEOUT_MS,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: prompt }],
        agentLoopStrategy: maxIterations(MAX_ITERATIONS),
        ...systemPromptsPatch({ caching, model, system }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          serviceTier: "standard",
          temperature: 0,
        }),
        tools,
      }),
    onChunk: (chunk) => {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        finalText += chunk.delta;
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_START) {
        const name = toolCallNameOf(chunk);
        if (name !== undefined) {
          callNames.set(chunk.toolCallId, name);
        }
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_END) {
        rawCalls.push({
          name: toolCallNameOf(chunk) ?? callNames.get(chunk.toolCallId) ?? "",
          input: toolCallEndInputOf(chunk),
        });
      }
    },
  });
  return { error, finalText, latencyMs, usage, rawCalls };
};

// ── Running one task ──────────────────────────────────────

type EvalRun = {
  modelId: string;
  taskId: string;
  repeat: number;
  score: AuthoringRunScore;
  /** Exact provider or stream error for this run, retained in JSON output. */
  error: string | null;
  calls: number;
  quiz: { correct: number; total: number } | null;
  latencyMs: number;
  usage: TokenUsage | null;
  finalText: string;
  trace: ToolTrace[];
  renderedText: string | null;
};

const buildAttempt = async ({
  call,
  extraIssues,
  task,
  organizationId,
}: {
  call: SaveCall;
  /** Issues from a later call that was refused after this one was saved. */
  extraIssues: readonly string[];
  task: EvalTask;
  organizationId: SafeId<"organization">;
}): Promise<{ attempt: SaveAttempt; renderedText: string | null }> => {
  const { outcome } = call;
  if (outcome.status === "invalid-docx") {
    return {
      attempt: { status: "invalid-docx", reason: outcome.reason },
      renderedText: null,
    };
  }
  if (outcome.status === "rejected") {
    return {
      attempt: { status: "rejected", overlayIssues: outcome.issues },
      renderedText: null,
    };
  }
  const roundTrip = await runRoundTrip({
    saved: outcome,
    task,
    organizationId,
  });
  return {
    attempt: {
      status: "saved",
      paths: comparePaths(task.expectedPaths, outcome.resolvedPaths),
      traps: detectGrammarTraps({
        blocks: call.blocks,
        overlay: call.overlay,
        booleanInputPaths: task.booleanInputPaths,
      }),
      overlayIssues: [
        ...outcome.issues
          .filter(isEntryOverlayIssue)
          .map((issue) => `${issue.path}: ${issue.message} ${issue.hint}`),
        ...extraIssues,
        ...outcome.structureErrors,
      ],
      // The hint every property drop carries is the same sentence; the column
      // names the property, which is the part that differs.
      propertyDrops: outcome.issues
        .filter((issue) => !isEntryOverlayIssue(issue))
        .map((issue) => `${issue.path}: ${issue.message}`),
      configDefects: task.checkConfig(outcome.manifest.fields),
      fidelity: checkSourceFidelity({
        authored: authoredParagraphs(call.blocks),
        preservedPhrases: task.preservedPhrases,
      }),
      roundTrip: roundTrip.defects,
    },
    renderedText: roundTrip.text,
  };
};

const buildUnsavedAttempt = async ({
  blocks,
  buffer,
  task,
  overlayIssues,
}: {
  blocks: readonly AuthoredBlock[];
  buffer: Buffer;
  task: EvalTask;
  overlayIssues: readonly string[];
}): Promise<SaveAttempt> => {
  const discovered = await discoverTemplate(buffer);
  const paths = mergeManifestWithDiscovery(null, discovered).map(
    (field) => field.path,
  );
  return {
    status: "unsaved",
    paths: comparePaths(task.expectedPaths, paths),
    traps: detectGrammarTraps({
      blocks,
      overlay: [],
      booleanInputPaths: task.booleanInputPaths,
    }),
    overlayIssues: [
      ...overlayIssues,
      ...discovered.structureErrors.map(
        (error) => `${error.directive}: ${error.message}`,
      ),
    ],
    fidelity: checkSourceFidelity({
      authored: authoredParagraphs(blocks),
      preservedPhrases: task.preservedPhrases,
    }),
  };
};

/**
 * Score one authoring turn: the tool calls a model made, or the tool calls a
 * recorded trace replayed. Everything past the turn — which save attempt
 * counts, the fill round trip, the run's diagnostics — lives here so a
 * rescored run cannot be scored by a second implementation.
 */
const scoreAuthoringTurn = async ({
  modelId,
  repeat,
  saveCalls,
  task,
  trace,
  turn,
  writeCalls,
}: {
  modelId: string;
  repeat: number;
  saveCalls: readonly SaveCall[];
  task: EvalTask;
  trace: ToolTrace[];
  turn: ModelTurn;
  writeCalls: readonly WrittenDocx[];
}): Promise<EvalRun> => {
  const organizationId = mintAuthProviderId<"organization">();
  // Every call the advertised schema rejected before the handler ran, kept in
  // the trace: a pass rate without the payload the model actually sent cannot
  // say whether the model or the contract failed.
  const rawCalls = turn.rawCalls.filter(
    (entry) =>
      entry.name === CREATE_TEMPLATE_TOOL_NAME ||
      entry.name === CONFIGURE_FIELDS_TOOL_NAME,
  );
  const handled = new Set<string>(
    saveCalls.map((entry) =>
      entry.step === "create"
        ? CREATE_TEMPLATE_TOOL_NAME
        : CONFIGURE_FIELDS_TOOL_NAME,
    ),
  );
  for (const entry of rawCalls) {
    if (!handled.has(entry.name)) {
      trace.push({ name: `${entry.name}(raw)`, input: entry.input });
    }
  }

  // `create_template` accepted a document at some point in the run, which the
  // last attempt alone cannot say: a configure that was refused still follows
  // a create that was not.
  const created = saveCalls.some(
    (entry) => entry.step === "create" && entry.outcome.status === "saved",
  );
  const savedIndex = saveCalls.findLastIndex(
    (entry) => entry.outcome.status === "saved",
  );
  const saved = saveCalls[savedIndex];

  if (saved === undefined) {
    const raw = rawCalls.filter(
      (entry) => entry.name === CREATE_TEMPLATE_TOOL_NAME,
    );
    const last = raw.at(-1);
    const parsed =
      last === undefined
        ? null
        : v.safeParse(
            CREATE_TEMPLATE_TOOL_DEFINITION.inputSchemaSource,
            last.input,
          );
    const rejection = saveCalls.at(-1)?.outcome;
    let overlayIssues: string[];
    if (rejection?.status === "rejected") {
      overlayIssues = [...rejection.issues];
    } else if (parsed === null) {
      overlayIssues = [];
    } else if (parsed.success) {
      overlayIssues = [
        `${CREATE_TEMPLATE_TOOL_NAME} call never reached the handler`,
      ];
    } else {
      overlayIssues = validationIssues(parsed.issues);
    }
    // A rejected raw create can name an earlier write. Score that exact
    // document; using the most recent write would attach its diagnostics to a
    // different attempted create. With no create attempt, the last authored
    // document remains the only available partial evidence.
    let authored: WrittenDocx | undefined;
    if (last === undefined) {
      authored = writeCalls.at(-1);
    } else if (parsed?.success) {
      const ref = parsed.output.docx_base64;
      authored =
        ref === undefined
          ? undefined
          : writeCalls.findLast((written) => written.ref === ref.trim());
    }

    let attempt: SaveAttempt | null;
    if (authored === undefined) {
      attempt =
        parsed === null && rejection === undefined
          ? null
          : { status: "rejected", overlayIssues };
    } else {
      attempt = await buildUnsavedAttempt({
        blocks: authored.blocks,
        buffer: authored.buffer,
        task,
        overlayIssues,
      });
    }
    return {
      modelId,
      taskId: task.id,
      repeat,
      score: scoreAuthoringRun({ turnError: turn.error, attempt, created }),
      error: turn.error,
      calls: rawCalls.length,
      quiz: null,
      latencyMs: turn.latencyMs,
      usage: turn.usage,
      finalText: turn.finalText,
      trace,
      renderedText: null,
    };
  }

  // A configure refused after the template was created leaves the created
  // document standing; its issues belong to the run, not a lost attempt.
  const laterIssues = saveCalls
    .slice(savedIndex + 1)
    .flatMap((entry) =>
      entry.outcome.status === "rejected" ? entry.outcome.issues : [],
    );
  const { attempt, renderedText } = await buildAttempt({
    call: saved,
    extraIssues: laterIssues,
    task,
    organizationId,
  });
  return {
    modelId,
    taskId: task.id,
    repeat,
    score: scoreAuthoringRun({ turnError: turn.error, attempt, created }),
    error: turn.error,
    calls: rawCalls.length,
    quiz: null,
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
    trace,
    renderedText,
  };
};

const runAuthoringTask = async ({
  model,
  modelId,
  task,
  repeat,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  task: EvalTask;
  repeat: number;
}): Promise<EvalRun> => {
  const trace: ToolTrace[] = [];
  const saveCalls: SaveCall[] = [];
  const writeCalls: WrittenDocx[] = [];
  const { tools } = createAuthoringTools({ trace, saveCalls, writeCalls });
  const sourceDocx = await buildDocx(task.source);
  const prompt = [
    task.brief,
    "",
    "Source document:",
    renderBlocks(await readDocxBlocks(sourceDocx)),
  ].join("\n");

  const turn = await runModelTurn({
    model,
    prompt,
    systemPrompt: AUTHORING_SYSTEM_PROMPT,
    tools,
  });
  return await scoreAuthoringTurn({
    modelId,
    repeat,
    saveCalls,
    task,
    trace,
    turn,
    writeCalls,
  });
};

const SYNTAX_QUIZ_TASK_ID = "syntax-quiz";

/** Score one quiz turn, model-driven or replayed, from the answer it left. */
const scoreQuizTurn = ({
  answers,
  modelId,
  repeat,
  trace,
  turn,
}: {
  answers: readonly Record<string, unknown>[];
  modelId: string;
  repeat: number;
  trace: ToolTrace[];
  turn: ModelTurn;
}): EvalRun => {
  const quiz = scoreSyntaxQuiz(answers.at(-1) ?? null, SYNTAX_QUIZ_EXPECTED);
  const quizOutcome = (): AuthoringRunScore["outcome"] => {
    if (turn.error !== null) {
      return "error";
    }
    if (answers.length === 0) {
      return "no-call";
    }
    return quiz.wrong.length === 0 ? "pass" : "partial";
  };
  const score: AuthoringRunScore = {
    outcome: quizOutcome(),
    // The quiz authors nothing: its four workflow steps are all "not reached".
    steps: {
      authored: false,
      created: false,
      configured: false,
      filled: false,
    },
    // Wrong answers ride in `missing`, the column that already means "the
    // contract asked for this and did not get it".
    paths: { missing: quiz.wrong, extra: [] },
    traps: detectGrammarTraps({
      blocks: [],
      overlay: [],
      booleanInputPaths: [],
    }),
    overlayIssues: [],
    propertyDrops: [],
    configDefects: [],
    fidelity: [],
    roundTrip: cleanRoundTrip(),
    note: turn.error,
  };
  return {
    modelId,
    taskId: SYNTAX_QUIZ_TASK_ID,
    repeat,
    score,
    error: turn.error,
    calls: answers.length,
    quiz: { correct: quiz.correct, total: quiz.total },
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
    trace,
    renderedText: null,
  };
};

const runSyntaxQuiz = async ({
  model,
  modelId,
  repeat,
}: {
  model: ResolvedTanStackTextModel;
  modelId: string;
  repeat: number;
}): Promise<EvalRun> => {
  const trace: ToolTrace[] = [];
  const answers: Record<string, unknown>[] = [];
  const { tools } = createQuizTool({ trace, answers });
  const turn = await runModelTurn({
    model,
    prompt: SYNTAX_QUIZ_PROMPT,
    systemPrompt: QUIZ_SYSTEM_PROMPT,
    tools,
  });
  return scoreQuizTurn({ answers, modelId, repeat, trace, turn });
};

// ── Rescoring a recorded run ──────────────────────────────

/**
 * The fields `--rescore` reads back out of a previous run's JSON. Only the
 * turn's own record and its tool calls: everything else in the file is a
 * score, which is exactly what this mode recomputes. Unknown properties are
 * ignored, so a file written by a later version still replays.
 */
const RECORDED_RUN_SCHEMA = v.object({
  modelId: v.string(),
  taskId: v.string(),
  repeat: v.number(),
  error: v.nullable(v.string()),
  finalText: v.string(),
  latencyMs: v.number(),
  // The per-category token breakdowns a provider may add are not read by
  // anything the report prints, so they are not carried back.
  usage: v.nullable(
    v.object({
      promptTokens: v.number(),
      completionTokens: v.number(),
      totalTokens: v.number(),
    }),
  ),
  trace: v.array(v.object({ name: v.string(), input: v.unknown() })),
});

const RECORDED_EVAL_SCHEMA = v.object({
  runs: v.array(RECORDED_RUN_SCHEMA),
});

type RecordedRun = v.InferOutput<typeof RECORDED_RUN_SCHEMA>;

/** The suffix the live loop appends to a call that never reached a handler. */
const RAW_CALL_SUFFIX = "(raw)";

/**
 * The turn a recorded run stands for. `rawCalls` is reconstructed from the
 * trace, which holds every create/configure call the run made — the ones a
 * handler ran and the `(raw)` ones it did not — so a replayed turn reaches the
 * same branch of scoring the live one did.
 */
const recordedTurn = (run: RecordedRun): ModelTurn => ({
  error: run.error,
  finalText: run.finalText,
  latencyMs: run.latencyMs,
  usage: run.usage,
  rawCalls: run.trace.flatMap(({ input, name }) => {
    const called = name.endsWith(RAW_CALL_SUFFIX)
      ? name.slice(0, -RAW_CALL_SUFFIX.length)
      : name;
    return called === CREATE_TEMPLATE_TOOL_NAME ||
      called === CONFIGURE_FIELDS_TOOL_NAME
      ? [{ name: called, input }]
      : [];
  }),
});

const rescoreAuthoringRun = async (
  run: RecordedRun,
  task: EvalTask,
): Promise<EvalRun> => {
  const trace: ToolTrace[] = [];
  const saveCalls: SaveCall[] = [];
  const writeCalls: WrittenDocx[] = [];
  const { replay } = createAuthoringTools({ trace, saveCalls, writeCalls });
  for (const call of run.trace) {
    await replay(call);
  }
  return await scoreAuthoringTurn({
    modelId: run.modelId,
    repeat: run.repeat,
    saveCalls,
    task,
    trace,
    turn: recordedTurn(run),
    writeCalls,
  });
};

const rescoreQuizRun = async (run: RecordedRun): Promise<EvalRun> => {
  const trace: ToolTrace[] = [];
  const answers: Record<string, unknown>[] = [];
  const { replay } = createQuizTool({ trace, answers });
  for (const call of run.trace) {
    await replay(call);
  }
  return scoreQuizTurn({
    answers,
    modelId: run.modelId,
    repeat: run.repeat,
    trace,
    turn: recordedTurn(run),
  });
};

/**
 * Replay a recorded eval's tool calls through the save, configure and fill
 * path a live run takes, with no model turn. What a harness or engine change
 * does to the same authored bytes is then measurable without paying for the
 * turns again.
 */
const rescoreRuns = async ({
  path,
  taskFilter,
}: {
  path: string;
  taskFilter: string | null;
}): Promise<EvalRun[]> => {
  const recorded = v.parse(
    RECORDED_EVAL_SCHEMA,
    JSON.parse(await readFile(path, "utf-8")),
  );
  const runs: EvalRun[] = [];
  for (const run of recorded.runs) {
    if (taskFilter !== null && run.taskId !== taskFilter) {
      continue;
    }
    process.stderr.write(
      `rescore · ${run.modelId} · ${run.taskId} · run ${String(run.repeat)}\n`,
    );
    if (run.taskId === SYNTAX_QUIZ_TASK_ID) {
      runs.push(await rescoreQuizRun(run));
      continue;
    }
    const task =
      TASKS.find((candidate) => candidate.id === run.taskId) ??
      panic(`Recorded run names unknown task ${run.taskId}`);
    runs.push(await rescoreAuthoringRun(run, task));
  }
  return runs;
};

// ── Report ────────────────────────────────────────────────

const cell = (values: readonly string[]): string =>
  values.length === 0
    ? "-"
    : values
        .join("; ")
        .replaceAll(/\r\n|\r|\n/gu, "<br>")
        .replaceAll("|", "\\|");

const trapsCell = (traps: GrammarTrapCounts): string =>
  cell(
    GRAMMAR_TRAP_CODES.filter((code) => traps[code] > 0).map(
      (code) => `${code}×${String(traps[code])}`,
    ),
  );

const roundTripCell = (roundTrip: RoundTripDefects): string =>
  cell([
    ...(roundTrip.leftoverMarkers > 0
      ? [`leftover×${String(roundTrip.leftoverMarkers)}`]
      : []),
    ...(roundTrip.blankRepeatedRows > 0
      ? [`blank-rows×${String(roundTrip.blankRepeatedRows)}`]
      : []),
    ...(roundTrip.conditionalRowKept ? ["row-not-dropped"] : []),
    ...(roundTrip.dateLocaleMismatch ? ["date-locale"] : []),
    ...(roundTrip.fillError === null ? [] : [`fill: ${roundTrip.fillError}`]),
  ]);

/** The four steps as the initials of the ones that were reached, so the
 *  column stays one glance wide: `ACcf` reached authoring and creation. */
const stepsCell = (steps: AuthoringSteps): string =>
  AUTHORING_STEP_NAMES.map((name) => {
    const initial = name.slice(0, 1);
    return steps[name] ? initial.toUpperCase() : initial;
  }).join("");

const tokensCell = (usage: TokenUsage | null): string =>
  usage === null ? "-" : String(usage.totalTokens);

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = [];
  for (const modelId of new Set(runs.map((run) => run.modelId))) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| task | run | outcome | steps | error | calls | missing | extra | traps | overlay | dropped | config | fidelity | round trip | tokens | ms |",
      "| --- | ---: | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |",
    );
    for (const run of modelRuns) {
      const { score } = run;
      lines.push(
        [
          `| ${run.taskId}`,
          String(run.repeat),
          score.outcome,
          stepsCell(score.steps),
          run.error === null ? "-" : cell([run.error]),
          String(run.calls),
          cell(score.paths.missing),
          cell(score.paths.extra),
          trapsCell(score.traps),
          cell(score.overlayIssues),
          cell(score.propertyDrops),
          cell(score.configDefects),
          cell(score.fidelity),
          roundTripCell(score.roundTrip),
          tokensCell(run.usage),
          `${String(run.latencyMs)} |`,
        ].join(" | "),
      );
    }
    const passed = modelRuns.filter(
      (run) => run.score.outcome === "pass",
    ).length;
    const traps = modelRuns.reduce(
      (total, run) =>
        total +
        GRAMMAR_TRAP_CODES.reduce(
          (sum, code) => sum + run.score.traps[code],
          0,
        ),
      0,
    );
    const authoringRuns = modelRuns.filter((run) => run.quiz === null);
    const stepTotals = AUTHORING_STEP_NAMES.map(
      (name) =>
        `${name} ${String(
          authoringRuns.filter((run) => run.score.steps[name]).length,
        )}/${String(authoringRuns.length)}`,
    ).join(", ");
    const propertyDrops = modelRuns.reduce(
      (total, run) => total + run.score.propertyDrops.length,
      0,
    );
    const quiz = modelRuns.find((run) => run.quiz !== null)?.quiz ?? null;
    const quizSummary =
      quiz === null
        ? ""
        : `, syntax quiz ${String(quiz.correct)}/${String(quiz.total)}`;
    lines.push(
      "",
      `passed ${String(passed)}/${String(modelRuns.length)}, ${stepTotals}, grammar traps ${String(traps)}, property drops ${String(propertyDrops)}${quizSummary}`,
    );
  }
  return lines.join("\n");
};

const resolveModels = async (
  modelIds: readonly string[],
): Promise<{ id: string; model: ResolvedTanStackTextModel }[]> => {
  const { getTanStackTextModelById, hasTanStackInstanceProvider } =
    await import("@/api/lib/tanstack-ai-models");
  if (!hasTanStackInstanceProvider()) {
    return panic(
      "No instance AI provider is configured; set a provider key in .env",
    );
  }
  return modelIds.map((id) => ({
    id,
    model: getTanStackTextModelById(id, null, {
      role: "fast",
      organizationId: null,
    }),
  }));
};

const runEval = async (options: CliOptions): Promise<EvalRun[]> => {
  const tasks = TASKS.filter(
    (task) => options.taskFilter === null || task.id === options.taskFilter,
  );
  const includeQuiz =
    options.taskFilter === null || options.taskFilter === SYNTAX_QUIZ_TASK_ID;
  if (tasks.length === 0 && !includeQuiz) {
    panic(`Unknown task ${String(options.taskFilter)}`);
  }
  const models = await resolveModels(options.models);
  const runs: EvalRun[] = [];
  for (const { id, model } of models) {
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(`${id} · ${task.id} · run ${String(repeat)}\n`);
        runs.push(await runAuthoringTask({ model, modelId: id, task, repeat }));
      }
    }
    if (includeQuiz) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(
          `${id} · ${SYNTAX_QUIZ_TASK_ID} · run ${String(repeat)}\n`,
        );
        runs.push(await runSyntaxQuiz({ model, modelId: id, repeat }));
      }
    }
  }
  return runs;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const runs =
    options.rescorePath === null
      ? await runEval(options)
      : await rescoreRuns({
          path: options.rescorePath,
          taskFilter: options.taskFilter,
        });

  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
