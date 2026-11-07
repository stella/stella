/**
 * Playbook clause extraction eval: when a position's question is generated at
 * save time, does the path from rules to question, to extraction, to verdict
 * reach the expected verdict, from an answer that covers the terms the grader
 * has to judge?
 *
 * Each case runs the production functions in order: `deriveAutoAsks`,
 * `resolveEffectiveAsk`, `generateWorkflowData` over the contract fixture with
 * every case of that contract in one batch (as a run does), `validateAIOutput`,
 * and the verdict engine's graders. No database, no document parsing. Scoring
 * is code:
 *
 *   type        the stored content type is the expected one
 *   coverage    every expected term appears in the extracted answer
 *   absence     a term the contract never states comes back with no answer,
 *               not as prose saying so (prose would read as present)
 *   verdict     the graded tier is the expected one
 *
 * No dev stack needed; models resolve from instance credentials (.env).
 *
 * Usage (from apps/api):
 *   bun run eval:playbook-clause
 *   bun run eval:playbook-clause -- --models gpt-5.6-luna --runs 3 --json out.json
 */
import { panic, Result } from "better-result";
import { writeFile } from "node:fs/promises";

import type { FieldContent } from "@/api/db/schema-validators";
import { isAiExtractablePropertyContent } from "@/api/db/schema-validators";
import { deriveAutoAsks } from "@/api/handlers/playbooks/derive-ask";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import {
  fieldContentFromValidated,
  validateAIOutput,
} from "@/api/lib/workflow/ai-validators";
import type { PreparedExtractedTextFile } from "@/api/lib/workflow/generate-batch";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import {
  isTierStandard,
  resolveEffectiveAsk,
} from "@/api/lib/workflow/position-runtime";
import type { TierStandardPosition } from "@/api/lib/workflow/position-runtime";
import { resolveTiers } from "@/api/lib/workflow/resolve-standards";
import {
  askPresence,
  askText,
  gradePresence,
  gradePropertyConstraint,
  gradeTierMatch,
} from "@/api/lib/workflow/verdict-engine";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";
import { testModelActionAdmitter } from "@/api/tests/helpers/model-dispatch-admission";

import { resolveModelTargets } from "./lib/org-model-targets";

const DEFAULT_MODELS = ["gpt-5.6-luna", "gpt-6-sol"];
const DEFAULT_RUNS = 1;
const MODEL_REQUEST_TIMEOUT_MS = 120_000;

// --------------- Fixtures (fictional parties) ---------------

const EN_SERVICES_CONTRACT = `SERVICES AGREEMENT

between Nordwind Logistics GmbH ("Customer") and Halden Data AB ("Supplier").

1. Services
1.1 Supplier shall provide the hosted reporting services described in Schedule 1.

2. Term
2.1 This Agreement starts on the Effective Date and continues for an initial term of 24 months (the "Initial Term").

4. Fees
4.1 Customer shall pay the fees set out in Schedule 2. Supplier shall invoice monthly in arrears, and each correct, itemised invoice is payable within 30 days after receipt.
4.2 Fees are fixed for the Initial Term. After the Initial Term, Supplier may adjust the fees once per contract year on at least 90 days' written notice. No adjustment may exceed the increase in the U.S. Consumer Price Index for All Urban Consumers (CPI-U) published by the U.S. Bureau of Labor Statistics over the preceding 12 months.

6. Confidentiality
6.1 "Confidential Information" means all non-public information a Party discloses to the other in connection with this Agreement that is marked confidential or would reasonably be understood to be confidential.
6.2 Each Party shall protect the other Party's Confidential Information using reasonable care, use it only to perform this Agreement, and disclose it only to its personnel and professional advisers who need to know it and are bound by obligations no less protective than this Clause 6.
6.3 These obligations survive for five (5) years after expiry or termination. Information that qualifies as a trade secret remains protected for as long as it qualifies as a trade secret under applicable law.

9. Governing law
9.1 This Agreement is governed by the laws of Sweden.`;

const CS_SERVICES_CONTRACT = `SMLOUVA O POSKYTOVÁNÍ SLUŽEB

mezi společností Severka Logistika s.r.o. („Objednatel“) a společností Halden Data s.r.o. („Poskytovatel“).

Článek 3. Cena
3.1 Objednatel uhradí cenu podle přílohy č. 2. Faktury jsou splatné do 30 dnů od doručení.

Článek 5. Mlčenlivost
5.1 Každá smluvní strana zachovává mlčenlivost o důvěrných informacích druhé strany a použije je pouze k plnění této smlouvy.
5.2 Důvěrné informace smí zpřístupnit jen svým zaměstnancům a poradcům, kteří je nezbytně potřebují znát a jsou vázáni stejnou povinností mlčenlivosti.
5.3 Povinnost mlčenlivosti trvá pět (5) let po skončení smlouvy.

Článek 8. Rozhodné právo
8.1 Smlouva se řídí právním řádem České republiky.`;

type ContractKey = "en-services" | "cs-services";

const CONTRACTS = {
  "en-services": EN_SERVICES_CONTRACT,
  "cs-services": CS_SERVICES_CONTRACT,
} as const satisfies Record<ContractKey, string>;

type PositionFixture = {
  sourceId: string;
  issue: string;
  acceptable: readonly string[];
  fallbacks?: readonly string[];
  redLines?: readonly string[];
  check?: TierStandardPosition["check"];
};

const tierPosition = ({
  sourceId,
  issue,
  acceptable,
  fallbacks = [],
  redLines = [],
  check,
}: PositionFixture): TierStandardPosition => ({
  mode: "graded",
  sourceId,
  issue,
  severity: "medium",
  ask: { mode: "auto" },
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: acceptable.map((text, index) => ({
          id: `${sourceId}-a${String(index)}`,
          text,
        })),
      },
      fallback: {
        entries: fallbacks.map((text, index) => ({
          id: `${sourceId}-f${String(index)}`,
          text,
        })),
      },
      notAcceptable: {
        rules: redLines.map((text, index) => ({
          id: `${sourceId}-r${String(index)}`,
          text,
        })),
      },
    },
  },
  ...(check === undefined ? {} : { check }),
  enabled: true,
});

type EvalCase = {
  id: string;
  contract: ContractKey;
  position: TierStandardPosition;
  expected: {
    verdicts: readonly VerdictTier[];
    contentType: "text" | "int" | "date";
    /** Terms the answer must carry, or `null` when it must carry no answer. */
    covers: readonly RegExp[] | null;
  };
};

const FEES_ID = "c1a0e000-0000-4000-8000-000000000001";
const CONFIDENTIALITY_ID = "c1a0e000-0000-4000-8000-000000000002";
const CONFIDENTIALITY_PRESENT_ID = "c1a0e000-0000-4000-8000-000000000003";
const ESCROW_ID = "c1a0e000-0000-4000-8000-000000000004";
const ESCROW_REQUIRED_ID = "c1a0e000-0000-4000-8000-000000000005";
const ESCROW_RESTRICTED_ID = "c1a0e000-0000-4000-8000-000000000006";
const PAYMENT_DAYS_ID = "c1a0e000-0000-4000-8000-000000000007";
const CS_CONFIDENTIALITY_ID = "c1a0e000-0000-4000-8000-000000000008";

const CONFIDENTIALITY_RULES = [
  "Mutual confidentiality and purpose limitation extend to personnel and advisers only on a need-to-know basis under equivalent duties.",
  "General confidentiality obligations survive five years after termination; trade-secret protection continues for as long as the information qualifies as a trade secret under applicable law.",
];

const ESCROW_RULES = [
  "Supplier deposits the source code with an independent escrow agent, and Customer may obtain it if Supplier becomes insolvent.",
];

const CASES: readonly EvalCase[] = [
  {
    id: "fees-fallback",
    contract: "en-services",
    position: tierPosition({
      sourceId: FEES_ID,
      issue: "Fees, invoices and price increases",
      acceptable: [
        "Fees are specified in a binding schedule; invoices are monthly in arrears and due 30 days after receipt of a correct invoice.",
        "No increase during the initial term; thereafter no more than once annually, on at least 90 days' written notice and subject to an agreed objective cap.",
      ],
      fallbacks: [
        "After the initial term, Supplier may adjust fees once per contract year on at least 90 days' written notice, not exceeding the increase in the mutually specified published U.S. consumer-price index over the preceding 12 months.",
      ],
      redLines: [
        "Supplier may raise fees at will or without advance notice.",
        "Fees or payment milestones are not stated in an incorporated agreement or schedule.",
      ],
    }),
    expected: {
      // The clause meets the fallback and also the acceptable rules, because a
      // CPI limit is an "agreed objective cap". Either tier reads it correctly.
      verdicts: ["fallback", "compliant"],
      contentType: "text",
      covers: [
        /arrears/iu,
        /fixed/iu,
        /90 days/iu,
        /consumer price index|cpi/iu,
      ],
    },
  },
  {
    id: "confidentiality-compliant",
    contract: "en-services",
    position: tierPosition({
      sourceId: CONFIDENTIALITY_ID,
      issue: "Confidentiality and survival",
      acceptable: CONFIDENTIALITY_RULES,
      fallbacks: [
        "Each party shall protect the other's Confidential Information and use it only to perform this Agreement. These duties survive five years after termination, and for trade secrets for as long as protected by applicable law.",
      ],
      redLines: [
        "Supplier may use or disclose customer confidential information for unrelated purposes.",
        "Confidentiality ends automatically at termination with no survival period.",
      ],
    }),
    expected: {
      verdicts: ["compliant"],
      contentType: "text",
      covers: [
        /only to perform|purpose/iu,
        /need to know|need-to-know/iu,
        /five|\b5\b/iu,
        /trade secret/iu,
      ],
    },
  },
  {
    id: "presence-stated",
    contract: "en-services",
    position: tierPosition({
      sourceId: CONFIDENTIALITY_PRESENT_ID,
      issue: "Confidentiality clause",
      acceptable: ["The contract contains a mutual confidentiality clause."],
      check: { kind: "presence", expectation: "required" },
    }),
    expected: {
      verdicts: ["compliant"],
      contentType: "text",
      covers: [/confidential/iu],
    },
  },
  {
    id: "absent-model-graded",
    contract: "en-services",
    position: tierPosition({
      sourceId: ESCROW_ID,
      issue: "Source code escrow",
      acceptable: ESCROW_RULES,
    }),
    expected: { verdicts: ["missing"], contentType: "text", covers: null },
  },
  {
    id: "absent-presence-required",
    contract: "en-services",
    position: tierPosition({
      sourceId: ESCROW_REQUIRED_ID,
      issue: "Source code escrow arrangement",
      acceptable: ESCROW_RULES,
      check: { kind: "presence", expectation: "required" },
    }),
    expected: { verdicts: ["missing"], contentType: "text", covers: null },
  },
  {
    id: "absent-presence-restricted",
    contract: "en-services",
    position: tierPosition({
      sourceId: ESCROW_RESTRICTED_ID,
      issue: "Exclusive purchasing commitment",
      acceptable: [
        "Customer is not required to buy these services only from Supplier.",
      ],
      check: { kind: "presence", expectation: "restricted" },
    }),
    expected: { verdicts: ["missing"], contentType: "text", covers: null },
  },
  {
    id: "constraint-int",
    contract: "en-services",
    position: tierPosition({
      sourceId: PAYMENT_DAYS_ID,
      issue: "Invoice payment term (days)",
      acceptable: ["Invoices are payable within 30 days at most."],
      check: {
        kind: "constraint",
        condition: {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "compare",
              left: { type: "property", propertyId: PAYMENT_DAYS_ID },
              op: "lte",
              right: { type: "literal", value: 30 },
            },
          ],
        },
      },
    }),
    expected: { verdicts: ["compliant"], contentType: "int", covers: [/30/u] },
  },
  {
    id: "cs-confidentiality-compliant",
    contract: "cs-services",
    position: tierPosition({
      sourceId: CS_CONFIDENTIALITY_ID,
      issue: "Mlčenlivost a její trvání",
      acceptable: [
        "Mlčenlivost je vzájemná a důvěrné informace lze použít jen k plnění smlouvy.",
        "Zpřístupnění je možné jen osobám, které informace nezbytně potřebují znát a jsou vázány stejnou povinností.",
        "Povinnost mlčenlivosti trvá alespoň pět let po skončení smlouvy.",
      ],
      redLines: ["Povinnost mlčenlivosti končí se skončením smlouvy."],
    }),
    expected: {
      verdicts: ["compliant"],
      contentType: "text",
      covers: [/plnění/iu, /potřebují znát|znát/iu, /pět|\b5\b/iu],
    },
  },
];

// --------------- Run ---------------

const EVAL_ORGANIZATION_ID: SafeId<"organization"> =
  toSafeId<"organization">("eval-org");
const EVAL_WORKSPACE_ID: SafeId<"workspace"> =
  toSafeId<"workspace">("eval-workspace");

const admission = admitFixtureModelDispatch({
  userId: null,
  organizationId: EVAL_ORGANIZATION_ID,
  actionKind: "workflow.background",
  modelTier: MANAGED_MODEL_TIER.standard,
});

const toProperty = (position: Position): AIBatchProperty => {
  const { question, content } = resolveEffectiveAsk(position);
  if (!isAiExtractablePropertyContent(content)) {
    return panic(`A derived ask cannot extract ${content.type}`);
  }
  return {
    id: toSafeId<"property">(position.sourceId),
    status: "stale",
    content,
    dependencies: [],
    tool: { version: 1, type: "ai-model", prompt: question },
  };
};

type ExtractContractOptions = {
  contract: ContractKey;
  positions: readonly Position[];
  orgAIConfig: OrgAIConfig;
  runLabel: string;
};

const extractContract = async ({
  contract,
  positions,
  orgAIConfig,
  runLabel,
}: ExtractContractOptions): Promise<ReadonlyMap<string, FieldContent>> => {
  const properties = positions.map(toProperty);
  const file: PreparedExtractedTextFile = {
    kind: "extracted-text",
    fileFieldId: createSafeId<"field">(),
    fileId: `${contract}-fixture`,
    content: CONTRACTS[contract],
    simplifiedName: "F0",
  };
  const generated = await generateWorkflowData({
    files: [file],
    properties,
    filenames: [],
    textInputs: [],
    linkedSkillsMessage: null,
    abortSignal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    entityVersionId: `${contract}-${runLabel}`,
    organizationId: EVAL_ORGANIZATION_ID,
    admission,
    workspaceId: EVAL_WORKSPACE_ID,
    orgAIConfig,
    managedAIResidency: "eu",
    promptCachingEnabled: false,
    serviceTier: "standard",
  });
  if (Result.isError(generated)) {
    return panic(`Extraction failed: ${generated.error.message}`);
  }
  const contentBySourceId = new Map<string, FieldContent>();
  for (const property of properties) {
    const result = generated.value.output[property.id];
    if (result === undefined) {
      continue;
    }
    const validated = validateAIOutput({ aiResult: result, property });
    if (Result.isError(validated)) {
      return panic(`Extraction failed validation: ${validated.error.message}`);
    }
    const content = fieldContentFromValidated(validated.value);
    if (content !== null) {
      contentBySourceId.set(property.id, content);
    }
  }
  return contentBySourceId;
};

type GradeOptions = {
  position: TierStandardPosition;
  content: FieldContent | undefined;
  contentBySourceId: ReadonlyMap<string, FieldContent>;
  orgAIConfig: OrgAIConfig;
  runLabel: string;
};

const gradePosition = async ({
  position,
  content,
  contentBySourceId,
  orgAIConfig,
  runLabel,
}: GradeOptions): Promise<{
  verdict: VerdictTier;
  rationale: string | null;
}> => {
  const { check } = position;
  switch (check?.kind) {
    case "presence":
      return {
        verdict: gradePresence(check.expectation, askPresence(content)),
        rationale: null,
      };
    case "constraint":
      return {
        verdict: gradePropertyConstraint(
          check.condition,
          content,
          contentBySourceId,
        ),
        rationale: null,
      };
    case undefined: {
      const askValue = askText(content);
      if (askValue === null || askValue.trim().length === 0) {
        return { verdict: "missing", rationale: null };
      }
      const graded = await gradeTierMatch({
        askValue,
        tiers: resolveTiers(position, new Map()),
        abortSignal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
        organizationId: EVAL_ORGANIZATION_ID,
        admission,
        workspaceId: EVAL_WORKSPACE_ID,
        entityVersionId: toSafeId<"entityVersion">(runLabel),
        propertyId: toSafeId<"property">(position.sourceId),
        orgAIConfig,
        managedAIResidency: "eu",
        promptCachingEnabled: false,
        serviceTier: "standard",
      });
      if (Result.isError(graded)) {
        return panic(`Grading failed: ${graded.error.message}`);
      }
      return { verdict: graded.value.tier, rationale: graded.value.rationale };
    }
    default:
      check satisfies never;
      return panic(`Unhandled check: ${String(check)}`);
  }
};

type CaseScore = {
  caseId: string;
  outcome: "pass" | "fail";
  defects: string[];
  verdict: VerdictTier;
  rationale: string | null;
  question: string;
  contentType: string;
  answer: string | null;
};

const scoreCase = ({
  evalCase,
  position,
  content,
  verdict,
  rationale,
}: {
  evalCase: EvalCase;
  position: TierStandardPosition;
  content: FieldContent | undefined;
  verdict: VerdictTier;
  rationale: string | null;
}): CaseScore => {
  const { question, content: askContent } = resolveEffectiveAsk(position);
  const answer = askText(content);
  const defects: string[] = [];
  const { expected } = evalCase;
  if (position.ask.mode === "auto" && position.ask.derived === undefined) {
    defects.push("the ask was not derived, so this ran the fallback question");
  }
  if (askContent.type !== expected.contentType) {
    defects.push(`type ${askContent.type}, expected ${expected.contentType}`);
  }
  if (expected.covers === null && answer !== null) {
    defects.push("an absent term came back with an answer");
  }
  for (const term of expected.covers ?? []) {
    if (answer === null || !term.test(answer)) {
      defects.push(`answer does not cover ${term.source}`);
    }
  }
  if (!expected.verdicts.includes(verdict)) {
    defects.push(
      `verdict ${verdict}, expected ${expected.verdicts.join(" or ")}`,
    );
  }
  return {
    caseId: evalCase.id,
    outcome: defects.length === 0 ? "pass" : "fail",
    defects,
    verdict,
    rationale,
    question,
    contentType: askContent.type,
    answer,
  };
};

const runOnce = async (
  orgAIConfig: OrgAIConfig,
  runLabel: string,
  cases: readonly EvalCase[],
): Promise<CaseScore[]> => {
  const derived = await deriveAutoAsks(
    { version: 3, items: cases.map(({ position }) => position) },
    {
      admitModelAction: testModelActionAdmitter(EVAL_ORGANIZATION_ID),
      organizationId: EVAL_ORGANIZATION_ID,
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      promptCachingEnabled: false,
    },
  );
  const positionById = new Map(
    derived.items.map((item) => [item.sourceId, item]),
  );
  const positionOf = (evalCase: EvalCase): Position =>
    positionById.get(evalCase.position.sourceId) ??
    panic(`Lost position ${evalCase.id}`);

  const contentByContract = new Map<
    ContractKey,
    ReadonlyMap<string, FieldContent>
  >();
  for (const contract of new Set(cases.map((item) => item.contract))) {
    contentByContract.set(
      contract,
      await extractContract({
        contract,
        positions: cases
          .filter((item) => item.contract === contract)
          .map(positionOf),
        orgAIConfig,
        runLabel,
      }),
    );
  }

  return await Promise.all(
    cases.map(async (evalCase) => {
      const position = positionOf(evalCase);
      if (!isTierStandard(position)) {
        return panic(`Case ${evalCase.id} is not a tier position`);
      }
      const contentBySourceId =
        contentByContract.get(evalCase.contract) ?? new Map();
      const content = contentBySourceId.get(position.sourceId);
      const { verdict, rationale } = await gradePosition({
        position,
        content,
        contentBySourceId,
        orgAIConfig,
        runLabel,
      });
      return scoreCase({ evalCase, position, content, verdict, rationale });
    }),
  );
};

// --------------- CLI ---------------

type CliOptions = {
  models: string[];
  runs: number;
  caseFilter: string | null;
  jsonPath: string | null;
};

const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    models: DEFAULT_MODELS,
    runs: DEFAULT_RUNS,
    caseFilter: null,
    jsonPath: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv.at(index);
    const value = argv.at(index + 1);
    if (flag === undefined || value === undefined) {
      return panic(`Flag ${String(flag)} needs a value`);
    }
    switch (flag) {
      case "--models":
        options.models = value.split(",").map((id) => id.trim());
        break;
      case "--runs":
        options.runs = Math.max(1, Number.parseInt(value, 10) || DEFAULT_RUNS);
        break;
      case "--case":
        options.caseFilter = value;
        break;
      case "--json":
        options.jsonPath = value;
        break;
      default:
        return panic(`Unknown flag ${flag}`);
    }
  }
  return options;
};

const renderTable = (modelId: string, scores: readonly CaseScore[]): string =>
  [
    `\n### ${modelId}\n`,
    "| case | outcome | verdict | type | answer chars | defects |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...scores.map(
      (score) =>
        `| ${score.caseId} | ${score.outcome} | ${score.verdict} | ${score.contentType} | ` +
        `${String(score.answer?.length ?? 0)} | ${score.defects.join("; ")} |`,
    ),
    "",
    `passed ${String(scores.filter((score) => score.outcome === "pass").length)}/${String(scores.length)}`,
  ].join("\n");

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const cases = CASES.filter(
    (item) => options.caseFilter === null || item.id === options.caseFilter,
  );
  if (cases.length === 0) {
    panic(`Unknown case ${String(options.caseFilter)}`);
  }

  const runs: { modelId: string; run: number; scores: CaseScore[] }[] = [];
  // `run` is null when the model never resolved, so no run was attempted.
  const failures: { modelId: string; run: number | null; message: string }[] =
    [];
  for (const target of resolveModelTargets(options.models)) {
    if (target.type === "resolution-error") {
      process.stderr.write(`${target.id}: ${target.message}\n`);
      failures.push({ modelId: target.id, run: null, message: target.message });
      continue;
    }
    const scores: CaseScore[] = [];
    for (let run = 1; run <= options.runs; run += 1) {
      process.stderr.write(`${target.id} · run ${String(run)}\n`);
      const runScores = await Result.tryPromise({
        try: async () =>
          await runOnce(
            target.orgAIConfig,
            `${target.id}-${String(run)}`,
            cases,
          ),
        catch: (error) =>
          error instanceof Error ? error.message : String(error),
      });
      if (Result.isError(runScores)) {
        process.stderr.write(
          `${target.id} · run ${String(run)} failed: ${runScores.error}\n`,
        );
        failures.push({ modelId: target.id, run, message: runScores.error });
        continue;
      }
      runs.push({ modelId: target.id, run, scores: runScores.value });
      scores.push(...runScores.value);
    }
    process.stdout.write(`${renderTable(target.id, scores)}\n`);
  }
  if (options.jsonPath !== null) {
    await writeFile(
      options.jsonPath,
      JSON.stringify({ runs, failures }, null, 2),
    );
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

await main();
