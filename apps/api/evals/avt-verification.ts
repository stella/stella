/**
 * Verification eval: how often does the verification engine reach the verdict
 * a careful reviewer would, on labelled sets of documents, anchor facts and
 * claims?
 *
 * The production functions run in order, with no database and no HTTP: the
 * DOCX and PDF readers, the paragraph range a scoped run reads, claim
 * extraction, and claim grading against the anchor facts, through the real
 * model dispatch. Two modes, both scored by code (`lib/avt-verification-score`):
 *
 *   grade      each labelled claim is graded as a run grades it (its words,
 *              the passage it sits in, every included fact): the grader alone
 *   pipeline   the document is read and its claims extracted; each labelled
 *              claim is matched to the extracted claim covering its words and
 *              scored on the verdict the run gave that claim; a claim the
 *              extraction missed is wrong
 *
 * Subcommands (from apps/api):
 *   bun run eval:avt-verification check <set.json>...
 *   bun run eval:avt-verification text <set.json> [--case <id>]
 *   bun run eval:avt-verification run <set.json>... --models <id,...>
 *       [--mode grade|pipeline|both] [--repeats 1] [--seed 1]
 *       [--max-usd 5] [--case <id>] [--out <directory>]
 *   bun run eval:avt-verification score <results.json> <set.json>...
 *
 * `--models` is required: every call is paid for. Ids take the
 * `provider::modelId` form (`anthropic::claude-opus-5-5`); the model serves
 * every role, as an organization's own model selection does. A run refuses
 * its next call once its spend reaches `--max-usd`, through the engine's own
 * run-budget check, and still writes what it has. Spend is priced with the
 * production usage rates from each call's reported tokens, cache included.
 * `--seed` orders the claims, and so the grading batches; each repeat uses
 * the next seed. Model sampling itself is not seeded: repeats measure it.
 *
 * `--out` receives `results.json` (every claim's label and answer, per model,
 * repeat and mode, with cost, latency and the system prompts' hashes) and
 * `summary.md`. Keep both out of the repository. `score` scores a saved
 * run again against the sets' current labels, without a model call.
 */
import type { TokenUsage } from "@tanstack/ai";
import { panic, Result, UnhandledException } from "better-result";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { MODEL_RATE_UNITS_PER_USD } from "@stll/ai-catalog";
import { mapWithConcurrency } from "@stll/concurrency";
import { sha256Hex as sha256 } from "@stll/sha256/bun";

import type { SafeDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { decideFeatureAccess } from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { extractClaims } from "@/api/lib/lists/verification/claim-extract";
import { gradeClaims } from "@/api/lib/lists/verification/claim-grade";
import { CLAIM_STATES } from "@/api/lib/lists/verification/contract";
import type {
  ClaimGrade,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import type { VerificationModelDeps } from "@/api/lib/lists/verification/model-call";
import { passageContext } from "@/api/lib/lists/verification/paragraph-scope";
import {
  claimQualifiers,
  restingFactIds,
} from "@/api/lib/lists/verification/qualifiers";
import { ListVerificationRunCapError } from "@/api/lib/lists/verification/run-caps";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import {
  computeRawUsageMicroUnits,
  normalizeProviderPromptTokens,
} from "@/api/lib/usage/unit-model";

import { readCaseDocument } from "./lib/avt-verification-documents";
import type { CaseDocument } from "./lib/avt-verification-documents";
import { matchLabelledSpan } from "./lib/avt-verification-match";
import { renderScorecard, scoreOutcomes } from "./lib/avt-verification-score";
import type {
  ClaimOutcome,
  PredictedGrade,
} from "./lib/avt-verification-score";
import { labelledSetSchema, labelProblems } from "./lib/avt-verification-set";
import type { LabelledCase, LabelledSet } from "./lib/avt-verification-set";
import { resolveModelTargets } from "./lib/org-model-targets";

type LoadedSet = { set: LabelledSet; directory: string };

const loadSet = async (file: string): Promise<LoadedSet> => {
  const parsed = v.safeParse(
    labelledSetSchema,
    JSON.parse(await readFile(file, "utf-8")),
  );
  if (!parsed.success) {
    return panic(
      `${file}: ${parsed.issues
        .slice(0, 5)
        .map((issue) => `${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { set: parsed.output, directory: path.dirname(path.resolve(file)) };
};

/** Schema, label ids and every quote's place in the text a run reads. */
const check = async (files: readonly string[]): Promise<boolean> => {
  let ok = true;
  for (const file of files) {
    const { set, directory } = await loadSet(file);
    const problems = labelProblems(set);
    let claims = 0;
    for (const item of set.cases) {
      const document = await readCaseDocument(item, directory);
      claims += item.claims.length;
      problems.push(
        ...document.unlocated.map(
          (claim) =>
            `${item.id}/${claim.id}: quote not in the text the run reads: ${JSON.stringify(claim.quote.slice(0, 80))}`,
        ),
      );
    }
    process.stdout.write(
      `${set.id}: ${String(set.cases.length)} cases, ${String(claims)} claims, ${String(problems.length)} problems\n`,
    );
    for (const problem of problems) {
      process.stdout.write(`  ${problem}\n`);
    }
    ok &&= problems.length === 0;
  }
  return ok;
};

/** The text a run reads, block by block, to copy quotes from. */
const text = async (file: string, caseId: string | null): Promise<void> => {
  const { set, directory } = await loadSet(file);
  for (const item of set.cases) {
    if (caseId !== null && item.id !== caseId) {
      continue;
    }
    const { passages } = await readCaseDocument(item, directory);
    process.stdout.write(`# ${item.id}\n`);
    for (const passage of passages) {
      process.stdout.write(
        `\n## [${passage.block.id}]\n${passage.block.text.slice(passage.start, passage.end)}\n`,
      );
    }
  }
};

// --------------- Spend, latency and prompts ---------------

type Phase = "extract" | "grade";

type CallRecord = {
  phase: Phase;
  modelId: string;
  latencyMs: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  usd: number;
};

/** Every call of the process, in the order its usage arrived. */
const calls: CallRecord[] = [];
const spentUsd = () => calls.reduce((total, call) => total + call.usd, 0);
/** Hash of each system prompt the engine sent, by phase. */
const systemPrompts = new Map<string, { phase: Phase; sha256: string }>();
/** The provider options each model was called with, as sent. */
const modelOptionsSeen = new Map<string, Set<string>>();

/** The analytics the engine passes, with each model-bound member's usage
 *  hook replaced by this eval's pricing of the call. */
const pricedAnalytics = (
  inner: TanStackAIAnalyticsCallbacks,
  phase: Phase,
  startedAt: number,
): TanStackAIAnalyticsCallbacks => ({
  ...inner,
  forModel: (model) => {
    const bound = inner.forModel(model);
    return {
      ...pricedAnalytics(bound, phase, startedAt),
      middleware: {
        ...bound.middleware,
        onUsage: (ctx, usage: TokenUsage) => {
          const prompt = normalizeProviderPromptTokens({
            provider: model.provider,
            modelId: model.modelId,
            promptTokens: usage.promptTokens,
            cacheReadTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
            cacheWriteTokens: usage.promptTokensDetails?.cacheWriteTokens ?? 0,
          });
          calls.push({
            phase,
            modelId: model.modelId,
            latencyMs: performance.now() - startedAt,
            ...prompt,
            outputTokens: usage.completionTokens,
            usd:
              computeRawUsageMicroUnits({
                modelId: model.modelId,
                outputTokens: usage.completionTokens,
                ...prompt,
              }) / MODEL_RATE_UNITS_PER_USD,
          });
          const seen = modelOptionsSeen.get(model.modelId) ?? new Set<string>();
          seen.add(JSON.stringify(ctx.modelOptions ?? {}).slice(0, 400));
          modelOptionsSeen.set(model.modelId, seen);
          // Not passed on: production's hook meters usage into the
          // database, which this eval does not have; it prices it above.
        },
      },
    };
  },
});

/** The production dispatch, observed: its prompts hashed and its usage
 *  priced. Nothing it sends or receives is changed. */
const observedDispatch =
  (phase: Phase): typeof generateTanStackObjectForTask =>
  async (options) => {
    const system = options.system ?? "";
    systemPrompts.set(`${phase}:${sha256(system)}`, {
      phase,
      sha256: sha256(system),
    });
    return await generateTanStackObjectForTask({
      ...options,
      analytics:
        options.analytics === undefined
          ? undefined
          : pricedAnalytics(options.analytics, phase, performance.now()),
    });
  };

// --------------- Engine dependencies ---------------

const EVAL_ORGANIZATION_ID = toSafeId<"organization">("eval-org");
const EVAL_WORKSPACE_ID = toSafeId<"workspace">("eval-workspace");
const EVAL_USER_ID = "eval-user";

const access = decideFeatureAccess({
  registry: FEATURE_REGISTRY,
  featureId: LIST_VERIFICATION_FEATURE_ID,
  userId: EVAL_USER_ID,
  grants: {
    [LEGAL_LISTS_FEATURE_ID]: [
      { type: "organization", organizationId: EVAL_ORGANIZATION_ID },
    ],
    [LIST_VERIFICATION_FEATURE_ID]: [
      { type: "organization", organizationId: EVAL_ORGANIZATION_ID },
    ],
  },
  organizationId: EVAL_ORGANIZATION_ID,
  user: { email: "eval@example.test", emailVerified: true },
  membership: true,
});
const accessProof =
  access.status === "enabled"
    ? access.proof
    : panic("The eval organization needs list verification access");

// Usage is priced by this eval (`pricedAnalytics`), which never hands it to
// the production meter; there is no database to meter it into.
const noDatabase: SafeDb = async () =>
  await Promise.resolve(
    Result.err(
      new UnhandledException({
        cause: "The verification eval has no database",
      }),
    ),
  );

type DepsOptions = {
  orgAIConfig: OrgAIConfig;
  phase: Phase;
  maxUsd: number;
  scopeKey: string;
};

const engineDeps = ({
  orgAIConfig,
  phase,
  maxUsd,
  scopeKey,
}: DepsOptions): VerificationModelDeps => ({
  admission: admitFixtureModelDispatch({
    userId: null,
    organizationId: EVAL_ORGANIZATION_ID,
    actionKind: "workflow.background",
    modelTier: MANAGED_MODEL_TIER.standard,
  }),
  accessProof,
  refreshAccessProof: async () => await Promise.resolve(accessProof),
  checkRunBudget: async () =>
    await Promise.resolve(
      spentUsd() >= maxUsd
        ? Result.err(
            new ListVerificationRunCapError({
              message: `Eval spend reached ${maxUsd.toFixed(2)} USD`,
              reason: "daily",
              hint: "Raise --max-usd or run fewer claims",
            }),
          )
        : Result.ok(),
    ),
  organizationId: EVAL_ORGANIZATION_ID,
  workspaceId: EVAL_WORKSPACE_ID,
  entityVersionId: toSafeId<"entityVersion">(scopeKey),
  orgAIConfig,
  managedAIResidency: "eu",
  promptCachingEnabled: true,
  serviceTier: "standard",
  usageMetering: {
    actionType: "doc_review",
    organizationId: EVAL_ORGANIZATION_ID,
    safeDb: noDatabase,
    serviceTier: "standard",
    userId: toSafeId<"user">(EVAL_USER_ID),
    workspaceId: EVAL_WORKSPACE_ID,
  },
  abortSignal: AbortSignal.timeout(30 * 60_000),
  generateObjectForTask: observedDispatch(phase),
});

// --------------- Facts and answers ---------------

/** A label id as the entity id a run pins: stable across runs. */
const entityIdOf = (scope: string, factId: string): SafeId<"entity"> => {
  const hex = sha256(`${scope}/${factId}`);
  return toSafeId<"entity">(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
};

type CaseFacts = {
  /** What grading reads: the included facts, in list order. */
  evidence: VerificationEvidenceFact[];
  labelOf: ReadonlyMap<string, string>;
  tierOf: ReadonlyMap<string, LabelledCase["facts"][number]["tier"]>;
};

const caseFacts = (scope: string, item: LabelledCase): CaseFacts => {
  const labelOf = new Map<string, string>();
  const tierOf = new Map<string, LabelledCase["facts"][number]["tier"]>();
  const evidence: VerificationEvidenceFact[] = [];
  for (const fact of item.facts) {
    const factEntityId = entityIdOf(scope, fact.id);
    labelOf.set(factEntityId, fact.id);
    tierOf.set(factEntityId, fact.tier);
    if (fact.scoring === "held") {
      continue;
    }
    evidence.push({
      factEntityId,
      text: fact.text,
      occurredOn: fact.occurredOn,
      occurredOnPrecision: fact.occurredOnPrecision,
      evidenceKind: fact.evidenceKind,
      medium: fact.medium,
      confidence: fact.confidence,
      interpretationNote: fact.interpretationNote,
      sources: [],
    });
  }
  return { evidence, labelOf, tierOf };
};

/** A grade in label fact ids, with the qualifiers a reader would show. */
const predictedOf = (grade: ClaimGrade, facts: CaseFacts): PredictedGrade => {
  const label = (factId: SafeId<"entity">) =>
    facts.labelOf.get(factId) ?? panic(`Unknown fact ${factId}`);
  const resting = restingFactIds(
    { verdict: grade, refs: grade.refs },
    null,
  ).map((factId) => ({
    scoring: "included" as const,
    tier: facts.tierOf.get(factId) ?? "document",
  }));
  return {
    state: grade.state,
    refs: grade.refs.map((ref) => ({
      factId: label(ref.factEntityId),
      rel: ref.rel,
    })),
    conflict:
      grade.recordConflict === null
        ? null
        : [
            label(grade.recordConflict.factEntityIds[0]),
            label(grade.recordConflict.factEntityIds[1]),
          ],
    qualifiers: claimQualifiers({
      graded: grade.qualifiers,
      resting,
    }).map((qualifier) => qualifier.kind),
  };
};

/** A deterministic shuffle: the seed fixes the claim order. */
const seededOrder = <T>(items: readonly T[], seed: number): T[] => {
  // Park-Miller: small, exact in doubles, and the same on every machine.
  const modulus = 2_147_483_647;
  let state = (((seed % (modulus - 1)) + (modulus - 1)) % (modulus - 1)) + 1;
  const next = () => {
    state = (state * 48_271) % modulus;
    return state / modulus;
  };
  return items
    .map((item) => ({ item, key: next() }))
    .toSorted((a, b) => a.key - b.key)
    .map(({ item }) => item);
};

// --------------- One case ---------------

/** Why grading left claims without a grade, or null when it graded all. */
const gradingFailure = (
  graded: Awaited<ReturnType<typeof gradeClaims>>,
): string | null => {
  if (Result.isError(graded)) {
    return graded.error.message;
  }
  return graded.value.type === "incomplete"
    ? `${String(graded.value.ungraded)} claims left ungraded`
    : null;
};

type CaseRun = {
  outcomes: ClaimOutcome[];
  /** Extracted claims no label covers (pipeline). */
  unlabelledExtracted: number;
  extracted: number;
  durationMs: number;
  failure: string | null;
  /** Per labelled claim: the extracted words it was matched to. */
  matchedText: Record<string, string>;
  /** Every claim extraction listed, in reading order (pipeline). */
  extractedClaims?:
    { blockId: string; type: string; text: string }[] | undefined;
};

type CaseInput = {
  setId: string;
  item: LabelledCase;
  document: CaseDocument;
  orgAIConfig: OrgAIConfig;
  maxUsd: number;
  seed: number;
  scope: string;
};

const missedAll = (
  input: CaseInput,
  because: ClaimOutcome["missedBecause"],
): ClaimOutcome[] =>
  input.item.claims.map((label) => ({
    setId: input.setId,
    caseId: input.item.id,
    label,
    predicted: null,
    missedBecause: because,
  }));

const gradeMode = async (input: CaseInput): Promise<CaseRun> => {
  const startedAt = performance.now();
  const facts = caseFacts(input.scope, input.item);
  const { passages, located } = input.document;
  const ordered = seededOrder(located, input.seed);
  const graded = await gradeClaims({
    claims: ordered.map(({ claim, passageIndex, start, end }) => {
      const passage =
        passages[passageIndex] ?? panic("A located claim names no passage");
      return {
        key: claim.id,
        text: passage.block.text.slice(start, end),
        context: passageContext(passage, { start, end }),
        linkedFactIds: [],
      };
    }),
    facts: facts.evidence,
    deps: engineDeps({
      orgAIConfig: input.orgAIConfig,
      phase: "grade",
      maxUsd: input.maxUsd,
      scopeKey: input.scope,
    }),
  });
  const durationMs = performance.now() - startedAt;
  if (Result.isError(graded)) {
    return {
      outcomes: missedAll(input, "not-graded"),
      unlabelledExtracted: 0,
      extracted: 0,
      durationMs,
      failure: graded.error.message,
      matchedText: {},
    };
  }
  return {
    outcomes: input.item.claims.map((label) => {
      const grade = graded.value.grades.get(label.id);
      return {
        setId: input.setId,
        caseId: input.item.id,
        label,
        predicted: grade === undefined ? null : predictedOf(grade, facts),
        missedBecause: grade === undefined ? "not-graded" : null,
      };
    }),
    unlabelledExtracted: 0,
    extracted: 0,
    durationMs,
    failure:
      graded.value.type === "incomplete"
        ? `${String(graded.value.ungraded)} claims left ungraded`
        : null,
    matchedText: {},
  };
};

const pipelineMode = async (input: CaseInput): Promise<CaseRun> => {
  const startedAt = performance.now();
  const facts = caseFacts(input.scope, input.item);
  const { passages, located } = input.document;
  const deps = (phase: Phase) =>
    engineDeps({
      orgAIConfig: input.orgAIConfig,
      phase,
      maxUsd: input.maxUsd,
      scopeKey: input.scope,
    });
  const extracted = await extractClaims({ passages, deps: deps("extract") });
  if (Result.isError(extracted)) {
    return {
      outcomes: missedAll(input, "not-extracted"),
      unlabelledExtracted: 0,
      extracted: 0,
      durationMs: performance.now() - startedAt,
      failure: extracted.error.message,
      matchedText: {},
    };
  }
  const claims = extracted.value;
  // As a run grades: every fact claim, with the passage it sits in.
  const factClaims = claims.flatMap((claim, position) =>
    claim.type === "fact" ? [{ claim, position }] : [],
  );
  const graded = await gradeClaims({
    claims: seededOrder(factClaims, input.seed).map(({ claim, position }) => ({
      key: String(position),
      text: claim.text,
      context: passageContext(
        passages[claim.blockIndex] ??
          panic("An extracted claim names no passage"),
        claim.anchor,
      ),
      linkedFactIds: [],
    })),
    facts: facts.evidence,
    deps: deps("grade"),
  });
  const durationMs = performance.now() - startedAt;
  const grades = Result.isError(graded)
    ? new Map<string, ClaimGrade>()
    : graded.value.grades;
  const spans = claims.map((claim) => ({
    passageIndex: claim.blockIndex,
    start: claim.anchor.start,
    end: claim.anchor.end,
  }));
  const used = new Set<number>();
  const matchedText: Record<string, string> = {};
  const outcomes = input.item.claims.map((label): ClaimOutcome => {
    const place = located.find((entry) => entry.claim.id === label.id);
    const index = place === undefined ? null : matchLabelledSpan(place, spans);
    const claim = index === null ? undefined : claims[index];
    if (index === null || claim === undefined) {
      return {
        setId: input.setId,
        caseId: input.item.id,
        label,
        predicted: null,
        missedBecause: "not-extracted",
      };
    }
    used.add(index);
    matchedText[label.id] = claim.text;
    if (claim.type !== "fact") {
      // A claim extraction sets aside is never graded: a run stores it as
      // not verifiable.
      return {
        setId: input.setId,
        caseId: input.item.id,
        label,
        predicted: {
          state: "notverifiable",
          refs: [],
          conflict: null,
          qualifiers: [],
        },
        missedBecause: null,
      };
    }
    const grade = grades.get(String(index));
    return {
      setId: input.setId,
      caseId: input.item.id,
      label,
      predicted: grade === undefined ? null : predictedOf(grade, facts),
      missedBecause: grade === undefined ? "not-graded" : null,
    };
  });
  return {
    outcomes,
    unlabelledExtracted: claims.length - used.size,
    extracted: claims.length,
    durationMs,
    failure: gradingFailure(graded),
    matchedText,
    extractedClaims: claims.map((claim) => ({
      blockId: passages[claim.blockIndex]?.block.id ?? "",
      type: claim.type,
      text: claim.text,
    })),
  };
};

// --------------- Run ---------------

type Mode = "grade" | "pipeline";

type RunOptions = {
  sets: string[];
  models: string[];
  modes: Mode[];
  repeats: number;
  seed: number;
  maxUsd: number;
  caseFilter: string | null;
  out: string | null;
};

const parseRunArgs = (args: readonly string[]): RunOptions => {
  const options: RunOptions = {
    sets: [],
    models: [],
    modes: ["grade"],
    repeats: 1,
    seed: 1,
    maxUsd: 5,
    caseFilter: null,
    out: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      options.sets.push(arg);
      continue;
    }
    const value = args[index + 1] ?? panic(`${arg} needs a value`);
    index += 1;
    switch (arg) {
      case "--models":
        options.models = value.split(",").filter((model) => model !== "");
        break;
      case "--mode":
        if (value !== "grade" && value !== "pipeline" && value !== "both") {
          return panic(`Unknown mode ${value}`);
        }
        options.modes = value === "both" ? ["grade", "pipeline"] : [value];
        break;
      case "--repeats":
        options.repeats = Number.parseInt(value, 10);
        break;
      case "--seed":
        options.seed = Number.parseInt(value, 10);
        break;
      case "--max-usd":
        options.maxUsd = Number.parseFloat(value);
        break;
      case "--case":
        options.caseFilter = value;
        break;
      case "--out":
        options.out = value;
        break;
      default:
        return panic(`Unknown flag ${arg}`);
    }
  }
  if (options.models.length === 0) {
    return panic("--models is required: every model call is paid for");
  }
  if (options.sets.length === 0) {
    return panic("Name at least one labelled set");
  }
  if (
    !Number.isInteger(options.repeats) ||
    options.repeats < 1 ||
    !Number.isInteger(options.seed) ||
    !(options.maxUsd > 0)
  ) {
    return panic(
      "--repeats and --seed take integers, --max-usd a positive number",
    );
  }
  return options;
};

type RunRecord = {
  model: string;
  repeat: number;
  seed: number;
  mode: Mode;
  usd: number;
  durationMs: number;
  cases: ({ setId: string; caseId: string } & Omit<CaseRun, "outcomes">)[];
  outcomes: ClaimOutcome[];
};

const CASE_CONCURRENCY = 3;

const run = async (options: RunOptions): Promise<void> => {
  const loaded = await Promise.all(options.sets.map(loadSet));
  const prepared: {
    setId: string;
    item: LabelledCase;
    document: CaseDocument;
  }[] = [];
  for (const { set, directory } of loaded) {
    const problems = labelProblems(set);
    if (problems.length > 0) {
      panic(`${set.id} has label problems:\n${problems.join("\n")}`);
    }
    for (const item of set.cases) {
      if (options.caseFilter !== null && item.id !== options.caseFilter) {
        continue;
      }
      const document = await readCaseDocument(item, directory);
      if (document.unlocated.length > 0) {
        panic(
          `${set.id}/${item.id}: quotes not found: ${document.unlocated.map((claim) => claim.id).join(", ")}`,
        );
      }
      prepared.push({ setId: set.id, item, document });
    }
  }
  if (prepared.length === 0) {
    panic("No case to run");
  }

  const records: RunRecord[] = [];
  const failures: string[] = [];
  for (const target of resolveModelTargets(options.models)) {
    if (target.type === "resolution-error") {
      failures.push(`${target.id}: ${target.message}`);
      continue;
    }
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      const seed = options.seed + repeat - 1;
      for (const mode of options.modes) {
        const spentBefore = spentUsd();
        const startedAt = performance.now();
        process.stderr.write(
          `${target.id} · ${mode} · repeat ${String(repeat)} (seed ${String(seed)})\n`,
        );
        const caseRuns = await mapWithConcurrency({
          items: prepared,
          limit: CASE_CONCURRENCY,
          operation: async ({ setId, item, document }) => {
            const input: CaseInput = {
              setId,
              item,
              document,
              orgAIConfig: target.orgAIConfig,
              maxUsd: options.maxUsd,
              seed,
              scope: `${setId}/${item.id}`,
            };
            const result =
              mode === "grade"
                ? await gradeMode(input)
                : await pipelineMode(input);
            process.stderr.write(
              `  ${setId}/${item.id}: ${(result.durationMs / 1000).toFixed(1)}s, spent ${spentUsd().toFixed(3)} USD${result.failure === null ? "" : ` · ${result.failure}`}\n`,
            );
            return { setId, caseId: item.id, ...result };
          },
        });
        records.push({
          model: target.id,
          repeat,
          seed,
          mode,
          usd: spentUsd() - spentBefore,
          durationMs: performance.now() - startedAt,
          cases: caseRuns.map(({ outcomes: _outcomes, ...rest }) => rest),
          outcomes: caseRuns.flatMap(({ outcomes }) => outcomes),
        });
        for (const caseRun of caseRuns) {
          if (caseRun.failure !== null) {
            failures.push(
              `${target.id} ${mode} r${String(repeat)} ${caseRun.setId}/${caseRun.caseId}: ${caseRun.failure}`,
            );
          }
        }
      }
    }
  }

  const summary = renderSummary(records, failures, calls);
  process.stdout.write(summary);
  if (options.out !== null) {
    await mkdir(options.out, { recursive: true });
    await writeFile(path.join(options.out, "summary.md"), summary);
    await writeFile(
      path.join(options.out, "results.json"),
      JSON.stringify(
        {
          startedFrom: process.argv.slice(2),
          sets: loaded.map(({ set }) => set.id),
          systemPrompts: [...systemPrompts.values()],
          modelOptions: Object.fromEntries(
            [...modelOptionsSeen].map(([model, seen]) => [model, [...seen]]),
          ),
          calls,
          records,
          failures,
        },
        null,
        2,
      ),
    );
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

const percentile = (values: readonly number[], share: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
  );
};

const renderSummary = (
  records: readonly RunRecord[],
  failures: readonly string[],
  callRecords: readonly CallRecord[],
): string => {
  const totalUsd = callRecords.reduce((sum, call) => sum + call.usd, 0);
  const sections: string[] = ["# Verification eval", ""];
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.model} · ${record.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  for (const [key, group] of groups) {
    const outcomes = group.flatMap((record) => record.outcomes);
    sections.push(
      renderScorecard(
        `${key} · ${String(group.length)} repeat(s)`,
        scoreOutcomes(outcomes),
      ),
    );
    const perRepeat = group.map((record) => {
      const card = scoreOutcomes(record.outcomes);
      return card.accuracy.of === 0 ? 0 : card.accuracy.hits / card.accuracy.of;
    });
    const caseDurations = group.flatMap((record) =>
      record.cases.map((item) => item.durationMs / 1000),
    );
    sections.push(
      `accuracy per repeat: ${perRepeat.map((value) => `${(100 * value).toFixed(1)}%`).join(", ")}`,
      `cost: ${group.map((record) => `${record.usd.toFixed(3)} USD`).join(", ")} · case latency p50 ${percentile(caseDurations, 0.5).toFixed(1)}s, p90 ${percentile(caseDurations, 0.9).toFixed(1)}s`,
    );
    const pipelineCases = group.flatMap((record) =>
      record.mode === "pipeline" ? record.cases : [],
    );
    if (pipelineCases.length > 0) {
      const missedExtraction = outcomes.filter(
        (outcome) => outcome.missedBecause === "not-extracted",
      ).length;
      sections.push(
        `extraction: ${String(pipelineCases.reduce((total, item) => total + item.extracted, 0))} claims extracted, ${String(pipelineCases.reduce((total, item) => total + item.unlabelledExtracted, 0))} not labelled; labelled claims not extracted ${String(missedExtraction)}/${String(outcomes.length)}`,
      );
    }
    sections.push("");
  }
  const phases = ["extract", "grade"] as const;
  sections.push(
    "## Spend",
    "",
    "| model | phase | calls | uncached in | cache read | cache write | out | USD | call p50 s | call p90 s |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  const models = [...new Set(callRecords.map((call) => call.modelId))];
  for (const model of models) {
    for (const phase of phases) {
      const own = callRecords.filter(
        (call) => call.modelId === model && call.phase === phase,
      );
      if (own.length === 0) {
        continue;
      }
      const sum = (pick: (call: CallRecord) => number) =>
        own.reduce((total, call) => total + pick(call), 0);
      sections.push(
        `| ${model} | ${phase} | ${String(own.length)} | ${String(sum((call) => call.uncachedInputTokens))} | ${String(sum((call) => call.cacheReadTokens))} | ${String(sum((call) => call.cacheWriteTokens))} | ${String(sum((call) => call.outputTokens))} | ${sum((call) => call.usd).toFixed(3)} | ${(
          percentile(
            own.map((call) => call.latencyMs),
            0.5,
          ) / 1000
        ).toFixed(1)} | ${(
          percentile(
            own.map((call) => call.latencyMs),
            0.9,
          ) / 1000
        ).toFixed(1)} |`,
      );
    }
  }
  sections.push("", `total ${totalUsd.toFixed(3)} USD`, "");
  if (failures.length > 0) {
    sections.push(
      "## Failures",
      "",
      ...failures.map((failure) => `- ${failure}`),
      "",
    );
  }
  return sections.join("\n");
};

/** What `score` reads of a saved run: the answers, not the old labels. */
const savedResultsSchema = v.object({
  records: v.array(
    v.object({
      model: v.string(),
      repeat: v.number(),
      seed: v.number(),
      mode: v.picklist(["grade", "pipeline"]),
      usd: v.number(),
      durationMs: v.number(),
      cases: v.array(
        v.object({
          setId: v.string(),
          caseId: v.string(),
          unlabelledExtracted: v.number(),
          extracted: v.number(),
          durationMs: v.number(),
          failure: v.nullable(v.string()),
          matchedText: v.record(v.string(), v.string()),
          extractedClaims: v.optional(
            v.array(
              v.object({
                blockId: v.string(),
                type: v.string(),
                text: v.string(),
              }),
            ),
          ),
        }),
      ),
      outcomes: v.array(
        v.object({
          setId: v.string(),
          caseId: v.string(),
          label: v.looseObject({ id: v.string() }),
          predicted: v.nullable(
            v.object({
              state: v.picklist(CLAIM_STATES),
              refs: v.array(
                v.object({
                  factId: v.string(),
                  rel: v.picklist(["supports", "conflicts", "record"]),
                }),
              ),
              conflict: v.nullable(v.tuple([v.string(), v.string()])),
              qualifiers: v.array(v.string()),
            }),
          ),
          missedBecause: v.nullable(
            v.picklist(["not-extracted", "not-graded"]),
          ),
        }),
      ),
    }),
  ),
  failures: v.array(v.string()),
  calls: v.array(
    v.object({
      phase: v.picklist(["extract", "grade"]),
      modelId: v.string(),
      latencyMs: v.number(),
      uncachedInputTokens: v.number(),
      cacheReadTokens: v.number(),
      cacheWriteTokens: v.number(),
      outputTokens: v.number(),
      usd: v.number(),
    }),
  ),
});

/**
 * A saved run scored again against the sets' current labels, with no model
 * call: a label corrected after a run changes the score, not the answers.
 * Claims are matched by set, case and id; a label no longer in the sets
 * drops out.
 */
const rescore = async (
  resultsFile: string,
  setFiles: readonly string[],
): Promise<string> => {
  const saved = v.parse(
    savedResultsSchema,
    JSON.parse(await readFile(resultsFile, "utf-8")),
  );
  const labels = new Map<string, LabelledCase["claims"][number]>();
  for (const { set } of await Promise.all(setFiles.map(loadSet))) {
    for (const item of set.cases) {
      for (const claim of item.claims) {
        labels.set(`${set.id}/${item.id}/${claim.id}`, claim);
      }
    }
  }
  const records = saved.records.map((record): RunRecord => ({
    ...record,
    outcomes: record.outcomes.flatMap((outcome): ClaimOutcome[] => {
      const label = labels.get(
        `${outcome.setId}/${outcome.caseId}/${outcome.label.id}`,
      );
      return label === undefined ? [] : [{ ...outcome, label }];
    }),
  }));
  return renderSummary(records, saved.failures, saved.calls);
};

const main = async () => {
  const [command = "", ...rest] = process.argv.slice(2);
  switch (command) {
    case "check": {
      if (!(await check(rest))) {
        process.exitCode = 1;
      }
      return;
    }
    case "text": {
      const caseFlag = rest.indexOf("--case");
      await text(
        rest[0] ?? panic("text needs a set file"),
        caseFlag === -1 ? null : (rest[caseFlag + 1] ?? null),
      );
      return;
    }
    case "run": {
      await run(parseRunArgs(rest));
      return;
    }
    case "score": {
      const [results, ...sets] = rest;
      process.stdout.write(
        await rescore(results ?? panic("score needs a results file"), sets),
      );
      return;
    }
    default: {
      panic(`Unknown command "${command}": check, text, run or score`);
    }
  }
};

await main();
