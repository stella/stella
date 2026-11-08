import { panic } from "better-result";

import type { DESKTOP_RUNNER_APPROVAL_KINDS } from "@stll/api-contract/desktop-runner";

import type { HarnessToolCall, HarnessToolResult } from "../events";
import { HARNESS_TOOL_NAMES, mcpToolCallName } from "../tool-parts";
import type {
  ClaudeMessageType,
  ClaudeSystemSubtype,
  ClaudeToolResult,
  ClaudeToolUse,
} from "./protocol";

/**
 * Claude Code messages as harness events. Text is the agent's markdown,
 * passed through unchanged. A stella MCP call takes the name a cloud chat
 * turn gives the same tool, and its result is the tool's JSON text, so the
 * web chat's cards, citations and source chips read it as they read a cloud
 * turn. Built-in tools become generic activity built from the fields named
 * here; other native fields are never forwarded.
 */

type ClaudeMessageHandling =
  | "assistant"
  | "user"
  | "result"
  | "system"
  | "stream"
  | "rate_limit"
  | "ignore";

/** What stella does with each pinned message type. */
export const claudeMessageHandling = (
  kind: ClaudeMessageType,
): ClaudeMessageHandling => {
  switch (kind) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "result":
      return "result";
    case "system":
      return "system";
    case "stream_event":
      return "stream";
    case "rate_limit_event":
      return "rate_limit";
    // Each type below is dropped on purpose.
    case "auth_status":
      // Progress of a sign-in flow; stella never starts one in a turn.
      return "ignore";
    case "tool_progress":
    case "tool_use_summary":
      // Progress and summaries of tool calls reported in full on completion.
      return "ignore";
    case "prompt_suggestion":
      // A suggested next prompt; the user writes their own.
      return "ignore";
    case "conversation_reset":
    case "active_goal":
      // Slash-command and goal state; stella sends neither.
      return "ignore";
    case "keep_alive":
      // Transport liveness.
      return "ignore";
    default:
      kind satisfies never;
      return panic("Unhandled Claude message type");
  }
};

/** What stella does with each pinned `system` subtype. */
export const claudeSystemHandling = (
  subtype: ClaudeSystemSubtype,
): "retrying" | "ignore" => {
  switch (subtype) {
    case "api_retry":
      return "retrying";
    // Each subtype below is dropped on purpose.
    case "init":
      // The session id is chosen before the CLI starts, so `session.started`
      // does not wait for this.
      return "ignore";
    case "permission_denied":
      // An automatic denial; the tool's failed result reports it.
      return "ignore";
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
      // The answer text and the turn's result carry the outcome.
      return "ignore";
    case "status":
    case "compact_boundary":
    case "thinking_tokens":
    case "session_state_changed":
    case "control_request_progress":
    case "worker_shutting_down":
      // Harness bookkeeping, not output.
      return "ignore";
    case "task_started":
    case "task_updated":
    case "task_progress":
    case "task_notification":
    case "background_tasks_changed":
      // Sub-agents and background tasks run inside the harness; their own
      // tool calls are not reported on this turn.
      return "ignore";
    case "hook_started":
    case "hook_progress":
    case "hook_response":
    case "plugin_install":
    case "commands_changed":
    case "local_command_output":
    case "memory_recall":
      // Hooks, plugins, slash commands and memory: no setting source that
      // enables them is loaded.
      return "ignore";
    case "notification":
    case "informational":
      // Terminal banners for the CLI's own interface.
      return "ignore";
    case "files_persisted":
    case "mirror_error":
      // Remote session storage, which a local turn does not use.
      return "ignore";
    case "elicitation_complete":
      // stella declines every elicitation.
      return "ignore";
    default:
      subtype satisfies never;
      return panic("Unhandled Claude system subtype");
  }
};

type ClaudeToolKind =
  "command" | "file_change" | "web_search" | "question" | "mcp" | "native";

/** The input field that names the file each editing tool writes. */
const FILE_TOOL_PATHS = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
} as const;

const isFileTool = (name: string): name is keyof typeof FILE_TOOL_PATHS =>
  Object.hasOwn(FILE_TOOL_PATHS, name);

const MCP_PREFIX = "mcp__";
const MCP_SEPARATOR = "__";

/** The built-in tool that asks the user a question mid-turn. */
export const ASK_USER_QUESTION_TOOL = "AskUserQuestion";

const toolKind = (name: string): ClaudeToolKind => {
  if (name === "Bash") {
    return "command";
  }
  if (isFileTool(name)) {
    return "file_change";
  }
  if (name === "WebSearch") {
    return "web_search";
  }
  if (name === ASK_USER_QUESTION_TOOL) {
    return "question";
  }
  return name.startsWith(MCP_PREFIX) ? "mcp" : "native";
};

/** The runner protocol's approval kind for a tool the CLI asks about. */
export const approvalKindForTool = (
  name: string,
): (typeof DESKTOP_RUNNER_APPROVAL_KINDS)[number] => {
  const kind = toolKind(name);
  switch (kind) {
    case "command":
      return "command";
    case "file_change":
      return "file_change";
    case "mcp":
      return "mcp_tool";
    case "web_search":
    case "question":
    case "native":
      return "tool";
    default:
      kind satisfies never;
      return panic("Unhandled Claude tool kind");
  }
};

const stringField = (input: Readonly<Record<string, unknown>>, key: string) => {
  const value = input[key];
  return typeof value === "string" ? value : "";
};

/**
 * The MCP server and tool a `mcp__<server>__<tool>` name stands for. The
 * stella server is matched by its registered name first, since a server name
 * may itself contain the separator.
 */
const mcpName = (name: string, stellaServer: string) => {
  const stellaPrefix = `${MCP_PREFIX}${stellaServer}${MCP_SEPARATOR}`;
  if (name.startsWith(stellaPrefix)) {
    return { server: stellaServer, tool: name.slice(stellaPrefix.length) };
  }
  const rest = name.slice(MCP_PREFIX.length);
  const separator = rest.indexOf(MCP_SEPARATOR);
  return separator === -1
    ? { server: rest, tool: "" }
    : {
        server: rest.slice(0, separator),
        tool: rest.slice(separator + MCP_SEPARATOR.length),
      };
};

/** Claude does not say whether a write created the file. */
const fileChanges = (
  name: keyof typeof FILE_TOOL_PATHS,
  input: Readonly<Record<string, unknown>>,
) => [{ path: stringField(input, FILE_TOOL_PATHS[name]), kind: "update" }];

/** `stellaServer` is the server name the stella MCP binding is under. */
export const toolCallForUse = (
  use: Pick<ClaudeToolUse, "id" | "name" | "input">,
  stellaServer: string,
): HarnessToolCall => {
  const { id, name, input } = use;
  const kind = toolKind(name);
  switch (kind) {
    case "command":
      return {
        id,
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command: stringField(input, "command") },
      };
    case "file_change":
      return {
        id,
        name: HARNESS_TOOL_NAMES.fileChange,
        input: { changes: isFileTool(name) ? fileChanges(name, input) : [] },
      };
    case "web_search":
      return {
        id,
        name: HARNESS_TOOL_NAMES.webSearch,
        input: { query: stringField(input, "query") },
      };
    case "question":
      return { id, name: HARNESS_TOOL_NAMES.question, input };
    case "mcp":
      return {
        id,
        name: mcpToolCallName({ ...mcpName(name, stellaServer), stellaServer }),
        input,
      };
    case "native":
      return { id, name: HARNESS_TOOL_NAMES.nativeTool, input: { tool: name } };
    default:
      kind satisfies never;
      return panic("Unhandled Claude tool kind");
  }
};

/** A tool result's text blocks; images and other blocks are not carried. */
const resultText = (block: ClaudeToolResult) => {
  if (block.content === undefined) {
    return "";
  }
  if (typeof block.content === "string") {
    return block.content;
  }
  return block.content
    .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
    .join("");
};

const status = (failed: boolean): HarnessToolResult["status"] =>
  failed ? "failed" : "succeeded";

/**
 * A result in the shape the cloud translator stores for the same kind of
 * call. A stella tool's text block is the JSON of its validated output (or of
 * its error envelope), exactly the content a cloud chat turn stores.
 */
export const toolResultFor = (
  use: Pick<ClaudeToolUse, "name" | "input">,
  block: ClaudeToolResult,
): HarnessToolResult => {
  const failed = block.is_error === true;
  const text = resultText(block);
  const outcome = failed ? "failed" : "completed";
  const kind = toolKind(use.name);
  switch (kind) {
    case "command":
      return {
        content: JSON.stringify({ aggregated_output: text, status: outcome }),
        status: status(failed),
      };
    case "file_change":
      return {
        content: JSON.stringify({
          changes: isFileTool(use.name) ? fileChanges(use.name, use.input) : [],
          status: outcome,
        }),
        status: status(failed),
      };
    case "web_search":
      return {
        content: JSON.stringify({ status: outcome }),
        status: status(failed),
      };
    case "question":
    case "mcp":
    case "native":
      return {
        content: text === "" ? JSON.stringify({ status: outcome }) : text,
        status: status(failed),
      };
    default:
      kind satisfies never;
      return panic("Unhandled Claude tool kind");
  }
};
