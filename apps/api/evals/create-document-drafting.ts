/**
 * create-document drafting benchmark: can a (cheap) model write legal
 * source the docx-core compiler accepts, and how much does the compiler
 * have to normalize?
 *
 * Each task is one user request. The model gets the production
 * `create-document` tool definition (the same description and schema the
 * chat registers) and a minimal system prompt; the script captures the
 * `source` it hands the tool, compiles it with `compileLegalSourceToDocument`,
 * and scores:
 *
 *   outcome      ok / repair (compile errors) / no-call (tool never called) /
 *                bad-input (tool called with an unusable payload) / error
 *                (the provider refused the request)
 *   errors       compile error codes, or the provider error
 *   fixes        normalizations the compiler applied (fix codes)
 *   warnings     kept-but-suspect constructs
 *   leaks        literal markdown left in document text (`**`, backticks,
 *                `#` headings, unhighlighted `[[`)
 *   whole-bold   body paragraphs bold from end to end
 *   missing      structure the task asked for that the draft lacks
 *
 * No dev stack needed; models resolve from instance credentials (.env).
 *
 * Usage (from apps/api):
 *   bun run eval:create-document
 *   bun run eval:create-document -- --models gpt-5.6-luna,anthropic::claude-sonnet-5
 *   bun run eval:create-document -- --runs 3 --task en-nda --json out.json --sources-dir out/sources
 *
 * Model ids use `provider::modelId` or a bare id resolved through the
 * default provider chain (see `getTanStackTextModelById`).
 */
import { EventType, maxIterations } from "@tanstack/ai";
import type { TokenUsage } from "@tanstack/ai";
import { panic } from "better-result";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { compileLegalSourceToDocument } from "@stll/docx-core";
import type {
  BlockContent,
  LegalDraftBlock,
  LegalSourceCompileResult,
  Paragraph,
} from "@stll/docx-core";

import {
  createCreateDocumentTool,
  createDocumentToolInputSchema,
} from "@/api/handlers/chat/tools/create-document-tool";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  streamChatChunks,
  toolCallEndInputOf,
} from "@/api/lib/chat/tanstack-chat-runtime";
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
const MAX_OUTPUT_TOKENS = 6000;
// A whole draft can take a minute on a slow model; a stalled provider must
// not hang the run.
const MODEL_REQUEST_TIMEOUT_MS = 180_000;

const SYSTEM_PROMPT =
  "You are stella, a drafting assistant for lawyers. When the user asks for " +
  "a document, call the create-document tool once with the complete source. " +
  "Write in the language the user writes in.";

/** A structural property the request calls for, checked on the draft blocks. */
type StructuralExpectation = {
  label: string;
  holds: (blocks: readonly LegalDraftBlock[]) => boolean;
};

const signatures: StructuralExpectation = {
  label: "signatures",
  holds: (blocks) => blocks.some((block) => block.type === "signatures"),
};

const orderedList: StructuralExpectation = {
  label: "ordered list",
  holds: (blocks) =>
    blocks.some((block) => block.type === "list" && block.ordered),
};

const bulletList: StructuralExpectation = {
  label: "bullet list",
  holds: (blocks) =>
    blocks.some((block) => block.type === "list" && !block.ordered),
};

const tableWithColumns = (columns: number): StructuralExpectation => ({
  label: `table with ${String(columns)} columns`,
  holds: (blocks) =>
    blocks.some(
      (block) =>
        block.type === "table" &&
        block.table.headers.length === columns &&
        block.table.rows.every((row) => row.length === columns),
    ),
});

type EvalTask = {
  id: string;
  prompt: string;
  expects: readonly StructuralExpectation[];
};

const TASKS: readonly EvalTask[] = [
  {
    id: "cs-power-of-attorney",
    prompt:
      "Připrav plnou moc, kterou Jan Novák (nar. 1. 2. 1980, bytem Praha 5) " +
      "zmocňuje advokáta Mgr. Petra Svobodu k zastupování ve sporu s firmou " +
      "Alfa s.r.o. o zaplacení 250 000 Kč. Česky, s podpisovým blokem.",
    expects: [signatures],
  },
  {
    id: "en-nda",
    prompt:
      "Draft a mutual NDA between Alpha Ltd (England) and Beta s.r.o. (Czech " +
      "Republic) for evaluating a software partnership: definitions, a " +
      "three-year term, a table listing the categories of confidential " +
      "information with their handling rules, and signature blocks.",
    expects: [tableWithColumns(2), signatures],
  },
  {
    id: "de-kuendigung",
    prompt:
      "Schreibe ein formelles Kündigungsschreiben für meinen Mobilfunkvertrag " +
      "bei der Telekom, Kundennummer 12345, zum nächstmöglichen Termin, mit " +
      "Bitte um schriftliche Bestätigung. Auf Deutsch.",
    expects: [],
  },
  {
    id: "bilingual-services",
    prompt:
      "Draft a short services agreement in Czech and English side by side " +
      "(two columns, Czech left, English right) between Gamma a.s. as client " +
      "and Delta Consulting s.r.o. as provider: scope, fees of 50 000 CZK per " +
      "month, three-month notice, Czech governing law. Signatures for both.",
    expects: [tableWithColumns(2), signatures],
  },
  {
    id: "checklist-closing",
    prompt:
      "Make a closing checklist for a share purchase deal: board approvals, " +
      "regulatory consents, funds flow, escrow release, post-closing filings. " +
      "Checkbox items the team can tick off.",
    expects: [bulletList],
  },
  {
    id: "sk-memo",
    prompt:
      "Napíš krátke interné memo pre vedenie o povinnostiach zamestnávateľa " +
      "pri práci z domu podľa slovenského Zákonníka práce, s očíslovaným " +
      "zoznamom povinností a odporúčaniami na záver.",
    expects: [orderedList],
  },
  {
    id: "markdown-pressure",
    prompt:
      "Write a consultancy agreement between Acme Inc. and Jane Roe. Use " +
      "markdown: headings for each section, bullet lists for the " +
      "obligations, bold every defined term, and italicize the recitals.",
    expects: [bulletList],
  },
];

type CliOptions = {
  models: string[];
  runs: number;
  taskFilter: string | null;
  jsonPath: string | null;
  sourcesDir: string | null;
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
    sourcesDir: null,
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
      case "--sources-dir":
        options.sourcesDir = value;
        index += 1;
        break;
      default:
        break;
    }
  }
  return options;
};

type ToolCallCapture = {
  argumentText: string;
  input: unknown;
};

type ModelTurn = {
  call: ToolCallCapture | null;
  /** The provider's run error, when the request failed instead of answering. */
  error: string | null;
  finalText: string;
  latencyMs: number;
  usage: TokenUsage | null;
};

const runModelTurn = async (
  model: ResolvedTanStackTextModel,
  prompt: string,
): Promise<ModelTurn> => {
  const caching = resolveCaching({
    promptCachingEnabled: false,
    role: "fast",
    scopeKey: null,
  });
  let finalText = "";
  const argumentTexts = new Map<string, string>();
  const parsedInputs = new Map<string, unknown>();
  const { error, latencyMs, usage } = await runEvalModelTurn({
    timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
    chat: (abortController) =>
      streamChatChunks({
        abortController,
        adapter: model.adapter,
        messages: [{ role: "user", content: prompt }],
        // The tool is client-executed in production; here nobody answers it,
        // so the run ends after the first tool call.
        agentLoopStrategy: maxIterations(1),
        ...systemPromptsPatch({ caching, model, system: SYSTEM_PROMPT }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          serviceTier: "standard",
          temperature: 0,
        }),
        tools: [createCreateDocumentTool()],
      }),
    onChunk: (chunk) => {
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        finalText += chunk.delta;
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_ARGS) {
        argumentTexts.set(
          chunk.toolCallId,
          (argumentTexts.get(chunk.toolCallId) ?? "") + chunk.delta,
        );
        return;
      }
      if (chunk.type === EventType.TOOL_CALL_END) {
        const input = toolCallEndInputOf(chunk);
        if (input !== undefined) {
          parsedInputs.set(chunk.toolCallId, input);
        }
      }
    },
  });

  const firstCallId = [...argumentTexts.keys(), ...parsedInputs.keys()].at(0);
  if (firstCallId === undefined) {
    return { call: null, error, finalText, latencyMs, usage };
  }
  const argumentText = argumentTexts.get(firstCallId) ?? "";
  const input = parsedInputs.get(firstCallId) ?? parseJsonOrNull(argumentText);
  return {
    call: { argumentText, input },
    error,
    finalText,
    latencyMs,
    usage,
  };
};

// Boundary decode of model output: malformed JSON is a benchmark finding,
// not a failure to propagate.
const parseJsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The same schema the chat tool validates with, so `bad-input` means what
// production would reject.
const readToolInput = (
  input: unknown,
): { name: string; source: string } | null => {
  const parsed = v.safeParse(createDocumentToolInputSchema, input);
  return parsed.success ? parsed.output : null;
};

const BODY_STYLE_IDS = new Set([
  "BodyText",
  "Recital",
  "ListParagraph",
  "TableText",
]);

const LEAK_PATTERNS = [
  { code: "bold-marker", pattern: /\*\*/u },
  { code: "backtick", pattern: /`/u },
  { code: "heading-marker", pattern: /^#{1,6}\s/u },
  { code: "placeholder-marker", pattern: /\[\[/u },
] as const;

type ParagraphFacts = {
  leaks: string[];
  wholeBold: boolean;
};

const paragraphFacts = ({
  paragraph,
  tableHeader,
}: BodyParagraph): ParagraphFacts => {
  const runs = paragraph.content.flatMap((part) => {
    if (part.type === "run") {
      return [part];
    }
    if (part.type === "hyperlink") {
      return part.children.flatMap((child) =>
        child.type === "run" ? [child] : [],
      );
    }
    return [];
  });
  const text = runs
    .map((run) =>
      run.content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join(""),
    )
    .join("");
  const leaks = LEAK_PATTERNS.flatMap(({ code, pattern }) =>
    pattern.test(text) ? [code] : [],
  );
  const styleId = paragraph.formatting?.styleId ?? "";
  const wholeBold =
    !tableHeader &&
    BODY_STYLE_IDS.has(styleId) &&
    runs.length > 0 &&
    text.trim().length > 0 &&
    runs.every((run) => run.formatting?.bold === true);
  return { leaks, wholeBold };
};

type BodyParagraph = {
  paragraph: Paragraph;
  /** A table's first row: bold by design, so not a whole-bold finding. */
  tableHeader: boolean;
};

const collectParagraphs = (
  blocks: readonly BlockContent[],
  tableHeader = false,
): BodyParagraph[] =>
  blocks.flatMap((block) => {
    switch (block.type) {
      case "paragraph":
        return [{ paragraph: block, tableHeader }];
      case "table":
        return block.rows.flatMap((row, rowIndex) =>
          row.cells.flatMap((cell) =>
            collectParagraphs(cell.content, rowIndex === 0),
          ),
        );
      case "blockSdt":
        return collectParagraphs(block.content, tableHeader);
      default:
        block satisfies never;
        return panic(`Unhandled block: ${String(block)}`);
    }
  });

type RunScore = {
  outcome: "error" | "no-call" | "ok" | "repair" | "bad-input";
  errorCodes: string[];
  fixCodes: string[];
  warningCodes: string[];
  leaks: string[];
  wholeBoldParagraphs: number;
  blockTypes: Record<string, number>;
  missing: string[];
  placeholders: number;
};

const countBy = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const scoreCompiled = (
  compiled: LegalSourceCompileResult,
  task: EvalTask,
  source: string,
): RunScore => {
  const blockTypes = countBy(compiled.draft.blocks.map((block) => block.type));
  const missing = task.expects
    .filter((expectation) => !expectation.holds(compiled.draft.blocks))
    .map((expectation) => expectation.label);
  const placeholders = source.match(/\[\[[^\]]+\]\]/gu)?.length ?? 0;
  if (compiled.status !== "ok") {
    return {
      outcome: "repair",
      errorCodes: compiled.errors.map((error) => error.code),
      fixCodes: compiled.fixes.map((fix) => fix.code),
      warningCodes: [],
      leaks: [],
      wholeBoldParagraphs: 0,
      blockTypes,
      missing,
      placeholders,
    };
  }
  const facts = collectParagraphs(
    compiled.document.package.document.content,
  ).map((bodyParagraph) => paragraphFacts(bodyParagraph));
  return {
    outcome: "ok",
    errorCodes: [],
    fixCodes: compiled.fixes.map((fix) => fix.code),
    warningCodes: compiled.warnings.map((warning) => warning.code),
    leaks: [...new Set(facts.flatMap((fact) => fact.leaks))],
    wholeBoldParagraphs: facts.filter((fact) => fact.wholeBold).length,
    blockTypes,
    missing,
    placeholders,
  };
};

const noCallScore = (
  outcome: "error" | "no-call" | "bad-input",
  errorCodes: string[] = [],
): RunScore => ({
  outcome,
  errorCodes,
  fixCodes: [],
  warningCodes: [],
  leaks: [],
  wholeBoldParagraphs: 0,
  blockTypes: {},
  missing: [],
  placeholders: 0,
});

type EvalRun = {
  modelId: string;
  taskId: string;
  repeat: number;
  score: RunScore;
  latencyMs: number;
  usage: TokenUsage | null;
  documentName: string | null;
  source: string | null;
  finalText: string;
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
  const turn = await runModelTurn(model, task.prompt);
  const base = {
    modelId,
    taskId: task.id,
    repeat,
    latencyMs: turn.latencyMs,
    usage: turn.usage,
    finalText: turn.finalText,
  };
  // A run error wins even after partial tool-call arguments: the payload is
  // not what the model would have sent had the stream completed.
  if (turn.error !== null) {
    return {
      ...base,
      score: noCallScore("error", [turn.error]),
      documentName: null,
      source: turn.call?.argumentText ?? null,
    };
  }
  if (turn.call === null) {
    return {
      ...base,
      score: noCallScore("no-call"),
      documentName: null,
      source: null,
    };
  }
  const input = readToolInput(turn.call.input);
  if (input === null) {
    return {
      ...base,
      score: noCallScore("bad-input"),
      documentName: null,
      source: turn.call.argumentText,
    };
  }
  const compiled = compileLegalSourceToDocument(input.source, {
    titleFallback: input.name,
  });
  return {
    ...base,
    score: scoreCompiled(compiled, task, input.source),
    documentName: input.name,
    source: input.source,
  };
};

const countsText = (values: readonly string[]): string => {
  const counts = countBy(values);
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "-"
    : entries
        .map(([code, count]) => (count > 1 ? `${code}×${count}` : code))
        .join(", ");
};

const renderReport = (runs: readonly EvalRun[]): string => {
  const lines: string[] = [];
  const modelIds = [...new Set(runs.map((run) => run.modelId))];
  for (const modelId of modelIds) {
    const modelRuns = runs.filter((run) => run.modelId === modelId);
    lines.push(`\n### ${modelId}\n`);
    lines.push(
      "| task | run | outcome | errors | fixes | warnings | leaks | whole-bold | missing | placeholders | ms |",
      "| --- | ---: | --- | --- | --- | --- | --- | ---: | --- | ---: | ---: |",
    );
    for (const run of modelRuns) {
      const { score } = run;
      lines.push(
        [
          `| ${run.taskId}`,
          String(run.repeat),
          score.outcome,
          countsText(score.errorCodes),
          countsText(score.fixCodes),
          countsText(score.warningCodes),
          score.leaks.length === 0 ? "-" : score.leaks.join(", "),
          String(score.wholeBoldParagraphs),
          score.missing.length === 0 ? "-" : score.missing.join(", "),
          String(score.placeholders),
          `${String(run.latencyMs)} |`,
        ].join(" | "),
      );
    }
    const total = modelRuns.length;
    const called = modelRuns.filter(
      (run) => run.score.outcome !== "no-call" && run.score.outcome !== "error",
    ).length;
    const ok = modelRuns.filter((run) => run.score.outcome === "ok").length;
    const fixes = modelRuns.reduce(
      (sum, run) => sum + run.score.fixCodes.length,
      0,
    );
    const leaks = modelRuns.filter((run) => run.score.leaks.length > 0).length;
    const wholeBold = modelRuns.reduce(
      (sum, run) => sum + run.score.wholeBoldParagraphs,
      0,
    );
    const missing = modelRuns.filter(
      (run) => run.score.missing.length > 0,
    ).length;
    lines.push(
      "",
      `tool called ${String(called)}/${String(total)}, compiled ok ${String(ok)}/${String(total)}, ` +
        `fixes ${String(fixes)}, runs with leaks ${String(leaks)}, whole-bold paragraphs ${String(wholeBold)}, ` +
        `runs missing structure ${String(missing)}`,
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

const writeSources = async (dir: string, runs: readonly EvalRun[]) => {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    runs.flatMap((run) => {
      if (run.source === null) {
        return [];
      }
      const safeModel = run.modelId.replaceAll(/[^A-Za-z0-9._-]+/gu, "_");
      const fileName = `${safeModel}__${run.taskId}__${String(run.repeat)}.txt`;
      return [writeFile(path.join(dir, fileName), run.source)];
    }),
  );
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
  if (options.sourcesDir !== null) {
    await writeSources(options.sourcesDir, runs);
  }
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify({ runs }, null, 2));
  }
};

await main();
