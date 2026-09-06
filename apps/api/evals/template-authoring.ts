/**
 * save_template authoring eval: the authoring half of `template-fill.ts`. Can
 * a model turn a source document into a stella template through the
 * production `save_template` contract (the right `{{markers}}` in the right
 * paragraphs, plus a `fields` overlay that configures each one), and are the
 * two reference resources clear enough that a lower-tier model gets there?
 *
 * The model sees exactly what an external MCP client sees: the marker-grammar
 * and field-configuration resources verbatim (`buildMarkerReference()`,
 * `buildFieldReference()`), the `save_template` tool with its production name,
 * description and input schema, the source document, and a short brief naming
 * the field paths to use. `save_template` is backed in memory by the same
 * recipe `createStoredTemplate` runs: decode, `validateDocxBuffer`,
 * `discoverTemplate`, `mergeManifestWithDiscovery`, the unknown-path overlay
 * rejection, `writeManifest`; minus the DB and S3 the eval has no business
 * touching. The saved template is then filled with fixed values through the
 * real `fillTemplateDocx`, so the round trip is scored on rendered bytes.
 *
 * `write_docx` is NOT a stella tool. It stands in for the DOCX writer an MCP
 * client runs locally: a language model cannot emit zip bytes, and making it
 * copy kilobytes of base64 would measure transcription, not authoring. It
 * returns a reference that expands to the file's real base64 at the
 * `save_template` boundary, so every production validation still runs on real
 * bytes.
 *
 * Scored per run:
 *
 *   outcome       pass / partial / invalid-docx / no-call / error
 *   missing/extra discovered field paths against the set the brief names
 *   traps         named grammar mistakes (see GRAMMAR_TRAP_CODES):
 *                 unprefixed_item_path, this_prefix, unknown_directive,
 *                 bracket_index, language_variant_path, block_marker_inline,
 *                 lookup_not_parent, condition_on_input
 *   overlay       production validation issues (schema, mutually exclusive
 *                 derived sources, a `path` matching no marker)
 *   config        field configuration the brief asked for and did not get
 *   fidelity      source wording the template dropped instead of keeping
 *   round trip    leftover `{{`, blank repeated rows, a conditional row that
 *                 was not dropped, a date outside its requested locale
 *   tokens, ms
 *
 * The `syntax-quiz` task has no DOCX: eight grammar questions answered as one
 * JSON object, scored exactly. Its wrong answers are reported in the
 * `missing` column.
 *
 * Two tasks cannot pass on today's engine, by design: the eval measures the
 * contract, not the current code, so these columns are a backlog rather than
 * a regression.
 *   - `pl-en-poa`: discovery reports a marker with dotted children
 *     (`{{company}}` beside `{{company.address}}`) as kind `object`, and the
 *     merge drops object parents, so `company` is not a configurable path and
 *     the overlay is rejected. One lookup parent with named formats needs
 *     that parent discoverable first.
 *   - `en-sow-table`: a row-mode `{{#if}}` has its paragraphs stripped but
 *     its row left in the table, so the row is never dropped.
 * Save time also emits no marker warnings yet.
 *
 * Registry lookups and contact bindings are neutralized before the fill: the
 * eval has no matter and must not call a business registry, so those fields
 * are scored as configuration and filled with fixed values.
 *
 * Usage (from apps/api):
 *   bun run eval:template-authoring
 *   bun run eval:template-authoring -- --models anthropic::claude-haiku-4-5-20251001
 *   bun run eval:template-authoring -- --task cs-nda --runs 3 --json out.json
 */
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import JSZip from "jszip";
import { writeFile } from "node:fs/promises";
import * as slimdom from "slimdom";
import * as v from "valibot";

import { formatDate } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { resolveCaching } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  streamChatChunks,
  toolCallEndInputOf,
  toolCallNameOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import {
  isElement,
  MAIN_DOCUMENT_PART_PATH,
  paragraphText,
  W_NS,
} from "@/api/lib/docx/ooxml";
import {
  mergeManifestWithDiscovery,
  writeManifest,
} from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import {
  fillTemplateDocx,
  type FillTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { toFieldMetaToolInput } from "@/api/mcp/template-field-input";
import { buildFieldReference } from "@/api/mcp/template-field-reference";
import { buildMarkerReference } from "@/api/mcp/template-marker-reference";
import { TEMPLATE_TOOL_DEFINITIONS } from "@/api/mcp/template-tools";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { runEvalModelTurn } from "./lib/model-turn";
import type {
  AuthoredBlock,
  AuthoringRunScore,
  GrammarTrapCounts,
  RoundTripDefects,
  SaveAttempt,
} from "./lib/template-authoring-score";
import {
  checkSourceFidelity,
  cleanRoundTrip,
  comparePaths,
  detectGrammarTraps,
  GRAMMAR_TRAP_CODES,
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
// A whole document plus its field overlay, with room for a reasoning model's
// thinking tokens, which share this budget.
const MAX_OUTPUT_TOKENS = 24_000;
const MAX_ITERATIONS = 10;
const MODEL_REQUEST_TIMEOUT_MS = 240_000;

const SAVE_TEMPLATE_TOOL_NAME = "save_template";
const WRITE_DOCX_TOOL_NAME = "write_docx";
const ANSWER_SYNTAX_TOOL_NAME = "answer_syntax_questions";

const AUTHORING_SYSTEM_PROMPT = [
  "You are stella, a drafting assistant for lawyers. The user gives you a",
  "source document and asks for a reusable template. Mark the fillable",
  `values with {{markers}}, write the file with ${WRITE_DOCX_TOOL_NAME}, then`,
  `call ${SAVE_TEMPLATE_TOOL_NAME} once with the returned reference as`,
  "docx_base64, a name, and a fields overlay configuring every field. Keep",
  "the document's wording exactly as given; only replace the values that",
  "become fields. The two reference resources below are the complete",
  "grammar and configuration contract; follow them literally.",
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
// `{{#each}}` opener in a paragraph of its own inside the first cell.
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

// ── The production save_template definition ──────────────

const saveTemplateDefinition = () => {
  const definition = TEMPLATE_TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === SAVE_TEMPLATE_TOOL_NAME,
  );
  if (definition === undefined || !("inputSchemaSource" in definition)) {
    return panic(
      "save_template is not a valibot-defined tool in TEMPLATE_TOOL_DEFINITIONS",
    );
  }
  return definition;
};

const SAVE_TEMPLATE_DEFINITION = saveTemplateDefinition();

/**
 * The tool schema the model sees. `toTanStackToolSchema` gives the same
 * Standard Schema validation `fill_template`'s eval uses, but save_template's
 * input carries `check` / `partial_check` actions (the create-vs-configure
 * rules) that have no JSON Schema projection; the definition already declares
 * that waiver and derives the wire schema every MCP client is served, so the
 * projection is taken from there instead of re-derived.
 */
const saveTemplateToolSchema = () => {
  const schema = toTanStackToolSchema(
    SAVE_TEMPLATE_DEFINITION.inputSchemaSource,
  );
  const wireSchema = () => SAVE_TEMPLATE_DEFINITION.inputSchema;
  return {
    ...schema,
    "~standard": {
      ...schema["~standard"],
      jsonSchema: { input: wireSchema, output: wireSchema },
    },
  };
};

// ── In-memory save_template ──────────────────────────────

/**
 * `fillTemplateDocx` always resolves the org's registry-lookup settings, so
 * every fill needs a working `scopedDb`, not a throwing stub.
 */
const buildStubScopedDb = (): ScopedDb => {
  const run = (fn: (tx: unknown) => unknown) =>
    fn({
      query: { organizationSettings: { findFirst: () => undefined } },
    });
  // SAFETY: test double exposing only `organizationSettings.findFirst`, the
  // one surface `buildIsRegistryEnabledForOrg` touches.
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
      /** Field paths after the overlay is folded back into discovery: a
       *  lookup parent's named-format markers disappear here exactly as they
       *  do for a stored template. */
      resolvedPaths: string[];
      structureErrors: string[];
    };

type SaveCall = {
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

/**
 * The DB-free half of `createStoredTemplate`: everything from the base64
 * decode to the embedded manifest, in the same order, with the same
 * rejections. The DB insert, the S3 write and the per-org limit are the only
 * steps left out.
 */
const saveTemplateInMemory = async ({
  docxBase64,
  overlay,
}: {
  docxBase64: string;
  overlay: readonly FieldMeta[] | undefined;
}): Promise<SaveOutcome> => {
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

  const discovered = await discoverTemplate(buffer);
  const baseFields: FieldMeta[] = mergeManifestWithDiscovery(
    null,
    discovered,
  ).map((field) => ({
    path: field.path,
    label: field.label,
    hint: field.hint,
    inputType: field.inputType,
    options: field.options,
    validation: field.validation,
    required: field.required,
    aiPrompt: field.aiPrompt,
    aiAdapt: field.aiAdapt,
    aiSeesDocument: field.aiSeesDocument,
    parts: field.parts,
    format: field.format,
    optionsFrom: field.optionsFrom,
    lookup: field.lookup,
    formula: field.formula,
    condition: field.condition,
    conditionAst: field.conditionAst,
    dateFormat: field.dateFormat,
  }));

  const structureErrors = discovered.structureErrors.map(
    (error) => `${error.directive}: ${error.message}`,
  );

  let fields = baseFields;
  if (overlay !== undefined) {
    const known = new Set(baseFields.map((field) => field.path));
    const unknown = overlay.find((field) => !known.has(field.path));
    if (unknown) {
      return {
        status: "rejected",
        issues: [
          `No field "${unknown.path}" was discovered in the DOCX. ` +
            "Configure only paths that exist as {{markers}}.",
          ...structureErrors,
        ],
      };
    }
    const byPath = new Map(overlay.map((field) => [field.path, field]));
    const merged: FieldMeta[] = [];
    for (const field of baseFields) {
      const override = byPath.get(field.path);
      merged.push(override === undefined ? field : { ...field, ...override });
    }
    fields = merged;
  }

  const manifest: TemplateManifest = { version: 1, fields };
  const withManifest = await writeManifest(buffer, manifest);
  const resolvedPaths = mergeManifestWithDiscovery(manifest, discovered).map(
    (field) => field.path,
  );
  return {
    status: "saved",
    buffer: withManifest,
    manifest,
    resolvedPaths,
    structureErrors,
  };
};

// ── The round trip ───────────────────────────────────────

/**
 * A registry lookup would call a business registry and a `source` binding
 * needs a matter; neither belongs in a deterministic eval. Both are scored as
 * configuration, then stripped so the fill substitutes the fixed values the
 * task supplies for those markers.
 */
const neutralizeExternalSources = (
  manifest: TemplateManifest,
): TemplateManifest => ({
  version: manifest.version,
  fields: manifest.fields.map(
    ({ lookup: _lookup, source: _source, ...field }) => field,
  ),
});

type RoundTripResult = {
  defects: RoundTripDefects;
  text: string;
  error: string | null;
};

const runRoundTrip = async ({
  saved,
  task,
  organizationId,
}: {
  saved: Extract<SaveOutcome, { status: "saved" }>;
  task: EvalTask;
  organizationId: SafeId<"organization">;
}): Promise<RoundTripResult> => {
  const buffer = await writeManifest(
    saved.buffer,
    neutralizeExternalSources(saved.manifest),
  );
  const source: FillTemplateSource = {
    name: task.name,
    fileName: `${task.id}.docx`,
    buffer,
  };
  const filled = await fillTemplateDocx({
    source,
    values: { ...task.fillValues },
    scopedDb: buildStubScopedDb(),
    organizationId,
    requiredFields: "allow-partial",
  });
  if ("usageRejection" in filled || "requiredFieldsRejection" in filled) {
    return panic("allow-partial fill returned a rejection");
  }
  if ("error" in filled) {
    // The fill never rendered, so there is nothing to inspect; the caller
    // reports the rejection itself, which is what makes the run partial.
    return { defects: cleanRoundTrip(), text: "", error: filled.error };
  }
  const document = await readFilledDocument(filled.buffer);
  const leftoverMarkers = [...document.text.matchAll(/\{\{/gu)].length;
  return {
    defects: { ...task.checkRoundTrip(document), leftoverMarkers },
    text: document.text,
    error: null,
  };
};

// ── Tasks ─────────────────────────────────────────────────

type TaskRoundTripCheck = Omit<RoundTripDefects, "leftoverMarkers">;

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
    text: "Jan Kowalski, Prezes Zarządu / President of the Management Board",
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
      signatory_name: "Jan Kowalski",
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
      // Filled false on purpose: a penalty clause left outside an `{{#if}}`
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
      // The flag is false, so an `{{#if}}`-wrapped clause is gone; an
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
      // row-mode `{{#if}}` without removing the row.
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
      "- `property_address` ist ein zusammengesetztes Feld mit den Teilen",
      "  `street`, `postal_code` und `city`, zusammengefügt als",
      "  `{{street}}, {{postal_code}} {{city}}`.",
      "- `base_rent` ist eine Zahl (die monatliche Kaltmiete).",
      "- `annual_rent` wird aus `base_rent` berechnet: `base_rent * 12`.",
    ].join("\n"),
    expectedPaths: [
      "landlord_name",
      "tenant_name",
      "property_address",
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
      const address = fieldAt(fields, "property_address");
      const partKeys = new Set((address?.parts ?? []).map((part) => part.key));
      for (const key of ["street", "postal_code", "city"]) {
        if (!partKeys.has(key)) {
          defects.push(`property_address has no "${key}" part`);
        }
      }
      const format = address?.format ?? "";
      if (
        !["street", "postal_code", "city"].every((key) =>
          format.includes(`{{${key}}}`),
        )
      ) {
        defects.push("property_address format does not join all three parts");
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
      // The composite address and the derived annual rent must both render.
      blankRepeatedRows:
        (text.includes("Hauptstraße 14") ? 0 : 1) +
        (digitsOf(text).includes("15000") ? 0 : 1),
      conditionalRowKept: false,
      dateLocaleMismatch: false,
    }),
  },
];

// ── Syntax quiz ───────────────────────────────────────────

const SYNTAX_QUIZ_QUESTIONS = {
  each_closer: {
    question: "Which marker closes a `{{#each attorneys}}` block?",
    expected: "{{/each}}",
  },
  item_reference: {
    question:
      "Inside `{{#each attorneys}}`, which marker renders the current item's `name`?",
    expected: "{{attorneys.name}}",
  },
  this_prefix_supported: {
    question:
      "Is a `this.` prefix (`{{this.name}}`) a supported way to reference the current item? true or false.",
    expected: false,
  },
  first_item_reference: {
    question:
      "Outside any loop, which marker renders the FIRST attorney's `name`?",
    expected: "{{attorneys.0.name}}",
  },
  condition_for_tick_box: {
    question:
      "A person ticks a yes/no box that drives `{{#if penalty_applies}}`. Does `penalty_applies` need a `condition` in the fields overlay? true or false.",
    expected: false,
  },
  block_marker_own_paragraph: {
    question:
      "Must a block marker (`{{#each}}`, `{{#if}}`, `{{/each}}`, `{{/if}}`) occupy a paragraph of its own? true or false.",
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
    expected: "{{company.address}}",
  },
} as const;

type QuizKey = keyof typeof SYNTAX_QUIZ_QUESTIONS;

const SYNTAX_QUIZ_ANSWER_SCHEMA = v.strictObject({
  each_closer: v.string(),
  item_reference: v.string(),
  this_prefix_supported: v.boolean(),
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
  each_closer: SYNTAX_QUIZ_QUESTIONS.each_closer.expected,
  item_reference: SYNTAX_QUIZ_QUESTIONS.item_reference.expected,
  this_prefix_supported: SYNTAX_QUIZ_QUESTIONS.this_prefix_supported.expected,
  first_item_reference: SYNTAX_QUIZ_QUESTIONS.first_item_reference.expected,
  condition_for_tick_box: SYNTAX_QUIZ_QUESTIONS.condition_for_tick_box.expected,
  block_marker_own_paragraph:
    SYNTAX_QUIZ_QUESTIONS.block_marker_own_paragraph.expected,
  bilingual_same_path: SYNTAX_QUIZ_QUESTIONS.bilingual_same_path.expected,
  lookup_format_marker: SYNTAX_QUIZ_QUESTIONS.lookup_format_marker.expected,
};

const SYNTAX_QUIZ_PROMPT = [
  "Answer these eight questions about the stella template marker grammar by",
  `calling ${ANSWER_SYNTAX_TOOL_NAME} exactly once. Give each marker answer`,
  "as the complete marker including its braces.",
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

const WRITE_DOCX_DESCRIPTION =
  "Write the marked-up document to a .docx file and return a reference to " +
  "its bytes. This stands in for the DOCX writer an MCP client runs locally. " +
  "Pass `blocks` in document order, one entry per paragraph or per table; a " +
  "newline inside a table cell starts a new paragraph in that cell. Then " +
  `pass the returned reference as ${SAVE_TEMPLATE_TOOL_NAME}'s docx_base64: ` +
  "it expands to the file's base64 bytes at the boundary.";

type ToolTrace = { name: string; input: unknown };

const createAuthoringTools = ({
  trace,
  saveCalls,
}: {
  trace: ToolTrace[];
  saveCalls: SaveCall[];
}): AnyServerTool[] => {
  const written = new Map<string, Buffer>();

  const writeDocxTool = toolDefinition({
    name: WRITE_DOCX_TOOL_NAME,
    description: WRITE_DOCX_DESCRIPTION,
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        blocks: v.pipe(
          v.array(authoredBlockSchema),
          v.minLength(1),
          v.description("The document in order: paragraphs and tables."),
        ),
      }),
    ),
  }).server(async ({ blocks }) => {
    trace.push({ name: WRITE_DOCX_TOOL_NAME, input: { blocks } });
    const ref = `docx#${String(written.size + 1)}`;
    const authored: AuthoredBlock[] = blocks.map((block) =>
      block.type === "paragraph"
        ? { type: "paragraph", text: block.text }
        : { type: "table", rows: block.rows },
    );
    const buffer = await buildDocx(authored);
    written.set(ref, buffer);
    return { docx_ref: ref, bytes: buffer.byteLength };
  });

  const saveTemplateTool = toolDefinition({
    name: SAVE_TEMPLATE_TOOL_NAME,
    description: SAVE_TEMPLATE_DEFINITION.description,
    inputSchema: saveTemplateToolSchema(),
  }).server(async (input: unknown) => {
    trace.push({ name: SAVE_TEMPLATE_TOOL_NAME, input });
    const parsed = v.safeParse(
      SAVE_TEMPLATE_DEFINITION.inputSchemaSource,
      input,
    );
    if (!parsed.success) {
      const issues = validationIssues(parsed.issues);
      saveCalls.push({
        blocks: [],
        overlay: [],
        outcome: { status: "rejected", issues },
      });
      return { error: "validation_error", issues };
    }
    const overlay = parsed.output.fields?.map(toFieldMetaToolInput);
    const ref = parsed.output.docx_base64;
    if (ref === undefined) {
      const issues = [
        "docx_base64 is required: pass the reference write_docx returned",
      ];
      saveCalls.push({
        blocks: [],
        overlay: overlay ?? [],
        outcome: { status: "rejected", issues },
      });
      return { error: "validation_error", issues };
    }
    // A reference expands to the bytes write_docx wrote; anything else is
    // taken as real base64, so a client that does hold the file still works.
    const writtenDocx = written.get(ref.trim());
    const outcome = await saveTemplateInMemory({
      docxBase64: writtenDocx?.toString("base64") ?? ref,
      overlay,
    });
    saveCalls.push({
      // Traps are read off the document that was actually saved, not off the
      // write_docx input, so they describe the bytes the contract received.
      blocks:
        outcome.status === "saved" ? await readDocxBlocks(outcome.buffer) : [],
      overlay: overlay ?? [],
      outcome,
    });
    if (outcome.status === "invalid-docx") {
      return { error: "validation_error", issues: [outcome.reason] };
    }
    if (outcome.status === "rejected") {
      return { error: "validation_error", issues: outcome.issues };
    }
    return {
      templateId: "tpl-eval-1",
      name: parsed.output.name ?? "",
      fieldCount: outcome.manifest.fields.length,
    };
  });

  return [writeDocxTool, saveTemplateTool];
};

const createQuizTool = ({
  trace,
  answers,
}: {
  trace: ToolTrace[];
  answers: Record<string, unknown>[];
}): AnyServerTool[] => [
  toolDefinition({
    name: ANSWER_SYNTAX_TOOL_NAME,
    description:
      "Answer the eight marker-grammar questions. Every property is required.",
    inputSchema: toTanStackToolSchema(SYNTAX_QUIZ_ANSWER_SCHEMA),
  }).server(async (input) => {
    trace.push({ name: ANSWER_SYNTAX_TOOL_NAME, input });
    answers.push({ ...input });
    return await Promise.resolve({ received: true });
  }),
];

// ── CLI ───────────────────────────────────────────────────

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  jsonPath: string | null;
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: DEFAULT_MODELS,
    runs: DEFAULT_RUNS,
    taskFilter: null,
    jsonPath: null,
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
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
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
  task,
  organizationId,
}: {
  call: SaveCall;
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
        ...outcome.structureErrors,
        ...(roundTrip.error === null ? [] : [`fill: ${roundTrip.error}`]),
      ],
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
  const organizationId = mintAuthProviderId<"organization">();
  const trace: ToolTrace[] = [];
  const saveCalls: SaveCall[] = [];
  const tools = createAuthoringTools({ trace, saveCalls });
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
  const call = saveCalls.at(-1);
  if (call === undefined) {
    // A call the advertised schema rejected never reaches the handler; the
    // raw trace still proves the model tried, so it is scored as a rejection
    // rather than as no call at all.
    const raw = turn.rawCalls.filter(
      (entry) => entry.name === SAVE_TEMPLATE_TOOL_NAME,
    );
    const last = raw.at(-1);
    const parsed =
      last === undefined
        ? null
        : v.safeParse(SAVE_TEMPLATE_DEFINITION.inputSchemaSource, last.input);
    const attempt: SaveAttempt | null =
      parsed === null
        ? null
        : {
            status: "rejected",
            overlayIssues: parsed.success
              ? ["save_template call never reached the handler"]
              : validationIssues(parsed.issues),
          };
    return {
      modelId,
      taskId: task.id,
      repeat,
      score: scoreAuthoringRun({ turnError: turn.error, attempt }),
      calls: raw.length,
      quiz: null,
      latencyMs: turn.latencyMs,
      usage: turn.usage,
      finalText: turn.finalText,
      trace,
      renderedText: null,
    };
  }
  const { attempt, renderedText } = await buildAttempt({
    call,
    task,
    organizationId,
  });
  return {
    modelId,
    taskId: task.id,
    repeat,
    score: scoreAuthoringRun({ turnError: turn.error, attempt }),
    calls: saveCalls.length,
    quiz: null,
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
    trace,
    renderedText,
  };
};

const SYNTAX_QUIZ_TASK_ID = "syntax-quiz";

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
  const tools = createQuizTool({ trace, answers });
  const turn = await runModelTurn({
    model,
    prompt: SYNTAX_QUIZ_PROMPT,
    systemPrompt: QUIZ_SYSTEM_PROMPT,
    tools,
  });
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
    // Wrong answers ride in `missing`, the column that already means "the
    // contract asked for this and did not get it".
    paths: { missing: quiz.wrong, extra: [] },
    traps: detectGrammarTraps({
      blocks: [],
      overlay: [],
      booleanInputPaths: [],
    }),
    overlayIssues: [],
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
    calls: answers.length,
    quiz: { correct: quiz.correct, total: quiz.total },
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
    trace,
    renderedText: null,
  };
};

// ── Report ────────────────────────────────────────────────

const cell = (values: readonly string[]): string =>
  values.length === 0 ? "-" : values.join("; ").replaceAll("|", "\\|");

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
  ]);

const tokensCell = (usage: TokenUsage | null): string =>
  usage === null ? "-" : String(usage.totalTokens);

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = [];
  for (const modelId of new Set(runs.map((run) => run.modelId))) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| task | run | outcome | calls | missing | extra | traps | overlay | config | fidelity | round trip | tokens | ms |",
      "| --- | ---: | --- | ---: | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |",
    );
    for (const run of modelRuns) {
      const { score } = run;
      lines.push(
        [
          `| ${run.taskId}`,
          String(run.repeat),
          score.outcome,
          String(run.calls),
          cell(score.paths.missing),
          cell(score.paths.extra),
          trapsCell(score.traps),
          cell(score.overlayIssues),
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
    const quiz = modelRuns.find((run) => run.quiz !== null)?.quiz ?? null;
    const quizSummary =
      quiz === null
        ? ""
        : `, syntax quiz ${String(quiz.correct)}/${String(quiz.total)}`;
    lines.push(
      "",
      `passed ${String(passed)}/${String(modelRuns.length)}, grammar traps ${String(traps)}${quizSummary}`,
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

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
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

  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
