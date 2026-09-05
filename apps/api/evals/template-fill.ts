/**
 * fill_template eval: can a model fill a DOCX template correctly through the
 * production `fill_template` contract — read the field list from
 * `describe_template`, convert prose into the field paths and types the
 * manifest declares, and either fill or ask when a required fact is missing?
 *
 * Each task builds a fixture DOCX (a Custom XML manifest over `{{marker}}`,
 * `{{#if}}` and `{{#each}}` placeholders) in memory, then gives the model the
 * SAME tool name, description and input schema `fill_template` and
 * `describe_template` register in chat, backed by the DB-free
 * `fillTemplateDocx` service instead of a stored template. Scoring compares
 * the model's `values` payload against the manifest and the rendered text:
 *
 *   outcome         pass / fail / asked (a required fact was missing and the
 *                   model asked instead of inventing it) / no-call (no
 *                   fill_template call) / error (the provider refused)
 *   calls           fill_template calls in the turn
 *   requiredMissing required field paths absent from the last call's values
 *   typeErrors      a value that doesn't match its field's inputType (a date
 *                   not ISO YYYY-MM-DD, a select outside its options, a
 *                   number or boolean of the wrong JS type), or the fill
 *                   service rejecting the call outright (e.g. a malformed date)
 *   unmatched       result.unmatchedPlaceholders.length
 *   unused          result.unusedValues.length
 *   leftover        a literal `{{` left in the rendered text
 *   wrongValues     expected facts (party names, amounts, dates) missing
 *                   from the rendered text
 *   ms              latency
 *
 * Usage (from apps/api):
 *   bun run eval:template-fill
 *   bun run eval:template-fill -- --models gpt-5.6-luna --task cs-work-contract
 *   bun run eval:template-fill -- --runs 3 --json out.json
 */
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool, TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import JSZip from "jszip";
import { writeFile } from "node:fs/promises";
import * as v from "valibot";

import { formatDate } from "@stll/template-conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  DESCRIBE_TEMPLATE_DESCRIPTION,
  FILL_TEMPLATE_DESCRIPTION,
} from "@/api/handlers/chat/tools/template-tools";
import { resolveCaching } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { extractText } from "@/api/lib/docx/extract-text";
import { writeManifest } from "@/api/lib/docx/template-manifest";
import type { FieldMeta, TemplateManifest } from "@/api/lib/docx/types";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import {
  fillTemplateDocx,
  type FillTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { isFillableTemplateInputField } from "@/api/lib/templates/template-input-contract";
import type { MissingRequiredField } from "@/api/lib/templates/template-optional-defaults";
import { isTemplateFieldRequired } from "@/api/lib/templates/template-optional-defaults";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { runEvalModelTurn } from "./lib/model-turn";

// A bare id resolves through whichever configured provider rates it (GPT
// models may come from OpenAI or OpenRouter); Claude ids are pinned to
// Anthropic so a non-Anthropic default provider cannot claim them.
const DEFAULT_MODELS = ["gpt-5.6-luna", "anthropic::claude-sonnet-5"];
const DEFAULT_RUNS = 1;
const MAX_OUTPUT_TOKENS = 3000;
const MAX_ITERATIONS = 6;
const MODEL_REQUEST_TIMEOUT_MS = 180_000;

const DESCRIBE_TEMPLATE_TOOL_NAME = "describe_template" as const;
const FILL_TEMPLATE_TOOL_NAME = "fill_template" as const;

const SYSTEM_PROMPT = [
  "You are stella, a drafting assistant filling a document template for a",
  "lawyer. Exactly one template is available; its id is given below. Call",
  "describe_template first to learn its field paths, labels and input",
  "types, then call fill_template once with a `values` object mapping each",
  "field path to its value. An `{{#each arrayPath}}` field's item paths are",
  "listed dotted (`arrayPath.itemField`); supply `values.arrayPath` as an",
  "array of objects keyed by the item field names. Write date values as",
  "ISO 8601 (YYYY-MM-DD). Use only the exact strings offered for a select",
  "field. Never invent a value for a required field the user did not give",
  "you: ask a short question instead. Respond in the language the user",
  "wrote in.",
].join(" ");

// ── Fixture building ─────────────────────────────────────

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const WRAP = (paragraphs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.join("")}</w:body></w:document>`;

const P = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// Mirrors `makeDocx` in `apps/api/src/lib/docx/docx-integration.test.ts`: the
// minimal OPC package `fillTemplateDocx` needs (document part, content
// types, package relationship).
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
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

type TemplateFixture = {
  templateId: string;
  name: string;
  fileName: string;
  buffer: Buffer;
  manifest: TemplateManifest;
};

const buildFixture = async (
  templateId: string,
  name: string,
  paragraphs: readonly string[],
  manifest: TemplateManifest,
): Promise<TemplateFixture> => {
  const raw = await makeDocx(WRAP(paragraphs));
  const buffer = await writeManifest(raw, manifest);
  return { templateId, name, fileName: `${templateId}.docx`, buffer, manifest };
};

// ── describe_template, mirrored from `describeStoredTemplate`'s manifest
// branch in template-fill-service.ts ─────────────────────

type DescribedField = {
  path: string;
  label: string | null;
  inputType: string;
  required: boolean;
  hint: string | null;
  options: string[] | null;
  aiPrompt: string | null;
  aiAdapt: boolean;
  dateFormat: FieldMeta["dateFormat"] | null;
};

const describeManifest = (
  name: string,
  manifest: TemplateManifest,
): { name: string; fields: DescribedField[] } => ({
  name,
  fields: manifest.fields.filter(isFillableTemplateInputField).map((field) => ({
    path: field.path,
    label: field.label ?? null,
    inputType: field.inputType ?? "text",
    required: isTemplateFieldRequired(field),
    hint: field.hint ?? null,
    options: field.options ?? null,
    aiPrompt: field.aiPrompt ?? null,
    aiAdapt: field.aiAdapt ?? false,
    dateFormat: field.dateFormat ?? null,
  })),
});

// ── Fill tools over the in-memory fixture ────────────────

// `fillTemplateDocx` always resolves the org's registry-lookup settings
// (`buildIsRegistryEnabledForOrg`) once a manifest is present, even when no
// field declares a `lookup` — every fixture here needs a working
// `scopedDb`, not a throwing stub.
const buildStubScopedDb = (): ScopedDb => {
  const run = (fn: (tx: unknown) => unknown) =>
    fn({
      query: {
        organizationSettings: {
          findFirst: () => undefined,
        },
      },
    });
  // SAFETY: test double exposing only `organizationSettings.findFirst`,
  // the one surface `buildIsRegistryEnabledForOrg` touches.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- narrows a stub to the real ScopedDb signature
  return run as unknown as ScopedDb;
};

type FillCall = {
  templateId: string;
  values: Record<string, unknown>;
  result:
    | { text: string; unmatchedPlaceholders: string[]; unusedValues: string[] }
    | { error: string; missingFields?: MissingRequiredField[] };
};

// Matches the "Template not found." message `describeStoredTemplate` and
// `fillStoredTemplate` return for an unknown id, so a model that hallucinates
// a templateId sees the same rejection production would give it.
const TEMPLATE_NOT_FOUND = { error: "Template not found." } as const;

type ToolTrace = { name: string; input: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const createFixtureTools = ({
  fixture,
  organizationId,
  trace,
  fillCalls,
}: {
  fixture: TemplateFixture;
  organizationId: SafeId<"organization">;
  trace: ToolTrace[];
  fillCalls: FillCall[];
}): AnyServerTool[] => {
  const scopedDb = buildStubScopedDb();
  const source: FillTemplateSource = {
    name: fixture.name,
    fileName: fixture.fileName,
    buffer: fixture.buffer,
  };

  const describeTool = toolDefinition({
    name: DESCRIBE_TEMPLATE_TOOL_NAME,
    description: DESCRIBE_TEMPLATE_DESCRIPTION,
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        templateId: v.pipe(
          v.string(),
          v.description("Template id, as returned by list_templates."),
        ),
      }),
    ),
  }).server(async ({ templateId }) => {
    trace.push({ name: DESCRIBE_TEMPLATE_TOOL_NAME, input: { templateId } });
    if (templateId !== fixture.templateId) {
      return await Promise.resolve(TEMPLATE_NOT_FOUND);
    }
    return await Promise.resolve(
      describeManifest(fixture.name, fixture.manifest),
    );
  });

  const fillTool = toolDefinition({
    name: FILL_TEMPLATE_TOOL_NAME,
    description: FILL_TEMPLATE_DESCRIPTION,
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        templateId: v.pipe(
          v.string(),
          v.description("Template id, as returned by list_templates."),
        ),
        values: v.pipe(
          v.record(v.string(), v.unknown()),
          v.description("Map of field path to value."),
        ),
      }),
    ),
  }).server(async ({ templateId, values }) => {
    trace.push({
      name: FILL_TEMPLATE_TOOL_NAME,
      input: { templateId, values },
    });
    if (templateId !== fixture.templateId) {
      fillCalls.push({ templateId, values, result: TEMPLATE_NOT_FOUND });
      return TEMPLATE_NOT_FOUND;
    }
    const filled = await fillTemplateDocx({
      source,
      values,
      scopedDb,
      organizationId,
      requiredFields: "enforce",
    });
    if ("usageRejection" in filled) {
      // No usage check is configured for this call, so this branch is
      // unreachable; the union still carries it.
      return panic(
        "fillTemplateDocx returned a usage rejection without a usage check",
      );
    }
    if ("requiredFieldsRejection" in filled) {
      // The production gate: the model gets the exact missing fields back
      // and is expected to ask for them rather than guess.
      const result = {
        error: "missing_required_fields",
        missingFields: filled.requiredFieldsRejection,
      };
      fillCalls.push({ templateId, values, result });
      return result;
    }
    if ("error" in filled) {
      const result = { error: filled.error };
      fillCalls.push({ templateId, values, result });
      return result;
    }
    const { paragraphs } = await extractText(filled.buffer);
    const result = {
      text: paragraphs
        .map((paragraph) => paragraph.text)
        .join("\n")
        .trim(),
      unmatchedPlaceholders: filled.unmatchedPlaceholders,
      unusedValues: filled.unusedValues,
    };
    fillCalls.push({ templateId, values, result });
    return result;
  });

  return [describeTool, fillTool];
};

// ── Tasks ─────────────────────────────────────────────────

const GOVERNING_LAW_OPTIONS = [
  "England and Wales",
  "Czech Republic",
  "New York",
];

const CONFIDENTIALITY_FIELDS: FieldMeta[] = [
  {
    path: "party_a_name",
    label: "Party A name",
    inputType: "text",
    required: true,
  },
  {
    path: "party_b_name",
    label: "Party B name",
    inputType: "text",
    required: true,
  },
  {
    path: "effective_date",
    label: "Effective date",
    inputType: "date",
    required: true,
  },
  {
    path: "governing_law",
    label: "Governing law",
    inputType: "select",
    options: GOVERNING_LAW_OPTIONS,
    required: true,
  },
  {
    path: "break_fee",
    label: "Break fee (USD)",
    inputType: "number",
    required: true,
  },
];

const CONFIDENTIALITY_MANIFEST: TemplateManifest = {
  version: 1,
  fields: CONFIDENTIALITY_FIELDS,
};

const CONFIDENTIALITY_PARAGRAPHS = [
  P("CONFIDENTIALITY AGREEMENT"),
  P(
    'This Confidentiality Agreement is made between {{party_a_name}} ("Party A") ' +
      'and {{party_b_name}} ("Party B"), effective {{effective_date}}.',
  ),
  P("This Agreement is governed by the laws of {{governing_law}}."),
  P(
    "Party A shall pay Party B a break fee of {{break_fee}} if either party " +
      "withdraws before signing.",
  ),
];

const TYP_DILA_OPTIONS = ["Stavební práce", "Rekonstrukce", "Instalace"];
const TERMIN_DATE_FORMAT = { locale: "cs", style: "long" as const };

const WORK_CONTRACT_FIELDS: FieldMeta[] = [
  {
    path: "objednatel",
    label: "Objednatel",
    inputType: "text",
    required: true,
  },
  {
    path: "zhotovitel",
    label: "Zhotovitel",
    inputType: "text",
    required: true,
  },
  {
    path: "cena",
    label: "Cena díla (Kč)",
    inputType: "number",
    required: true,
  },
  {
    path: "termin",
    label: "Termín dokončení",
    inputType: "date",
    required: true,
    dateFormat: TERMIN_DATE_FORMAT,
  },
  {
    path: "typ_dila",
    label: "Typ díla",
    inputType: "select",
    options: TYP_DILA_OPTIONS,
    required: true,
  },
];

const WORK_CONTRACT_MANIFEST: TemplateManifest = {
  version: 1,
  fields: WORK_CONTRACT_FIELDS,
};

const WORK_CONTRACT_PARAGRAPHS = [
  P("SMLOUVA O DÍLO"),
  P("Objednatel: {{objednatel}}"),
  P("Zhotovitel: {{zhotovitel}}"),
  P("Zhotovitel provede dílo typu {{typ_dila}} za cenu {{cena}} Kč."),
  P("Dílo bude dokončeno do {{termin}}."),
];

const SOW_FIELDS: FieldMeta[] = [
  { path: "client_name", label: "Client", inputType: "text", required: true },
  { path: "deliverables.name", label: "Deliverable name", inputType: "text" },
  { path: "deliverables.due_date", label: "Due date", inputType: "date" },
  {
    path: "rush_fee_applies",
    label: "Rush fee applies",
    inputType: "boolean",
    required: false,
  },
];

const SOW_MANIFEST: TemplateManifest = { version: 1, fields: SOW_FIELDS };

const SOW_PARAGRAPHS = [
  P("STATEMENT OF WORK"),
  P("Statement of Work for {{client_name}}."),
  P("{{#each deliverables}}"),
  P("- {{deliverables.name}} (due {{deliverables.due_date}})"),
  P("{{/each}}"),
  P("{{#if rush_fee_applies}}A rush fee applies to this engagement.{{/if}}"),
];

// Kept as name/date pairs (not two flat lists) so scoring can check each
// deliverable against its own due date instead of independent membership,
// which would still pass a model that swaps two dates.
const SOW_DELIVERABLES: readonly { name: string; dueDate: string }[] = [
  { name: "Site survey", dueDate: "2026-10-01" },
  { name: "Equipment install", dueDate: "2026-10-15" },
  { name: "Final handover", dueDate: "2026-11-01" },
];

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);

const isOneOf = (value: unknown, options: readonly string[]): boolean =>
  typeof value === "string" &&
  options.some((option) => option.toLowerCase() === value.trim().toLowerCase());

const normalizeDigits = (text: string): string =>
  text.replaceAll(/[^\d]/gu, "");

const textContainsDigits = (text: string, digits: string): boolean =>
  normalizeDigits(text).includes(digits);

const hasValue = (values: Record<string, unknown>, path: string): boolean => {
  const value = values[path];
  return (
    value !== undefined &&
    value !== null &&
    !(typeof value === "string" && value.trim() === "")
  );
};

type EvalTask = {
  id: string;
  fixture: TemplateFixture;
  prompt: string;
  /** `"ask"` tasks omit a required fact on purpose; the ideal response is a
   *  question, not a fill_template call inventing the missing value. */
  mode: "fill" | "ask";
  requiredPaths: readonly string[];
  /** Field path the prompt deliberately omits, for `mode: "ask"` tasks. */
  omittedPath?: string;
  checkTypeErrors: (values: Record<string, unknown>) => string[];
  checkWrongValues: (text: string, values: Record<string, unknown>) => string[];
};

const buildTasks = async (): Promise<EvalTask[]> => {
  const confidentiality = await buildFixture(
    "confidentiality-agreement",
    "Confidentiality Agreement",
    CONFIDENTIALITY_PARAGRAPHS,
    CONFIDENTIALITY_MANIFEST,
  );
  const workContract = await buildFixture(
    "smlouva-o-dilo",
    "Smlouva o dílo",
    WORK_CONTRACT_PARAGRAPHS,
    WORK_CONTRACT_MANIFEST,
  );
  const sow = await buildFixture(
    "statement-of-work",
    "Statement of Work",
    SOW_PARAGRAPHS,
    SOW_MANIFEST,
  );

  const expectedTermin = formatDate("2027-06-30", TERMIN_DATE_FORMAT);

  return [
    {
      id: "en-confidentiality",
      fixture: confidentiality,
      mode: "fill",
      requiredPaths: [
        "party_a_name",
        "party_b_name",
        "effective_date",
        "governing_law",
        "break_fee",
      ],
      prompt:
        "Draft-fill a confidentiality agreement between Northwind Trading " +
        "Ltd and Solace Analytics Inc, effective June 8, 2026. Governing " +
        "law: England and Wales. Break fee is $45,000 if either party " +
        "withdraws before signing.",
      checkTypeErrors: (values) => {
        const errors: string[] = [];
        if (
          values["effective_date"] !== undefined &&
          !isIsoDate(values["effective_date"])
        ) {
          errors.push("effective_date not ISO (YYYY-MM-DD)");
        }
        if (
          values["break_fee"] !== undefined &&
          typeof values["break_fee"] !== "number"
        ) {
          errors.push("break_fee not a number");
        }
        if (
          values["governing_law"] !== undefined &&
          !isOneOf(values["governing_law"], GOVERNING_LAW_OPTIONS)
        ) {
          errors.push("governing_law not in options");
        }
        return errors;
      },
      checkWrongValues: (text) => {
        const missing: string[] = [];
        if (!text.includes("Northwind Trading Ltd")) {
          missing.push("party A name");
        }
        if (!text.includes("Solace Analytics Inc")) {
          missing.push("party B name");
        }
        if (!text.includes("England and Wales")) {
          missing.push("governing law");
        }
        if (!textContainsDigits(text, "45000")) {
          missing.push("break fee amount");
        }
        if (!text.includes("2026-06-08")) {
          missing.push("effective date (no dateFormat set: expected raw ISO)");
        }
        return missing;
      },
    },
    {
      id: "cs-smlouva-o-dilo",
      fixture: workContract,
      mode: "fill",
      requiredPaths: ["objednatel", "zhotovitel", "cena", "termin", "typ_dila"],
      prompt:
        "Připrav smlouvu o dílo. Objednatel je Jana Nováková, zhotovitel " +
        "je Stavby Novák s.r.o. Cena díla je 250 000 Kč. Termín dokončení " +
        "je 30. 6. 2027. Typ díla: rekonstrukce.",
      checkTypeErrors: (values) => {
        const errors: string[] = [];
        if (values["termin"] !== undefined && !isIsoDate(values["termin"])) {
          errors.push("termin not ISO (YYYY-MM-DD)");
        }
        if (
          values["cena"] !== undefined &&
          typeof values["cena"] !== "number"
        ) {
          errors.push("cena not a number");
        }
        if (
          values["typ_dila"] !== undefined &&
          !isOneOf(values["typ_dila"], TYP_DILA_OPTIONS)
        ) {
          errors.push("typ_dila not in options");
        }
        return errors;
      },
      checkWrongValues: (text, values) => {
        const missing: string[] = [];
        if (!text.includes("Jana Nováková")) {
          missing.push("objednatel name");
        }
        if (!text.includes("Stavby Novák")) {
          missing.push("zhotovitel name");
        }
        if (!textContainsDigits(text, "250000")) {
          missing.push("cena amount");
        }
        if (!text.toLowerCase().includes("rekonstrukce")) {
          missing.push("typ_dila value");
        }
        if (values["termin"] !== undefined) {
          if (values["termin"] !== "2027-06-30") {
            missing.push(
              `termin value ${JSON.stringify(values["termin"])} does not match the completion date 2027-06-30`,
            );
          } else if (
            expectedTermin !== null &&
            !text.includes(expectedTermin)
          ) {
            missing.push(`termin rendered as "${expectedTermin}"`);
          }
        }
        return missing;
      },
    },
    {
      id: "missing-required-field",
      fixture: confidentiality,
      mode: "ask",
      requiredPaths: [
        "party_a_name",
        "party_b_name",
        "effective_date",
        "governing_law",
        "break_fee",
      ],
      omittedPath: "governing_law",
      prompt:
        "Draft-fill a confidentiality agreement between Umbra Robotics LLC " +
        "and Petrichor Systems Inc, effective 2026-11-01. Break fee is " +
        "$20,000 if either party withdraws before signing.",
      checkTypeErrors: () => [],
      checkWrongValues: () => [],
    },
    {
      id: "each-and-conditional",
      fixture: sow,
      mode: "fill",
      requiredPaths: ["client_name"],
      prompt:
        "Prepare a statement of work for client Riverside Logistics a.s. " +
        "Deliverables: Site survey due 2026-10-01, Equipment install due " +
        "2026-10-15, Final handover due 2026-11-01. This is a rush job, " +
        "so the rush fee applies.",
      checkTypeErrors: (values) => {
        const errors: string[] = [];
        if (
          values["client_name"] !== undefined &&
          typeof values["client_name"] !== "string"
        ) {
          errors.push("client_name not a string");
        }
        const deliverables = values["deliverables"];
        if (deliverables !== undefined) {
          if (!Array.isArray(deliverables) || deliverables.length === 0) {
            errors.push("deliverables not a non-empty array");
          } else {
            for (const [index, row] of deliverables.entries()) {
              if (!isRecord(row)) {
                errors.push(`deliverables[${String(index)}] not an object`);
                continue;
              }
              if (typeof row["name"] !== "string") {
                errors.push(`deliverables[${String(index)}].name not a string`);
              }
              if (!isIsoDate(row["due_date"])) {
                errors.push(`deliverables[${String(index)}].due_date not ISO`);
              }
            }
          }
        }
        if (
          values["rush_fee_applies"] !== undefined &&
          typeof values["rush_fee_applies"] !== "boolean"
        ) {
          errors.push("rush_fee_applies not a boolean");
        }
        return errors;
      },
      checkWrongValues: (text) => {
        const missing: string[] = [];
        if (!text.includes("Riverside Logistics")) {
          missing.push("client name");
        }
        // Check each deliverable together with its own due date (the
        // rendered "- name (due date)" pair), not as two independent lists:
        // independent membership checks would still pass a model that
        // renders every name and date but swaps which date goes with which
        // deliverable.
        for (const { name, dueDate } of SOW_DELIVERABLES) {
          if (!text.includes(`${name} (due ${dueDate})`)) {
            missing.push(`${name} due ${dueDate}`);
          }
        }
        // The prompt states the rush fee applies, so the clause is required
        // regardless of what the model submitted for rush_fee_applies (an
        // omitted or falsely-`false` value must still be reported as wrong).
        if (!text.toLowerCase().includes("rush fee")) {
          missing.push("rush fee clause (prompt states the rush fee applies)");
        }
        return missing;
      },
    },
  ];
};

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
        options.runs = Math.max(1, Number.parseInt(value, 10) || DEFAULT_RUNS);
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
};

const runModelTurn = async ({
  model,
  task,
}: {
  model: ResolvedTanStackTextModel;
  task: EvalTask;
}): Promise<{ turn: ModelTurn; trace: ToolTrace[]; fillCalls: FillCall[] }> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "fast",
    scopeKey: null,
  });
  const organizationId = mintAuthProviderId<"organization">();
  const trace: ToolTrace[] = [];
  const fillCalls: FillCall[] = [];
  const tools = createFixtureTools({
    fixture: task.fixture,
    organizationId,
    trace,
    fillCalls,
  });
  const system = `${SYSTEM_PROMPT}\nTemplate id: ${task.fixture.templateId}`;
  let finalText = "";
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: task.prompt }],
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
      }
    },
  });
  return {
    turn: { error, finalText, latencyMs, usage },
    trace,
    fillCalls,
  };
};

// ── Scoring ───────────────────────────────────────────────

// The model asked for the missing fact rather than guessing it — a literal
// question mark, or an imperative request phrased without one ("please
// choose / specify / confirm / provide / let me know / which / what").
const ASK_PATTERN =
  /\?|\b(?:please (?:choose|confirm|let me know|provide|select|specify|tell)|which (?:one|option|value)|what (?:value|governing law))\b/iu;

type RunScore = {
  outcome: "pass" | "fail" | "asked" | "no-call" | "error";
  calls: number;
  requiredMissing: string[];
  typeErrors: string[];
  unmatched: number;
  unused: number;
  leftover: boolean;
  wrongValues: string[];
};

const scoreRun = (
  task: EvalTask,
  turn: ModelTurn,
  fillCalls: readonly FillCall[],
  trace: readonly ToolTrace[],
): RunScore => {
  const base = {
    calls: fillCalls.length,
    requiredMissing: [] as string[],
    typeErrors: [] as string[],
    unmatched: 0,
    unused: 0,
    leftover: false,
    wrongValues: [] as string[],
  };

  if (turn.error !== null) {
    return { ...base, outcome: "error", typeErrors: [turn.error] };
  }

  if (task.mode === "ask") {
    if (fillCalls.length === 0) {
      return {
        ...base,
        outcome: ASK_PATTERN.test(turn.finalText) ? "asked" : "no-call",
      };
    }
    const last =
      fillCalls.at(-1) ?? panic("fillCalls non-empty but at(-1) missing");
    const invented =
      task.omittedPath !== undefined && hasValue(last.values, task.omittedPath);
    return {
      ...base,
      outcome: "fail",
      typeErrors: invented
        ? [`invented a value for omitted field "${String(task.omittedPath)}"`]
        : ["filled without the omitted field, instead of asking"],
    };
  }

  if (fillCalls.length === 0) {
    return { ...base, outcome: "no-call" };
  }
  if (fillCalls.length > 1) {
    return {
      ...base,
      outcome: "fail",
      typeErrors: [
        `fill_template called ${String(fillCalls.length)} times, expected exactly one`,
      ],
    };
  }
  const last =
    fillCalls.at(0) ?? panic("fillCalls non-empty but at(0) missing");
  if (last.templateId !== task.fixture.templateId) {
    return {
      ...base,
      outcome: "fail",
      typeErrors: [
        `fill_template called with templateId "${last.templateId}" instead of "${task.fixture.templateId}"`,
      ],
    };
  }
  if ("error" in last.result) {
    return {
      ...base,
      outcome: "fail",
      typeErrors: [`fill rejected: ${last.result.error}`],
    };
  }

  const requiredMissing = task.requiredPaths.filter(
    (path) => !hasValue(last.values, path),
  );
  // `describe_template` must precede the fill call, not merely appear
  // somewhere in the trace: a model that fills first and describes
  // afterward never learned the field contract before acting.
  const fillTraceIndex = trace.findIndex(
    (call) => call.name === FILL_TEMPLATE_TOOL_NAME,
  );
  const describeTraceIndex = trace.findIndex(
    (call) => call.name === DESCRIBE_TEMPLATE_TOOL_NAME,
  );
  const skippedDescribe =
    describeTraceIndex === -1 ||
    (fillTraceIndex !== -1 && describeTraceIndex > fillTraceIndex);
  const typeErrors = task.checkTypeErrors(last.values);
  if (skippedDescribe) {
    typeErrors.push(
      "filled without calling describe_template first, instead of learning the field contract",
    );
  }
  const wrongValues = task.checkWrongValues(last.result.text, last.values);
  const leftover = last.result.text.includes("{{");
  const outcome: RunScore["outcome"] =
    requiredMissing.length === 0 &&
    typeErrors.length === 0 &&
    wrongValues.length === 0 &&
    !leftover
      ? "pass"
      : "fail";

  return {
    ...base,
    outcome,
    requiredMissing,
    typeErrors,
    unmatched: last.result.unmatchedPlaceholders.length,
    unused: last.result.unusedValues.length,
    leftover,
    wrongValues,
  };
};

type EvalRun = {
  modelId: string;
  taskId: string;
  repeat: number;
  score: RunScore;
  latencyMs: number;
  usage: TokenUsage | null;
  finalText: string;
  values: Record<string, unknown>[];
  renderedText: string | null;
};

const runTask = async ({
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
  const { turn, trace, fillCalls } = await runModelTurn({ model, task });
  const score = scoreRun(task, turn, fillCalls, trace);
  const last = fillCalls.at(-1);
  return {
    modelId,
    taskId: task.id,
    repeat,
    score,
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
    values: fillCalls.map((call) => call.values),
    renderedText:
      last !== undefined && "text" in last.result ? last.result.text : null,
  };
};

// ── Report ────────────────────────────────────────────────

const countsText = (values: readonly string[]): string =>
  values.length === 0 ? "-" : values.join("; ").replaceAll("|", "\\|");

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = [];
  const modelIds = [...new Set(runs.map((run) => run.modelId))];
  for (const modelId of modelIds) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| task | run | outcome | calls | required missing | type errors | unmatched | unused | leftover | wrong values | ms |",
      "| --- | ---: | --- | ---: | --- | --- | ---: | ---: | --- | --- | ---: |",
    );
    for (const run of modelRuns) {
      const { score } = run;
      lines.push(
        [
          `| ${run.taskId}`,
          String(run.repeat),
          score.outcome,
          String(score.calls),
          countsText(score.requiredMissing),
          countsText(score.typeErrors),
          String(score.unmatched),
          String(score.unused),
          score.leftover ? "yes" : "-",
          countsText(score.wrongValues),
          `${String(run.latencyMs)} |`,
        ].join(" | "),
      );
    }
    const total = modelRuns.length;
    const passed = modelRuns.filter(
      (run) => run.score.outcome === "pass",
    ).length;
    const asked = modelRuns.filter(
      (run) => run.score.outcome === "asked",
    ).length;
    lines.push(
      "",
      `passed ${String(passed)}/${String(total)}, asked instead of inventing ${String(asked)}`,
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
  const allTasks = await buildTasks();
  const tasks = allTasks.filter(
    (task) => options.taskFilter === null || task.id === options.taskFilter,
  );
  if (tasks.length === 0) {
    panic(`Unknown task ${String(options.taskFilter)}`);
  }
  const models = await resolveModels(options.models);
  const runs: EvalRun[] = [];
  for (const { id, model } of models) {
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(`${id} · ${task.id} · run ${String(repeat)}\n`);
        runs.push(await runTask({ model, modelId: id, task, repeat }));
      }
    }
  }

  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
