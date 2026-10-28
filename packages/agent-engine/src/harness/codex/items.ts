import { panic } from "better-result";

import type { HarnessToolCall, HarnessToolResult } from "../events";
import { CODEX_ITEM_POLICY, type CodexItem, isMcpTextBlock } from "./protocol";

/**
 * Codex thread items as harness tool calls, in the cloud translator's shape
 * (`@tanstack/ai-codex`, which reads `codex exec` events): the same names,
 * argument objects and result contents, so a local and a cloud turn persist
 * the same tool parts.
 */

export type CodexToolItem = Extract<
  CodexItem,
  { type: "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" }
>;

export const isToolItem = (item: CodexItem): item is CodexToolItem =>
  CODEX_ITEM_POLICY[item.type] === "tool";

/** Native status words in the cloud translator's spelling. */
const EXEC_STATUS = {
  inProgress: "in_progress",
  completed: "completed",
  failed: "failed",
  declined: "declined",
} as const;

const fileChanges = (item: Extract<CodexItem, { type: "fileChange" }>) =>
  item.changes.map(({ path, kind }) => ({ path, kind: kind.type }));

export const toolCallForItem = (item: CodexToolItem): HarnessToolCall => {
  switch (item.type) {
    case "commandExecution":
      return {
        id: item.id,
        name: "command_execution",
        input: { command: item.command },
      };
    case "fileChange":
      return {
        id: item.id,
        name: "file_change",
        input: { changes: fileChanges(item) },
      };
    case "mcpToolCall":
      return {
        id: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments ?? {},
      };
    case "webSearch":
      return { id: item.id, name: "web_search", input: { query: item.query } };
    default:
      item satisfies never;
      return panic("Unhandled Codex tool item");
  }
};

const status = (failed: boolean): HarnessToolResult["status"] =>
  failed ? "failed" : "succeeded";

const mcpResult = (
  item: Extract<CodexItem, { type: "mcpToolCall" }>,
): HarnessToolResult => {
  if (item.error !== null) {
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
      return {
        content: JSON.stringify({
          aggregated_output: item.aggregatedOutput ?? "",
          ...(item.exitCode === null ? {} : { exit_code: item.exitCode }),
          status: EXEC_STATUS[item.status],
        }),
        status: status(item.status === "failed" || item.status === "declined"),
      };
    case "fileChange":
      return {
        content: JSON.stringify({
          changes: fileChanges(item),
          status: EXEC_STATUS[item.status],
        }),
        status: status(item.status === "failed" || item.status === "declined"),
      };
    case "mcpToolCall":
      return mcpResult(item);
    case "webSearch":
      return {
        content: JSON.stringify({ status: "completed" }),
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
