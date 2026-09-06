/**
 * suggest_changes precision eval: given a DOCX and an edit request, does a
 * model change exactly what was asked and nothing else, and do the
 * compiler's skips match what it intended?
 *
 * Each task builds a fixture DOCX from markdown, opens it in a headless
 * `FolioDocxReviewer`, and gives the model the production folio-agents
 * tools (`read_document`, `find_text`, `get_document_outline`,
 * `suggest_changes`) executed in-process over the reviewer bridge in direct
 * mode. The system prompt lists the editable blocks with their
 * `blockTextHash`, as the file overlay does. Scoring compares the document
 * text before and after:
 *
 *   outcome      pass / declined (the document drifted under the model,
 *                nothing was applied, and it said so) / fail (an
 *                expectation missed, or success claimed with nothing
 *                applied) / no-call (no suggest_changes call) / error
 *                (the provider refused)
 *   calls        suggest_changes calls in the turn
 *   applied      operations the reviewer applied
 *   skipped      operations skipped, with folio's reasons
 *   guarded      operations that carried a `precondition.blockTextHash`
 *   changed      blocks whose text changed, plus blocks added and removed
 *   collateral   changed or removed blocks the request did not concern
 *   missing      expectations that did not hold
 *
 * Usage (from apps/api):
 *   bun run eval:suggest-changes
 *   bun run eval:suggest-changes -- --models gpt-5.6-luna --task rename-party
 *   bun run eval:suggest-changes -- --runs 3 --json out.json
 */
import { EventType, maxIterations, toolDefinition } from "@tanstack/ai";
import type { AnyServerTool, TokenUsage } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { writeFile } from "node:fs/promises";

import { DOCX_SUGGEST_CHANGES_AUTO_APPLY_OPTIONS } from "@stll/api-contract/chat-docx-suggestions";
import {
  createReviewerBridge,
  executeFolioToolCallUntyped,
  FOLIO_AGENT_TOOL_NAMES,
  getFolioToolDefinitions,
} from "@stll/folio-agents";
import type { FolioAgentToolOptions } from "@stll/folio-agents";
import {
  FolioDocxReviewer,
  isFolioAIContentBlock,
} from "@stll/folio-core/server";
import type { FolioAIEditSnapshot } from "@stll/folio-core/server";

import { resolveCaching } from "@/api/lib/ai-config";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

import { runEvalModelTurn } from "./lib/model-turn";

// A bare id resolves through whichever configured provider rates it (GPT
// models may come from OpenAI or OpenRouter); Claude ids are pinned to
// Anthropic so a non-Anthropic default provider cannot claim them.
const DEFAULT_MODELS = ["gpt-5.6-luna", "anthropic::claude-sonnet-5"];
const DEFAULT_RUNS = 1;
// Every run is a paid request; keep a typo from turning into a bill.
const MAX_RUNS = 20;
const MAX_OUTPUT_TOKENS = 4000;
const MAX_ITERATIONS = 8;
const MODEL_REQUEST_TIMEOUT_MS = 240_000;

const TOOL_OPTIONS: FolioAgentToolOptions = {
  suggestChanges: DOCX_SUGGEST_CHANGES_AUTO_APPLY_OPTIONS,
};

const REGISTERED_TOOL_NAMES = new Set<string>([
  FOLIO_AGENT_TOOL_NAMES.readDocument,
  FOLIO_AGENT_TOOL_NAMES.findText,
  FOLIO_AGENT_TOOL_NAMES.getDocumentOutline,
  FOLIO_AGENT_TOOL_NAMES.suggestChanges,
]);

const SYSTEM_PROMPT = [
  "You edit the DOCX open in the editor for a lawyer. The user's request is",
  "about this document. Call `suggest_changes` with operations on the block",
  "ids listed below; prefer `replaceInBlock` with an exact `find` string for",
  "a localized edit, `replaceBlock` for a whole paragraph, `deleteBlock` to",
  "remove one, `insertAfterBlock` / `insertBeforeBlock` for new paragraphs.",
  "Copy each block's `blockTextHash` into `precondition.blockTextHash` on",
  "every operation that targets it. Change only what the request concerns.",
  "After the tool returns, reply with one short sentence.",
].join(" ");

const SERVICES_AGREEMENT = [
  "# Services Agreement",
  "",
  "## 1. Parties",
  "",
  'This Services Agreement is made between Alpha Ltd, a company registered in England ("Client"), and Beta s.r.o., a company registered in the Czech Republic ("Provider").',
  "",
  "## 2. Services",
  "",
  "Provider shall deliver the consulting services described in Schedule 1 to Alpha Ltd.",
  "",
  "## 3. Fees",
  "",
  "Client shall pay the fees within 30 days of receiving a valid invoice.",
  "",
  "## 4. Term and Termination",
  "",
  "This Agreement continues until terminated. Either party may terminate this Agreement on 30 days' written notice.",
  "",
  "## 5. Confidentiality",
  "",
  "Each party shall keep the other party's confidential information secret and use it only for the purposes of this Agreement.",
  "",
  "## 6. Non-solicitation",
  "",
  "For twelve months after termination, Client shall not solicit any employee of Provider who worked on the Services.",
  "",
  "## 7. Governing law",
  "",
  "This Agreement is governed by the laws of England and Wales.",
].join("\n");

const CZECH_WORK_CONTRACT = [
  "# Smlouva o dílo",
  "",
  "## 1. Předmět smlouvy",
  "",
  "Zhotovitel se zavazuje provést pro objednatele dílo spočívajíci v rekonstrukci koupelny.",
  "",
  "## 2. Cena",
  "",
  "Cena díla činí 250 000 Kč bez DPH a je splatna do 14 dnů od předání díla.",
  "",
  "## 3. Termín",
  "",
  "Zhotovitel dokončí dílo nejpozdeji do 30. 6. 2027.",
].join("\n");

type Expectation =
  | { kind: "contains"; text: string; count?: number }
  | { kind: "notContains"; text: string }
  | { kind: "matches"; pattern: RegExp; label: string }
  /** Every match of a global pattern (its first capture, if any) is distinct. */
  | { kind: "unique"; pattern: RegExp; label: string }
  | { kind: "ordered"; before: string; after: string };

/**
 * An edit applied after the model has seen the block listing but before it
 * acts, so the hashes it holds for that block are stale.
 */
type DocumentDrift = {
  /** Substring identifying the block to change. */
  blockText: string;
  text: string;
};

type EvalTask = {
  id: string;
  document: string;
  request: string;
  /** Original block texts the request concerns; every other change is collateral. */
  concerns: (blockText: string) => boolean;
  /** Inserted block texts the request calls for; every other insertion is collateral. */
  allowsAdded?: (blockText: string) => boolean;
  expectations: readonly Expectation[];
  drift?: DocumentDrift;
};

const TASKS: readonly EvalTask[] = [
  {
    id: "rename-party",
    document: SERVICES_AGREEMENT,
    request:
      "Rename Alpha Ltd to Alpha Holdings Ltd everywhere in the agreement.",
    concerns: (text) => text.includes("Alpha Ltd"),
    expectations: [
      { kind: "contains", text: "Alpha Holdings Ltd", count: 2 },
      { kind: "notContains", text: "Alpha Ltd," },
      { kind: "notContains", text: "to Alpha Ltd." },
    ],
  },
  {
    id: "notice-period",
    document: SERVICES_AGREEMENT,
    request: "Change the termination notice period to 45 days.",
    concerns: (text) => text.includes("written notice"),
    expectations: [
      {
        kind: "contains",
        text: "This Agreement continues until terminated. Either party may terminate this Agreement on 45 days' written notice.",
      },
      { kind: "contains", text: "within 30 days of receiving a valid invoice" },
    ],
  },
  {
    id: "delete-clause",
    document: SERVICES_AGREEMENT,
    request: "Remove the non-solicitation clause entirely, heading included.",
    concerns: (text) => text.includes("solicit"),
    expectations: [
      { kind: "notContains", text: "solicit" },
      { kind: "contains", text: "Governing law" },
      { kind: "contains", text: "confidential information" },
    ],
  },
  {
    id: "insert-clause",
    document: SERVICES_AGREEMENT,
    request:
      "Add a short force majeure clause as a new numbered clause right after the Confidentiality clause.",
    // Renumbering the clauses that follow is part of the request.
    concerns: (text) =>
      /^\d+\. (?:Non-solicitation|Governing law)$/u.test(text),
    allowsAdded: (text) =>
      /force majeure|beyond (?:its|their|a party's|the parties') reasonable control|acts? of god/iu.test(
        text,
      ),
    expectations: [
      {
        // Its own clause-level heading block, numbered in sequence.
        kind: "matches",
        pattern: /\(h2\) 6\. Force majeure\n\[/iu,
        label: "force majeure heading as clause 6",
      },
      {
        kind: "matches",
        pattern: /\(h2\) 7\. Non-solicitation/u,
        label: "renumbered clause 7",
      },
      {
        kind: "matches",
        pattern: /\(h2\) 8\. Governing law/u,
        label: "renumbered clause 8",
      },
      { kind: "unique", pattern: /\(h2\) (\d+)\./gu, label: "clause numbers" },
      { kind: "contains", text: "solicit" },
    ],
  },
  {
    // The listing the model holds is stale: the notice clause changed
    // underneath it. A guarded operation is skipped; the model should re-read
    // and retry, or say so, but never claim success.
    id: "notice-period-stale",
    document: SERVICES_AGREEMENT,
    request: "Change the termination notice period to 45 days.",
    drift: {
      blockText: "written notice",
      text: "This Agreement continues until terminated. Either party may terminate this Agreement on 60 days' written notice, or immediately for material breach.",
    },
    concerns: (text) => text.includes("written notice"),
    expectations: [
      {
        kind: "contains",
        text: "This Agreement continues until terminated. Either party may terminate this Agreement on 45 days' written notice, or immediately for material breach.",
      },
    ],
  },
  {
    id: "governing-law",
    document: SERVICES_AGREEMENT,
    request: "Change the governing law to the laws of the Czech Republic.",
    concerns: (text) => text.includes("governed by"),
    expectations: [
      {
        kind: "matches",
        pattern:
          /^\[[0-9A-F]+\] This Agreement is governed by the laws of the Czech Republic\.$/mu,
        label: "new governing law sentence",
      },
      { kind: "notContains", text: "England and Wales" },
      { kind: "contains", text: 'registered in England ("Client")' },
    ],
  },
  {
    id: "cs-typos",
    document: CZECH_WORK_CONTRACT,
    request: "Oprav překlepy a chybějící diakritiku v celém dokumentu.",
    concerns: () => true,
    expectations: [
      { kind: "contains", text: "spočívající" },
      { kind: "contains", text: "splatná" },
      { kind: "contains", text: "nejpozději" },
      { kind: "contains", text: "250 000 Kč" },
      { kind: "contains", text: "30. 6. 2027" },
    ],
  },
];

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  jsonPath: string | null;
};

const parseRuns = (value: string): number => {
  if (!/^\d+$/u.test(value)) {
    return DEFAULT_RUNS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return DEFAULT_RUNS;
  }
  return Math.min(MAX_RUNS, parsed);
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
        options.runs = parseRuns(value);
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

type ToolTrace = {
  name: string;
  input: unknown;
  output: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ToolContext = {
  trace: ToolTrace[];
  bridge: ReturnType<typeof createReviewerBridge>;
};

const createEvalTools = ({ trace, bridge }: ToolContext): AnyServerTool[] =>
  getFolioToolDefinitions(TOOL_OPTIONS)
    .filter((definition) => REGISTERED_TOOL_NAMES.has(definition.name))
    .map((definition) =>
      toolDefinition({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }).server((input) => {
        const output = executeFolioToolCallUntyped(
          definition.name,
          input,
          bridge,
          TOOL_OPTIONS,
        );
        trace.push({ name: definition.name, input, output });
        return output;
      }),
    );

const renderEditableBlocks = (snapshot: FolioAIEditSnapshot): string =>
  JSON.stringify(
    snapshot.blocks.filter(isFolioAIContentBlock).map((block) => ({
      blockId: block.id,
      kind: block.kind,
      headingLevel: block.headingLevel,
      styleId: block.styleId,
      text: block.text,
      blockTextHash: snapshot.anchors[block.id]?.textHash,
    })),
  );

type ModelTurn = {
  error: string | null;
  finalText: string;
  latencyMs: number;
  usage: TokenUsage | null;
};

const runModelTurn = async ({
  model,
  request,
  snapshot,
  tools,
}: {
  model: ResolvedTanStackTextModel;
  request: string;
  snapshot: FolioAIEditSnapshot;
  tools: AnyServerTool[];
}): Promise<ModelTurn> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "chat",
    scopeKey: null,
  });
  const system = `${SYSTEM_PROMPT}\nEditable DOCX blocks:\n\`\`\`json\n${renderEditableBlocks(snapshot)}\n\`\`\``;
  let finalText = "";
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: request }],
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
  return { error, finalText, latencyMs, usage };
};

type SuggestChangesFacts = {
  calls: number;
  applied: number;
  skipped: string[];
  guarded: number;
  operations: number;
  normalizations: number;
  rejected: string[];
};

const suggestChangesFacts = (
  trace: readonly ToolTrace[],
): SuggestChangesFacts => {
  const facts: SuggestChangesFacts = {
    calls: 0,
    applied: 0,
    skipped: [],
    guarded: 0,
    operations: 0,
    normalizations: 0,
    rejected: [],
  };
  for (const entry of trace) {
    if (entry.name !== FOLIO_AGENT_TOOL_NAMES.suggestChanges) {
      continue;
    }
    facts.calls += 1;
    const operations = isRecord(entry.input)
      ? entry.input["operations"]
      : undefined;
    if (Array.isArray(operations)) {
      facts.operations += operations.length;
      facts.guarded += operations.filter(
        (operation) =>
          isRecord(operation) && isRecord(operation["precondition"]),
      ).length;
    }
    if (!isRecord(entry.output)) {
      continue;
    }
    if (entry.output["ok"] !== true) {
      const message = entry.output["error"];
      facts.rejected.push(typeof message === "string" ? message : "rejected");
      continue;
    }
    const result = entry.output["result"];
    if (!isRecord(result)) {
      continue;
    }
    const applied = result["applied"];
    const skipped = result["skipped"];
    const normalizations = result["normalizations"];
    facts.applied += Array.isArray(applied) ? applied.length : 0;
    if (Array.isArray(skipped)) {
      for (const skip of skipped) {
        const reason = isRecord(skip) ? skip["reason"] : undefined;
        // folio-agents renders the reason as a sentence; keep its first clause.
        facts.skipped.push(
          typeof reason === "string"
            ? (reason.split(";").at(0) ?? reason)
            : "unknown",
        );
      }
    }
    facts.normalizations += Array.isArray(normalizations)
      ? normalizations.length
      : 0;
  }
  return facts;
};

type DocumentDelta = {
  changed: string[];
  added: string[];
  removed: string[];
};

const documentDelta = (
  before: FolioAIEditSnapshot,
  after: FolioAIEditSnapshot,
): DocumentDelta => {
  const beforeById = new Map(
    before.blocks.map((block) => [block.id, block.text]),
  );
  const afterById = new Map(
    after.blocks.map((block) => [block.id, block.text]),
  );
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [id, text] of beforeById) {
    const next = afterById.get(id);
    if (next === undefined) {
      removed.push(text);
    } else if (next !== text) {
      changed.push(text);
    }
  }
  const added = after.blocks
    .filter((block) => !beforeById.has(block.id))
    .map((block) => block.text);
  return { changed, added, removed };
};

const checkExpectation = (
  text: string,
  expectation: Expectation,
): string | null => {
  switch (expectation.kind) {
    case "contains": {
      const occurrences = text.split(expectation.text).length - 1;
      if (
        expectation.count === undefined
          ? occurrences === 0
          : occurrences !== expectation.count
      ) {
        return `contains ${JSON.stringify(expectation.text)}${
          expectation.count === undefined
            ? ""
            : ` ×${String(expectation.count)}`
        }`;
      }
      return null;
    }
    case "notContains":
      return text.includes(expectation.text)
        ? `still contains ${JSON.stringify(expectation.text)}`
        : null;
    case "matches":
      return expectation.pattern.test(text) ? null : expectation.label;
    case "unique": {
      const values = [...text.matchAll(expectation.pattern)].map(
        (match) => match.at(1) ?? match[0],
      );
      return new Set(values).size === values.length
        ? null
        : `${expectation.label} not unique`;
    }
    case "ordered": {
      const before = text.indexOf(expectation.before);
      const after = text.indexOf(expectation.after);
      return before !== -1 && after !== -1 && before < after
        ? null
        : `${expectation.before} before ${expectation.after}`;
    }
    default:
      expectation satisfies never;
      return panic(`Unhandled expectation: ${String(expectation)}`);
  }
};

// The model told the user it could not apply the change, instead of claiming
// it had. Only counts when nothing was applied.
const DECLINED_PATTERN =
  /\b(?:not|unable|couldn't|could not|cannot|can't|failed|skipped|changed|stale|no longer)\b/iu;
// A reply that claims the edit landed is a hallucinated success, never a decline.
const SUCCESS_CLAIM_PATTERN =
  /\b(?:I(?:'ve| have)? (?:updated|changed|applied|replaced|inserted|removed|deleted|made|set)|(?:has|have) been (?:updated|changed|applied|replaced|set)|^done\b|\bdone[.!]|is now\b)/iu;

type RunScore = {
  /** `declined`: nothing applied and the model said so. */
  outcome: "pass" | "declined" | "fail" | "no-call" | "error";
  facts: SuggestChangesFacts;
  delta: DocumentDelta;
  collateral: string[];
  missing: string[];
};

type EvalRun = {
  modelId: string;
  taskId: string;
  repeat: number;
  score: RunScore;
  latencyMs: number;
  usage: TokenUsage | null;
  finalText: string;
  documentText: string;
  trace: ToolTrace[];
};

const resolveOutcome = ({
  error,
  calls,
  clean,
  declined,
}: {
  error: string | null;
  calls: number;
  clean: boolean;
  declined: boolean;
}): RunScore["outcome"] => {
  if (error !== null) {
    return "error";
  }
  if (calls === 0) {
    return "no-call";
  }
  if (clean) {
    return "pass";
  }
  return declined ? "declined" : "fail";
};

const applyDrift = ({
  bridge,
  snapshot,
  drift,
}: {
  bridge: ReturnType<typeof createReviewerBridge>;
  snapshot: FolioAIEditSnapshot;
  drift: DocumentDrift;
}): void => {
  const block = snapshot.blocks.find((candidate) =>
    candidate.text.includes(drift.blockText),
  );
  if (block === undefined) {
    panic(`drift target not found: ${drift.blockText}`);
  }
  const output = executeFolioToolCallUntyped(
    FOLIO_AGENT_TOOL_NAMES.suggestChanges,
    {
      operations: [
        { type: "replaceBlock", blockId: block.id, text: drift.text },
      ],
    },
    bridge,
    TOOL_OPTIONS,
  );
  const applied =
    output.ok && isRecord(output.result) ? output.result["applied"] : undefined;
  if (!Array.isArray(applied) || applied.length !== 1) {
    panic(`drift not applied: ${JSON.stringify(output)}`);
  }
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
  const reviewer = await FolioDocxReviewer.fromBuffer(
    Result.unwrap(await markdownToStellaDocx(task.document)),
    { author: "stella eval" },
  );
  const listing = reviewer.snapshot();
  const bridge = createReviewerBridge(reviewer, { mode: "direct" });
  if (task.drift !== undefined) {
    applyDrift({ bridge, snapshot: listing, drift: task.drift });
  }
  const before = reviewer.snapshot();
  const trace: ToolTrace[] = [];
  const tools = createEvalTools({ trace, bridge });
  const turn = await runModelTurn({
    model,
    request: task.request,
    snapshot: listing,
    tools,
  });
  const after = reviewer.snapshot();
  const documentText = reviewer.getContentAsText();
  const facts = suggestChangesFacts(trace);
  const delta = documentDelta(before, after);
  const collateral = [
    ...[...delta.changed, ...delta.removed].filter(
      (text) => !task.concerns(text),
    ),
    ...delta.added.filter((text) => !(task.allowsAdded?.(text) ?? false)),
  ];
  const missing = task.expectations.flatMap((expectation) => {
    const failure = checkExpectation(documentText, expectation);
    return failure === null ? [] : [failure];
  });
  const declined =
    task.drift !== undefined &&
    facts.applied === 0 &&
    collateral.length === 0 &&
    DECLINED_PATTERN.test(turn.finalText) &&
    !SUCCESS_CLAIM_PATTERN.test(turn.finalText);
  const outcome = resolveOutcome({
    error: turn.error,
    calls: facts.calls,
    clean: missing.length === 0 && collateral.length === 0,
    declined,
  });
  return {
    modelId,
    taskId: task.id,
    repeat,
    score: {
      outcome,
      facts: turn.error === null ? facts : { ...facts, rejected: [turn.error] },
      delta,
      collateral,
      missing,
    },
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
    documentText,
    trace,
  };
};

const countsText = (values: readonly string[]): string => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "-"
    : entries
        .map(([code, count]) => (count > 1 ? `${code}×${String(count)}` : code))
        .join("; ")
        .replaceAll("|", "\\|");
};

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = [];
  const modelIds = [...new Set(runs.map((run) => run.modelId))];
  for (const modelId of modelIds) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| task | run | outcome | calls | ops | guarded | applied | skipped | changed | added | removed | collateral | missing | ms |",
      "| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |",
    );
    for (const run of modelRuns) {
      const { facts, delta, collateral, missing, outcome } = run.score;
      lines.push(
        [
          `| ${run.taskId}`,
          String(run.repeat),
          outcome,
          String(facts.calls),
          String(facts.operations),
          String(facts.guarded),
          String(facts.applied),
          countsText([...facts.skipped, ...facts.rejected]),
          String(delta.changed.length),
          String(delta.added.length),
          String(delta.removed.length),
          String(collateral.length),
          missing.length === 0
            ? "-"
            : missing.join("; ").replaceAll("|", "\\|"),
          `${String(run.latencyMs)} |`,
        ].join(" | "),
      );
    }
    const total = modelRuns.length;
    const passed = modelRuns.filter(
      (run) => run.score.outcome === "pass" || run.score.outcome === "declined",
    ).length;
    const collateralRuns = modelRuns.filter(
      (run) => run.score.collateral.length > 0,
    ).length;
    const guarded = modelRuns.reduce(
      (sum, run) => sum + run.score.facts.guarded,
      0,
    );
    const operations = modelRuns.reduce(
      (sum, run) => sum + run.score.facts.operations,
      0,
    );
    lines.push(
      "",
      `passed ${String(passed)}/${String(total)}, runs with collateral edits ${String(collateralRuns)}, ` +
        `guarded operations ${String(guarded)}/${String(operations)}`,
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
      role: "chat",
      organizationId: null,
    }),
  }));
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const tasks = TASKS.filter(
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
