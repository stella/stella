import { panic } from "better-result";

import { chatLocalRunToolResultContent } from "@stll/api-contract/chat-local-run-tool";

import type { HarnessToolCall, HarnessToolResult } from "../events";
import { type HarnessStepOutput, wholeFileDiff } from "../step-output";
import { HARNESS_TOOL_NAMES, mcpToolCall, nativeToolCall } from "../tool-parts";
import {
  type CodexItem,
  type CodexItemType,
  type CodexPlanUpdate,
  isMcpTextBlock,
} from "./protocol";

/**
 * Codex thread items as harness events. Text is the agent's markdown, passed
 * through unchanged. A stella MCP call takes the name a cloud chat turn gives
 * the same tool, and its result is the tool's JSON text, so the web chat's
 * cards, citations and source chips read it as they read a cloud turn.
 * Harness-native actions become generic activity built from the fields named
 * here; the native item itself is never forwarded.
 */

type CodexItemHandling = "text" | "reasoning" | "tool" | "ignore";

/** What stella shows for each pinned item kind. */
export const codexItemHandling = (kind: CodexItemType): CodexItemHandling => {
  switch (kind) {
    case "agentMessage":
      return "text";
    case "reasoning":
      return "reasoning";
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      return "tool";
    // Each kind below is dropped on purpose.
    case "userMessage":
      // The user's own message is already the last transcript entry.
      return "ignore";
    case "hookPrompt":
      // Text a harness hook injected into the model's context, not output.
      return "ignore";
    case "functionCallOutput":
      // The harness's record of a tool output it already reported as an item.
      return "ignore";
    case "plan":
      // A plan proposal's text; the steps of the working plan arrive as
      // `turn/plan/updated` and are shown by title (`planUpdateStep`).
      return "ignore";
    case "dynamicToolCall":
      // stella registers no dynamic tools and declines `item/tool/call`.
      return "ignore";
    case "collabAgentToolCall":
    case "subAgentActivity":
      // Sub-agents run inside the harness and their own tool calls are not
      // reported on this turn, so a summary would show nothing to open.
      return "ignore";
    case "imageView":
      // A local image the harness viewed; its path means nothing in chat.
      return "ignore";
    case "sleep":
      // Harness scheduling, not activity.
      return "ignore";
    case "imageGeneration":
      // stella does not enable the harness's image tool for a turn.
      return "ignore";
    case "enteredReviewMode":
    case "exitedReviewMode":
      // Review mode is never started by stella.
      return "ignore";
    case "contextCompaction":
      // History compaction is harness bookkeeping.
      return "ignore";
    default:
      kind satisfies never;
      return panic("Unhandled Codex item type");
  }
};

type CodexToolItem = Extract<
  CodexItem,
  { type: "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" }
>;

export const isToolItem = (item: CodexItem): item is CodexToolItem =>
  codexItemHandling(item.type) === "tool";

/** Native status words in the cloud translator's spelling. */
const EXEC_STATUS = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "declined",
} as const;

const fileChanges = (item: Extract<CodexItem, { type: "fileChange" }>) =>
  item.changes.map(({ path, kind }) => ({ path, kind: kind.type }));

/**
 * What a step produced, kept on the computer: a command's output once it ran,
 * and each changed file's diff. Codex reports an added or deleted file's text,
 * which reads as its added or removed lines.
 */
const localOutputOf = (
  item: Extract<CodexItem, { type: "commandExecution" | "fileChange" }>,
): { localOutput: HarnessStepOutput } | Record<string, never> => {
  if (item.type === "commandExecution") {
    return typeof item.aggregatedOutput === "string"
      ? { localOutput: { type: "command", output: item.aggregatedOutput } }
      : {};
  }
  const files = item.changes.flatMap(({ path, kind, diff }) => {
    if (diff === null || diff === undefined) {
      return [];
    }
    return [
      {
        path,
        diff: kind.type === "update" ? diff : wholeFileDiff(diff, kind.type),
      },
    ];
  });
  return files.length === 0 ? {} : { localOutput: { type: "diff", files } };
};

/** `stellaServer` is the server name the stella MCP binding is under. */
export const toolCallForItem = (
  item: CodexToolItem,
  stellaServer: string,
): HarnessToolCall => {
  switch (item.type) {
    case "commandExecution":
      return nativeToolCall(item.id, {
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command: item.command },
      });
    case "fileChange":
      return nativeToolCall(item.id, {
        name: HARNESS_TOOL_NAMES.fileChange,
        input: { changes: fileChanges(item) },
      });
    case "mcpToolCall":
      return mcpToolCall({
        id: item.id,
        input: item.arguments ?? {},
        server: item.server,
        stellaServer,
        tool: item.tool,
      });
    case "webSearch":
      return nativeToolCall(item.id, {
        name: HARNESS_TOOL_NAMES.webSearch,
        input: { query: item.query },
      });
    default:
      item satisfies never;
      return panic("Unhandled Codex tool item");
  }
};

/**
 * Codex's own name for the tool that updates its plan, as a Claude
 * `TodoWrite` is named after the tool.
 */
const PLAN_TOOL = "update_plan";

/**
 * A plan update as a completed step: its steps' titles, never their
 * statuses or the explanation around them. Each update is its own step, so
 * `sequence` (the update's number in the turn) keeps the ids apart.
 */
export const planUpdateStep = (
  update: CodexPlanUpdate,
  sequence: number,
): { toolCall: HarnessToolCall; result: HarnessToolResult } => ({
  toolCall: nativeToolCall(`${update.turnId}:plan:${String(sequence)}`, {
    name: HARNESS_TOOL_NAMES.nativeTool,
    input: {
      tool: PLAN_TOOL,
      detail: { kind: "plan", items: update.plan.map(({ step }) => step) },
    },
  }),
  result: {
    content: chatLocalRunToolResultContent({
      name: HARNESS_TOOL_NAMES.nativeTool,
      result: { status: "completed" },
    }),
    status: "succeeded",
  },
});

const status = (failed: boolean): HarnessToolResult["status"] =>
  failed ? "failed" : "succeeded";

/**
 * A stella tool's text block is the JSON of its validated output (or of its
 * error envelope), exactly the content a cloud chat turn stores for the call.
 */
const mcpResult = (
  item: Extract<CodexItem, { type: "mcpToolCall" }>,
): HarnessToolResult => {
  if (item.error !== null && item.error !== undefined) {
    return { content: item.error.message, status: "failed" };
  }
  const failed = status(item.status === "failed");
  const text = (item.result?.content ?? [])
    .filter(isMcpTextBlock)
    .map((block) => block.text ?? "")
    .join("");
  if (text !== "") {
    return { content: text, status: failed };
  }
  const structured = item.result?.structuredContent;
  if (structured !== undefined && structured !== null) {
    return { content: JSON.stringify(structured), status: failed };
  }
  return {
    content: JSON.stringify({ status: EXEC_STATUS[item.status] }),
    status: failed,
  };
};

export const toolResultForItem = (item: CodexToolItem): HarnessToolResult => {
  switch (item.type) {
    case "commandExecution":
      // The exit code and status only; the command's output stays here.
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.commandExecution,
          result: {
            status: EXEC_STATUS[item.status],
            ...(typeof item.exitCode === "number"
              ? { exit_code: item.exitCode }
              : {}),
          },
        }),
        status: status(item.status === "failed" || item.status === "declined"),
        ...localOutputOf(item),
      };
    case "fileChange":
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.fileChange,
          result: {
            changes: fileChanges(item),
            status: EXEC_STATUS[item.status],
          },
        }),
        status: status(item.status === "failed" || item.status === "declined"),
        ...localOutputOf(item),
      };
    case "mcpToolCall":
      return mcpResult(item);
    case "webSearch":
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.webSearch,
          result: { status: "completed" },
        }),
        status: "succeeded",
      };
    default:
      item satisfies never;
      return panic("Unhandled Codex tool item");
  }
};

/** Codex streams a reasoning summary; raw reasoning is the fallback. */
export const reasoningText = (
  item: Extract<CodexItem, { type: "reasoning" }>,
) =>
  (item.summary.length > 0 ? item.summary : item.content).join("\n\n").trim();
