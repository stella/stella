/**
 * Structured-extraction eval: does the production workflow AI extraction
 * path (`generateWorkflowData`) pull the right values out of a document, and
 * does it hallucinate an answer for a field the document never states?
 *
 * Each task is a fixture document plus a set of extractable properties
 * (text, date, int, single-select, multi-select) with known ground truth,
 * including one property whose answer is genuinely absent from the text.
 * The script calls `generateWorkflowData` directly with `extracted-text`
 * input (no DB, no S3, no DOCX/PDF parsing) and the exact same
 * `validateAIOutput` the production batch pipeline runs on the result, then
 * scores each field:
 *
 *   outcome           pass (every field correct) / fail (at least one field
 *                     wrong, hallucinated, missing, or a schema violation) /
 *                     error (the provider or model resolution failed)
 *   correct           fields matching ground truth after normalization
 *                     (trim/case-fold for text, ISO compare for date,
 *                     numeric compare for int, set compare for multi-select)
 *   wrong             fields with a non-matching non-null answer
 *   hallucinated      non-null answer where the ground truth is null
 *   missing           null answer where the ground truth is non-null
 *   schemaViolations  answers `validateAIOutput` rejected
 *
 * `generateWorkflowData` always resolves its model through the "pdf" model
 * role (`streamTanStackObjectForRole({ role: "pdf", ... })`); it exposes no
 * per-call model id. The only lever it takes is `orgAIConfig`, which pins a
 * BYOK model per role (`overrideModels.pdf`) — the same mechanism org
 * settings use to choose a model. `--models` builds one such config per
 * requested model id and runs the role through it, so model selection here
 * rides an existing production seam rather than a test-only hook.
 *
 * No dev stack needed; models resolve from instance credentials (.env).
 *
 * Usage (from apps/api):
 *   bun run eval:extraction
 *   bun run eval:extraction -- --models gpt-5.4-mini,anthropic::claude-sonnet-5
 *   bun run eval:extraction -- --runs 3 --task de-lease --json out.json
 *
 * Model ids use `provider::modelId` (BYOK direct) or a bare id, which
 * resolves to whichever configured provider offers it — directly, or
 * (for an OpenAI id without OPENAI_API_KEY) routed through OpenRouter.
 */
import { panic, Result } from "better-result";
import { writeFile } from "node:fs/promises";

import { BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";
import type { BYOKProvider, ModelRole } from "@stll/ai-catalog";

import type {
  AiExtractablePropertyContent,
  AIModelTool,
} from "@/api/db/schema-validators";
import { env } from "@/api/env";
import type { OrgAIConfig, OrgAIModelSelection } from "@/api/lib/ai-config";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import type { Answer } from "@/api/lib/workflow/ai-prompts";
import { validateAIOutput } from "@/api/lib/workflow/ai-validators";
import type { ValidatedResult } from "@/api/lib/workflow/ai-validators";
import type { PreparedExtractedTextFile } from "@/api/lib/workflow/generate-batch";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

// Same comment as `evals/suggest-changes-precision.ts`: a bare id resolves
// through whichever configured provider rates it (GPT models may come from
// OpenAI or OpenRouter); Claude ids are pinned to Anthropic so a
// non-Anthropic default provider cannot claim them.
const DEFAULT_MODELS = ["gpt-5.4-mini", "anthropic::claude-sonnet-5"];
const DEFAULT_RUNS = 1;
const MODEL_REQUEST_TIMEOUT_MS = 120_000;

// --------------- Fixtures ---------------

const CS_PURCHASE_FIXTURE = `KUPNÍ SMLOUVA

uzavřená mezi:

Ing. Tomáš Procházka, nar.: 15.03.1978, r.č.: 780315/1234,
trvale bytem Lipová 42, 110 00 Praha 1,
(dále jen „Prodávající")

a

ABC Development s.r.o., IČO: 12345678, DIČ: CZ12345678,
se sídlem Václavské náměstí 15, 110 00 Praha 1,
zastoupena: JUDr. Marie Dvořáková, Ph.D., jednající jako jednatel,
(dále jen „Kupující")

Článek I.
Předmět smlouvy

Prodávající prodává Kupujícímu nemovitost zapsanou na LV č. 567
v k.ú. Praha 1, a to za kupní cenu 4 500 000 Kč.

Kupní cena bude uhrazena na účet Prodávajícího č.ú.: 123456789/0100,
IBAN: CZ65 0100 0000 0012 3456 7890.

Článek II.
Kontaktní údaje

Prodávající: email tomas.prochazka@email.cz, tel. +420 777 123 456
Kupující: email dvorakova@abcdev.cz, tel. +420 602 987 654

Článek III.

Tato smlouva nabývá platnosti dnem podpisu obou smluvních stran.

V Praze dne 1. března 2025

___________________________          ___________________________
Ing. Tomáš Procházka                JUDr. Marie Dvořáková, Ph.D.
Prodávající                          za Kupujícího`;

const DE_LEASE_FIXTURE = `MIETVERTRAG

geschlossen zwischen:

Dr. med. Heinrich Schäfer, geboren am 22.06.1965,
wohnhaft in Mozartstraße 18, 80336 München,
Steuernummer: 143/241/12345,
(nachfolgend „der Vermieter")

und

Müller & Partner GmbH, eingetragen im Handelsregister: HRB 123456,
Geschäftsführer: Mag. Anna Bauer,
Kontonummer: DE89 3704 0044 0532 0130 00,
(im Folgenden „der Mieter")

§ 1 Mietgegenstand

Der Vermieter vermietet dem Mieter die Büroräume in der
Mozartstraße 18, 3. OG, 80336 München, bestehend aus 120 m²
Nutzfläche.

§ 2 Mietzins

Die monatliche Miete beträgt 2.500,00 EUR zzgl. Nebenkosten.
Die Miete ist bis zum 3. Werktag eines jeden Monats auf das
Konto des Vermieters zu überweisen:

IBAN: DE89 3704 0044 0532 0130 00
BIC: COBADEFFXXX

§ 3 Kontaktdaten

Vermieter: h.schaefer@praxis-muenchen.de, Tel. +49 89 1234567
Mieter: a.bauer@mueller-partner.de, Tel. +49 172 9876543

München, den 15. Januar 2025

___________________________          ___________________________
Dr. med. Heinrich Schäfer            Mag. Anna Bauer
Vermieter                            für Müller & Partner GmbH`;

const EN_SERVICES_FIXTURE = `CONSULTING SERVICES AGREEMENT

This Consulting Services Agreement ("Agreement") is entered into as of
April 1, 2025 (the "Effective Date") between:

Northbridge Analytics Ltd, a company registered in England and Wales with
company number 09876543, having its registered office at 14 Exchange
Square, London EC2A 2BR ("Client")

and

Solventra Consulting LLC, a limited liability company organized under the
laws of Delaware, having its principal place of business at 500 Market
Street, Wilmington, DE 19801 ("Consultant").

1. Services
Consultant shall provide the Client with data analytics, financial
modeling, and market research services (collectively, the "Services") as
described in the applicable statement of work.

2. Term
This Agreement shall commence on the Effective Date and shall continue
for an initial term of 18 months, unless earlier terminated in
accordance with Section 5.

3. Fees
Client shall pay Consultant a fixed monthly fee of USD 12,000, payable
within 15 days of receipt of Consultant's invoice.

4. Governing Law
This Agreement shall be governed by and construed in accordance with the
laws of the State of Delaware.

5. Termination
Either party may terminate this Agreement for convenience upon 60 days'
prior written notice to the other party.

6. Confidentiality
Each party shall keep confidential all non-public information disclosed
by the other party in connection with this Agreement.

IN WITNESS WHEREOF, the parties have executed this Agreement as of the
Effective Date.

Northbridge Analytics Ltd                    Solventra Consulting LLC
By: _______________________                  By: _______________________
Name: Rebecca Hartley                         Name: Marcus Webb
Title: Chief Operating Officer                Title: Managing Partner`;

// --------------- Property fixtures ---------------

type ExpectedAnswer =
  | { kind: "text"; value: string }
  | { kind: "date"; value: string | null }
  | { kind: "int"; amount: number; currency: string | null }
  | { kind: "single-select"; value: string | null }
  | { kind: "multi-select"; value: string[] };

type PropertyFixture = {
  key: string;
  prompt: string;
  content: AiExtractablePropertyContent;
  expected: ExpectedAnswer;
};

const textContent = (): AiExtractablePropertyContent => ({
  version: 1,
  type: "text",
});

const dateContent = (): AiExtractablePropertyContent => ({
  version: 1,
  type: "date",
});

const intContent = (): AiExtractablePropertyContent => ({
  version: 1,
  type: "int",
});

const selectContent = (
  type: "single-select" | "multi-select",
  options: readonly string[],
): AiExtractablePropertyContent => ({
  version: 1,
  type,
  options: options.map((value) => ({ color: "blue", value })),
  fallback: null,
});

const CS_PURCHASE_PROPERTIES: readonly PropertyFixture[] = [
  {
    key: "seller_name",
    prompt: "What is the seller's (Prodávající) full name, including title?",
    content: textContent(),
    expected: { kind: "text", value: "Ing. Tomáš Procházka" },
  },
  {
    key: "ico",
    prompt: "What is the buyer's IČO (Czech company identification number)?",
    content: intContent(),
    expected: { kind: "int", amount: 12_345_678, currency: null },
  },
  {
    key: "purchase_price",
    prompt: "What is the purchase price of the property, and in what currency?",
    content: intContent(),
    expected: { kind: "int", amount: 4_500_000, currency: "CZK" },
  },
  {
    key: "contract_date",
    prompt: "On what date does the agreement take effect?",
    content: dateContent(),
    expected: { kind: "date", value: "2025-03-01" },
  },
  {
    key: "contract_type",
    prompt: "What type of contract is this?",
    content: selectContent("single-select", [
      "Purchase Agreement",
      "Lease Agreement",
      "Services Agreement",
      "Employment Contract",
    ]),
    expected: { kind: "single-select", value: "Purchase Agreement" },
  },
  {
    key: "contact_channels",
    prompt: "Which contact channels does the agreement list for the parties?",
    content: selectContent("multi-select", [
      "Email",
      "Phone",
      "Postal mail",
      "Fax",
    ]),
    expected: { kind: "multi-select", value: ["Email", "Phone"] },
  },
  {
    key: "financing_type",
    prompt:
      "How is the purchase financed: cash, mortgage, seller financing, or lease-to-own?",
    content: selectContent("single-select", [
      "Cash",
      "Mortgage",
      "Seller financing",
      "Lease-to-own",
    ]),
    // Not stated anywhere in the document.
    expected: { kind: "single-select", value: null },
  },
];

const DE_LEASE_PROPERTIES: readonly PropertyFixture[] = [
  {
    key: "landlord_name",
    prompt: "What is the landlord's (Vermieter) full name, including title?",
    content: textContent(),
    expected: { kind: "text", value: "Dr. med. Heinrich Schäfer" },
  },
  {
    key: "tenant_name",
    prompt: "What is the tenant's (Mieter) full legal name?",
    content: textContent(),
    expected: { kind: "text", value: "Müller & Partner GmbH" },
  },
  {
    key: "monthly_rent",
    prompt: "What is the monthly rent (Mietzins), and in what currency?",
    content: intContent(),
    expected: { kind: "int", amount: 2500, currency: "EUR" },
  },
  {
    key: "lease_start_date",
    prompt: "What date is the lease agreement signed / dated?",
    content: dateContent(),
    expected: { kind: "date", value: "2025-01-15" },
  },
  {
    key: "property_type",
    prompt: "What type of premises is being leased?",
    content: selectContent("single-select", [
      "Office",
      "Residential apartment",
      "Retail",
      "Warehouse",
    ]),
    expected: { kind: "single-select", value: "Office" },
  },
  {
    key: "payment_details_provided",
    prompt: "Which bank payment details are given for the rent transfer?",
    content: selectContent("multi-select", [
      "IBAN",
      "BIC",
      "Bank name",
      "Account holder name",
    ]),
    expected: { kind: "multi-select", value: ["IBAN", "BIC"] },
  },
  {
    key: "lease_term_type",
    prompt: "Is the lease fixed-term, indefinite, or month-to-month?",
    content: selectContent("single-select", [
      "Fixed-term",
      "Indefinite",
      "Month-to-month",
    ]),
    // No duration or end date is stated anywhere in the document.
    expected: { kind: "single-select", value: null },
  },
];

const EN_SERVICES_PROPERTIES: readonly PropertyFixture[] = [
  {
    key: "client_name",
    prompt: "What is the Client's full legal name?",
    content: textContent(),
    expected: { kind: "text", value: "Northbridge Analytics Ltd" },
  },
  {
    key: "consultant_name",
    prompt: "What is the Consultant's full legal name?",
    content: textContent(),
    expected: { kind: "text", value: "Solventra Consulting LLC" },
  },
  {
    key: "effective_date",
    prompt: "What is the Agreement's effective date?",
    content: dateContent(),
    expected: { kind: "date", value: "2025-04-01" },
  },
  {
    key: "monthly_fee",
    prompt: "What is the monthly fee, and in what currency?",
    content: intContent(),
    expected: { kind: "int", amount: 12_000, currency: "USD" },
  },
  {
    key: "governing_law",
    prompt: "Which jurisdiction's law governs the Agreement?",
    content: selectContent("single-select", [
      "Delaware",
      "England and Wales",
      "New York",
      "California",
    ]),
    expected: { kind: "single-select", value: "Delaware" },
  },
  {
    key: "services_categories",
    prompt:
      "Which categories of services does the Consultant provide under this Agreement?",
    content: selectContent("multi-select", [
      "Data Analytics",
      "Financial Modeling",
      "Market Research",
      "Legal Advisory",
      "Tax Compliance",
    ]),
    expected: {
      kind: "multi-select",
      value: ["Data Analytics", "Financial Modeling", "Market Research"],
    },
  },
  {
    key: "dispute_resolution_forum",
    prompt:
      "How are disputes under the Agreement resolved: arbitration, litigation, or mediation?",
    content: selectContent("single-select", [
      "Arbitration",
      "Litigation in Delaware courts",
      "Mediation then arbitration",
      "Litigation in London courts",
    ]),
    // The Agreement has a termination clause but no dispute-resolution clause.
    expected: { kind: "single-select", value: null },
  },
];

type EvalTask = {
  id: string;
  fixtureText: string;
  properties: readonly PropertyFixture[];
};

const TASKS: readonly EvalTask[] = [
  {
    id: "cs-purchase",
    fixtureText: CS_PURCHASE_FIXTURE,
    properties: CS_PURCHASE_PROPERTIES,
  },
  {
    id: "de-lease",
    fixtureText: DE_LEASE_FIXTURE,
    properties: DE_LEASE_PROPERTIES,
  },
  {
    id: "en-services",
    fixtureText: EN_SERVICES_FIXTURE,
    properties: EN_SERVICES_PROPERTIES,
  },
];

const toAIBatchProperty = (fixture: PropertyFixture): AIBatchProperty => {
  const tool: AIModelTool = {
    version: 1,
    type: "ai-model",
    prompt: fixture.prompt,
  };
  return {
    id: toSafeId<"property">(fixture.key),
    status: "stale",
    content: fixture.content,
    dependencies: [],
    tool,
  };
};

// --------------- CLI ---------------

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

// --------------- Model selection ---------------

// `generateWorkflowData` always dispatches through the "pdf" model role, so
// the only way to steer it at a given model is an `OrgAIConfig` BYOK
// override — the same mechanism org AI settings use. Every role is pointed
// at the same selection; only "pdf" is ever read by this call path.
const PROVIDER_ENV_CREDENTIALS: Record<BYOKProvider, string | undefined> = {
  google: env.GOOGLE_GENERATIVE_AI_API_KEY,
  openrouter: env.OPENROUTER_API_KEY,
  openai: env.OPENAI_API_KEY,
  anthropic: env.ANTHROPIC_API_KEY,
  bedrock: env.BEDROCK_API_KEY,
  mistral: env.MISTRAL_API_KEY,
};

const isByokProvider = (value: string): value is BYOKProvider =>
  value in BYOK_MODEL_OPTIONS;

const BYOK_PROVIDERS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
] as const satisfies readonly BYOKProvider[];

type ModelSelection = {
  provider: BYOKProvider;
  modelId: string;
  apiKey: string;
};

const resolveExplicitModelSelection = (
  spec: string,
  providerRaw: string,
  modelId: string,
): ModelSelection => {
  if (!isByokProvider(providerRaw)) {
    return panic(`Unknown AI provider "${providerRaw}" in model id "${spec}"`);
  }
  const apiKey = PROVIDER_ENV_CREDENTIALS[providerRaw];
  if (apiKey === undefined) {
    return panic(
      `No credentials configured for provider "${providerRaw}" (model "${spec}")`,
    );
  }
  return { provider: providerRaw, modelId, apiKey };
};

// A bare id (no "provider::" prefix): find a directly-offered provider with
// credentials, else route the same id through OpenRouter's
// "<provider>/<modelId>" form when OpenRouter is credentialed.
const resolveBareModelSelection = (modelId: string): ModelSelection => {
  const directProviders = BYOK_PROVIDERS.filter((provider) => {
    const offered: readonly string[] = BYOK_MODEL_OPTIONS[provider];
    return provider !== "openrouter" && offered.includes(modelId);
  });

  const credentialedProvider = directProviders.find(
    (provider) => PROVIDER_ENV_CREDENTIALS[provider] !== undefined,
  );
  if (credentialedProvider !== undefined) {
    const apiKey = PROVIDER_ENV_CREDENTIALS[credentialedProvider];
    if (apiKey === undefined) {
      return panic(`Missing credential resolved for "${credentialedProvider}"`);
    }
    return { provider: credentialedProvider, modelId, apiKey };
  }

  const openRouterApiKey = PROVIDER_ENV_CREDENTIALS.openrouter;
  const openRouterOptions: readonly string[] = BYOK_MODEL_OPTIONS.openrouter;
  const routedProvider = directProviders.find((provider) =>
    openRouterOptions.includes(`${provider}/${modelId}`),
  );
  if (openRouterApiKey !== undefined && routedProvider !== undefined) {
    return {
      provider: "openrouter",
      modelId: `${routedProvider}/${modelId}`,
      apiKey: openRouterApiKey,
    };
  }

  return panic(
    `No credentialed provider offers model "${modelId}" directly or via OpenRouter`,
  );
};

const resolveModelSelection = (spec: string): ModelSelection => {
  const separatorIndex = spec.indexOf("::");
  if (separatorIndex === -1) {
    return resolveBareModelSelection(spec);
  }
  return resolveExplicitModelSelection(
    spec,
    spec.slice(0, separatorIndex),
    spec.slice(separatorIndex + 2),
  );
};

const buildOrgAIConfig = (selection: ModelSelection): OrgAIConfig => {
  const modelSelection: OrgAIModelSelection = {
    provider: selection.provider,
    modelId: selection.modelId,
  };
  const overrideModels: Record<ModelRole, OrgAIModelSelection> = {
    fast: modelSelection,
    chat: modelSelection,
    reasoning: modelSelection,
    pdf: modelSelection,
  };
  return {
    providers: [{ provider: selection.provider, apiKey: selection.apiKey }],
    overrideModels,
  };
};

// --------------- Scoring ---------------

type FieldOutcome =
  | "correct"
  | "wrong"
  | "hallucinated"
  | "missing"
  | "schema-violation";

type FieldGrade = {
  key: string;
  outcome: FieldOutcome;
  answer: Answer | null;
  justification: AIJustificationOutput | null;
  schemaError: string | null;
};

const normalizeText = (value: string): string =>
  value.trim().toLocaleLowerCase();

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value));

// `validated.type` is guaranteed to match `expected.kind` because both come
// from the same property's `content.type`; a mismatch is a bug in this eval's
// fixtures, not a model result.
const gradeAnswer = (
  expected: ExpectedAnswer,
  validated: ValidatedResult,
): FieldOutcome => {
  switch (expected.kind) {
    case "text": {
      if (validated.type !== "text") {
        return panic("Fixture/property type mismatch: text");
      }
      return normalizeText(validated.value) === normalizeText(expected.value)
        ? "correct"
        : "wrong";
    }
    case "date": {
      if (validated.type !== "date") {
        return panic("Fixture/property type mismatch: date");
      }
      if (expected.value === null) {
        return validated.value === null ? "correct" : "hallucinated";
      }
      if (validated.value === null) {
        return "missing";
      }
      return validated.value === expected.value ? "correct" : "wrong";
    }
    case "int": {
      if (validated.type !== "int") {
        return panic("Fixture/property type mismatch: int");
      }
      return validated.value === expected.amount ? "correct" : "wrong";
    }
    case "single-select": {
      if (validated.type !== "single-select") {
        return panic("Fixture/property type mismatch: single-select");
      }
      if (expected.value === null) {
        return validated.value === null ? "correct" : "hallucinated";
      }
      if (validated.value === null) {
        return "missing";
      }
      return validated.value === expected.value ? "correct" : "wrong";
    }
    case "multi-select": {
      if (validated.type !== "multi-select") {
        return panic("Fixture/property type mismatch: multi-select");
      }
      if (expected.value.length === 0) {
        return validated.value.length === 0 ? "correct" : "hallucinated";
      }
      if (validated.value.length === 0) {
        return "missing";
      }
      return setsEqual(
        new Set(expected.value.map(normalizeText)),
        new Set(validated.value.map(normalizeText)),
      )
        ? "correct"
        : "wrong";
    }
    default: {
      const exhaustive: never = expected;
      return panic(`Unhandled expected-answer kind: ${String(exhaustive)}`);
    }
  }
};

type WorkflowDataOutput = Record<
  string,
  { answer: Answer; justification: AIJustificationOutput }
>;

const gradeField = (
  fixture: PropertyFixture,
  output: WorkflowDataOutput,
): FieldGrade => {
  const raw = output[fixture.key];
  if (raw === undefined) {
    return {
      key: fixture.key,
      outcome: "missing",
      answer: null,
      justification: null,
      schemaError: "Property id absent from model output",
    };
  }

  const validated = validateAIOutput({
    aiResult: raw,
    property: toAIBatchProperty(fixture),
  });
  if (Result.isError(validated)) {
    return {
      key: fixture.key,
      outcome: "schema-violation",
      answer: raw.answer,
      justification: raw.justification,
      schemaError: validated.error.message,
    };
  }

  return {
    key: fixture.key,
    outcome: gradeAnswer(fixture.expected, validated.value),
    answer: raw.answer,
    justification: raw.justification,
    schemaError: null,
  };
};

type RunScore = {
  outcome: "pass" | "fail" | "error";
  correct: number;
  wrong: number;
  hallucinated: number;
  missing: number;
  schemaViolations: number;
  fields: FieldGrade[];
};

const summarizeFields = (fields: readonly FieldGrade[]): RunScore => {
  const counts = {
    correct: 0,
    wrong: 0,
    hallucinated: 0,
    missing: 0,
    schemaViolations: 0,
  };
  for (const field of fields) {
    switch (field.outcome) {
      case "correct":
        counts.correct += 1;
        break;
      case "wrong":
        counts.wrong += 1;
        break;
      case "hallucinated":
        counts.hallucinated += 1;
        break;
      case "missing":
        counts.missing += 1;
        break;
      case "schema-violation":
        counts.schemaViolations += 1;
        break;
      default: {
        const exhaustive: never = field.outcome;
        panic(`Unhandled field outcome: ${String(exhaustive)}`);
      }
    }
  }
  const outcome: RunScore["outcome"] =
    counts.wrong +
      counts.hallucinated +
      counts.missing +
      counts.schemaViolations ===
    0
      ? "pass"
      : "fail";
  return { outcome, ...counts, fields: [...fields] };
};

const ERROR_SCORE: RunScore = {
  outcome: "error",
  correct: 0,
  wrong: 0,
  hallucinated: 0,
  missing: 0,
  schemaViolations: 0,
  fields: [],
};

// --------------- Run ---------------

const EVAL_ORGANIZATION_ID: SafeId<"organization"> =
  toSafeId<"organization">("eval-org");
const EVAL_WORKSPACE_ID: SafeId<"workspace"> =
  toSafeId<"workspace">("eval-workspace");

type EvalRun = {
  modelId: string;
  taskId: string;
  repeat: number;
  score: RunScore;
  latencyMs: number;
  error: string | null;
  rawOutput: WorkflowDataOutput | null;
};

const runTask = async ({
  modelId,
  orgAIConfig,
  task,
  repeat,
}: {
  modelId: string;
  orgAIConfig: OrgAIConfig;
  task: EvalTask;
  repeat: number;
}): Promise<EvalRun> => {
  const properties = task.properties.map(toAIBatchProperty);
  const file: PreparedExtractedTextFile = {
    kind: "extracted-text",
    fileFieldId: createSafeId<"field">(),
    fileId: `${task.id}-fixture`,
    content: task.fixtureText,
    simplifiedName: "F0",
  };

  const start = performance.now();
  const result = await generateWorkflowData({
    files: [file],
    properties,
    filenames: [],
    textInputs: [],
    abortSignal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    entityVersionId: `${task.id}-${modelId}-${String(repeat)}`,
    organizationId: EVAL_ORGANIZATION_ID,
    workspaceId: EVAL_WORKSPACE_ID,
    orgAIConfig,
    promptCachingEnabled: false,
    serviceTier: "standard",
  });
  const latencyMs = Math.round(performance.now() - start);

  if (Result.isError(result)) {
    return {
      modelId,
      taskId: task.id,
      repeat,
      score: ERROR_SCORE,
      latencyMs,
      error: result.error.message,
      rawOutput: null,
    };
  }

  const output = result.value;
  const fields = task.properties.map((fixture) => gradeField(fixture, output));
  return {
    modelId,
    taskId: task.id,
    repeat,
    score: summarizeFields(fields),
    latencyMs,
    error: null,
    rawOutput: output,
  };
};

// --------------- Report ---------------

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = [];
  const modelIds = [...new Set(runs.map((run) => run.modelId))];
  for (const modelId of modelIds) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| task | run | outcome | correct | wrong | hallucinated | missing | schema | ms |",
      "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const run of modelRuns) {
      const { score } = run;
      lines.push(
        [
          `| ${run.taskId}`,
          String(run.repeat),
          run.error === null
            ? score.outcome
            : `${score.outcome} (${run.error})`,
          String(score.correct),
          String(score.wrong),
          String(score.hallucinated),
          String(score.missing),
          String(score.schemaViolations),
          `${String(run.latencyMs)} |`,
        ].join(" | "),
      );
    }
    const total = modelRuns.length;
    const passed = modelRuns.filter(
      (run) => run.score.outcome === "pass",
    ).length;
    const errored = modelRuns.filter(
      (run) => run.score.outcome === "error",
    ).length;
    const fields = modelRuns.reduce(
      (sum, run) => sum + run.score.fields.length,
      0,
    );
    const correct = modelRuns.reduce((sum, run) => sum + run.score.correct, 0);
    const hallucinated = modelRuns.reduce(
      (sum, run) => sum + run.score.hallucinated,
      0,
    );
    lines.push(
      "",
      `passed ${String(passed)}/${String(total)}, errors ${String(errored)}, ` +
        `fields correct ${String(correct)}/${String(fields)}, hallucinated ${String(hallucinated)}`,
    );
  }
  return lines.join("\n");
};

// --------------- Main ---------------

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const tasks = TASKS.filter(
    (task) => options.taskFilter === null || task.id === options.taskFilter,
  );
  if (tasks.length === 0) {
    panic(`Unknown task ${String(options.taskFilter)}`);
  }

  const models = options.models.map((spec) => ({
    id: spec,
    orgAIConfig: buildOrgAIConfig(resolveModelSelection(spec)),
  }));

  const runs: EvalRun[] = [];
  for (const { id, orgAIConfig } of models) {
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.runs; repeat += 1) {
        process.stderr.write(`${id} · ${task.id} · run ${String(repeat)}\n`);
        // One model call at a time: keeps provider rate limits and the
        // report order, and a failure points at the run that caused it.
        // eslint-disable-next-line no-await-in-loop
        runs.push(await runTask({ modelId: id, orgAIConfig, task, repeat }));
      }
    }
  }

  process.stdout.write(`${renderReport(runs)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
