import { panic } from "better-result";

import {
  type ChatLocalRunToolDetail,
  chatLocalRunToolResultContent,
} from "@stll/api-contract/chat-local-run-tool";
import type { DESKTOP_RUNNER_APPROVAL_KINDS } from "@stll/api-contract/desktop-runner";

import type { HarnessToolCall, HarnessToolResult } from "../events";
import {
  type HarnessFileDiff,
  replacementDiff,
  wholeFileDiff,
} from "../step-output";
import {
  HARNESS_TOOL_NAMES,
  mcpToolCallName,
  nativeToolCall,
  stepOfSubagent,
} from "../tool-parts";
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
 * here (a command line, file names, a search, a web address, plan titles, a
 * plan proposed for approval, a subagent's short description and agent
 * type); other native fields, such as an edit's text, a file's contents or
 * a subagent's prompt, are never forwarded.
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
      // Progress of subagents and background tasks. A subagent's steps
      // arrive as its own messages, which name the call that started it.
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

/**
 * The built-in tool that ends plan mode by proposing a plan. The CLI adds the
 * plan to the call's input (`plan`) before it asks about the call.
 */
export const EXIT_PLAN_MODE_TOOL = "ExitPlanMode";

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

const optionalStringField = (
  input: Readonly<Record<string, unknown>>,
  key: string,
) => {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * The built-in tool that starts a subagent: `Agent`, which the CLI also
 * accepts and reports under its earlier name `Task`.
 */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * What a subagent was told when `use` started it, or `null` when the call
 * starts none or carries no prompt. It stays on this computer, with the
 * rest of the subagent's conversation.
 */
export const subagentPromptOf = ({
  name,
  input,
}: Pick<ClaudeToolUse, "name" | "input">): string | null =>
  SUBAGENT_TOOLS.has(name)
    ? (optionalStringField(input, "prompt") ?? null)
    : null;

/** Whether `use` starts a subagent. */
export const startsSubagent = ({ name }: Pick<ClaudeToolUse, "name">) =>
  SUBAGENT_TOOLS.has(name);

/**
 * The files `Read` returns as an image instead of text. The CLI decides by
 * the file's extension, and so does this: the call is shown before its
 * result exists.
 */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/iu;

/** The image file a `Read` viewed, or `null` for any other call. */
const viewedImageOf = ({
  name,
  input,
}: Pick<ClaudeToolUse, "name" | "input">): string | null => {
  const file = name === "Read" ? stringField(input, "file_path") : "";
  return IMAGE_FILE.test(file) ? file : null;
};

/** The titles of a `TodoWrite` list; its statuses and other fields stay. */
const todoTitles = (input: Readonly<Record<string, unknown>>) => {
  const todos = input["todos"];
  return Array.isArray(todos)
    ? todos.flatMap((todo: unknown) =>
        typeof todo === "object" &&
        todo !== null &&
        "content" in todo &&
        typeof todo.content === "string"
          ? [todo.content]
          : [],
      )
    : [];
};

/**
 * What chat may show of a built-in tool beyond its name, by the tool's
 * native name. A tool not named here shows its name only.
 */
const nativeDetail = (
  name: string,
  input: Readonly<Record<string, unknown>>,
): ChatLocalRunToolDetail | undefined => {
  if (SUBAGENT_TOOLS.has(name)) {
    // The few words the agent gave the task and the kind of agent it
    // chose; the prompt stays here.
    const agentType = optionalStringField(input, "subagent_type");
    return {
      kind: "subagent",
      description: stringField(input, "description"),
      ...(agentType === undefined ? {} : { agentType }),
    };
  }
  switch (name) {
    case "Read": {
      const path = stringField(input, "file_path");
      return { kind: IMAGE_FILE.test(path) ? "image" : "read", path };
    }
    case "Grep":
    case "Glob": {
      const path = optionalStringField(input, "path");
      return {
        kind: "search",
        pattern: stringField(input, "pattern"),
        ...(path === undefined ? {} : { path }),
      };
    }
    case "WebFetch":
      return { kind: "fetch", url: stringField(input, "url") };
    case "TodoWrite":
      return { kind: "plan", items: todoTitles(input) };
    case EXIT_PLAN_MODE_TOOL: {
      const plan = optionalStringField(input, "plan");
      return plan === undefined
        ? undefined
        : { kind: "proposed_plan", text: plan };
    }
    default:
      return undefined;
  }
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
) => [
  { path: stringField(input, FILE_TOOL_PATHS[name]), kind: "update" as const },
];

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

/** The `old_string`/`new_string` pairs of an `Edit` or a `MultiEdit`. */
const replacements = (
  name: keyof typeof FILE_TOOL_PATHS,
  input: Readonly<Record<string, unknown>>,
) => {
  if (name === "Edit") {
    return [
      replacementDiff(
        stringField(input, "old_string"),
        stringField(input, "new_string"),
      ),
    ];
  }
  const edits = input["edits"];
  return Array.isArray(edits)
    ? edits.flatMap((edit: unknown) =>
        typeof edit === "object" && edit !== null
          ? [
              replacementDiff(
                textOf(Reflect.get(edit, "old_string")),
                textOf(Reflect.get(edit, "new_string")),
              ),
            ]
          : [],
      )
    : [];
};

/**
 * The diff of a file a tool wrote, built from the tool's input: Claude
 * reports none of its own. A write is the file's whole text as added lines,
 * an edit each replacement as its removed and added lines.
 */
const fileDiff = (
  name: keyof typeof FILE_TOOL_PATHS,
  input: Readonly<Record<string, unknown>>,
): HarnessFileDiff => {
  const path = stringField(input, FILE_TOOL_PATHS[name]);
  switch (name) {
    case "Write":
      return {
        path,
        diff: wholeFileDiff(stringField(input, "content"), "add"),
      };
    case "NotebookEdit":
      return {
        path,
        diff: wholeFileDiff(stringField(input, "new_source"), "add"),
      };
    case "Edit":
    case "MultiEdit":
      return { path, diff: replacements(name, input).join("\n") };
    default:
      name satisfies never;
      return panic("Unhandled Claude file tool");
  }
};

/** A call as the main thread reports it. */
const mainThreadCall = (
  { id, name, input }: Pick<ClaudeToolUse, "id" | "name" | "input">,
  stellaServer: string,
): HarnessToolCall => {
  const kind = toolKind(name);
  switch (kind) {
    case "command":
      return nativeToolCall(id, {
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command: stringField(input, "command") },
      });
    case "file_change":
      return nativeToolCall(id, {
        name: HARNESS_TOOL_NAMES.fileChange,
        input: { changes: isFileTool(name) ? fileChanges(name, input) : [] },
      });
    case "web_search":
      return nativeToolCall(id, {
        name: HARNESS_TOOL_NAMES.webSearch,
        input: { query: stringField(input, "query") },
      });
    case "question":
      return { id, name: HARNESS_TOOL_NAMES.question, input };
    case "mcp":
      return {
        id,
        name: mcpToolCallName({ ...mcpName(name, stellaServer), stellaServer }),
        input,
      };
    case "native": {
      const detail = nativeDetail(name, input);
      return nativeToolCall(
        id,
        {
          name: HARNESS_TOOL_NAMES.nativeTool,
          input: { tool: name, ...(detail === undefined ? {} : { detail }) },
        },
        input,
      );
    }
    default:
      kind satisfies never;
      return panic("Unhandled Claude tool kind");
  }
};

/**
 * `stellaServer` is the server name the stella MCP binding is under;
 * `parentCallId` the call that started the subagent whose step this is, or
 * `null` on the main thread.
 */
export const toolCallForUse = (
  use: Pick<ClaudeToolUse, "id" | "name" | "input">,
  stellaServer: string,
  parentCallId: string | null,
): HarnessToolCall =>
  stepOfSubagent(mainThreadCall(use, stellaServer), parentCallId);

/** A tool result's text blocks; images and other blocks are not carried. */
export const resultText = (block: ClaudeToolResult) => {
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
      // The status only: Claude reports no exit code, and the command's
      // output stays here.
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.commandExecution,
          result: { status: outcome },
        }),
        status: status(failed),
        localOutput: { type: "command", output: text },
      };
    case "file_change":
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.fileChange,
          result: {
            changes: isFileTool(use.name)
              ? fileChanges(use.name, use.input)
              : [],
            status: outcome,
          },
        }),
        status: status(failed),
        // A refused or failed write changed nothing to show.
        ...(failed || !isFileTool(use.name)
          ? {}
          : {
              localOutput: {
                type: "diff",
                files: [fileDiff(use.name, use.input)],
              },
            }),
      };
    case "web_search":
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.webSearch,
          result: { status: outcome },
        }),
        status: status(failed),
      };
    case "native": {
      // What a built-in tool returned (a file it read, an image, the lines a
      // search matched, a fetched page, a subagent's report) stays here;
      // only how it ended is shown.
      const image = failed ? null : viewedImageOf(use);
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.nativeTool,
          result: { status: outcome },
        }),
        status: status(failed),
        // The file it viewed, for the member to open on this computer.
        ...(image === null
          ? {}
          : { localOutput: { type: "image", path: image } }),
      };
    }
    case "question":
    case "mcp":
      return {
        content: text === "" ? JSON.stringify({ status: outcome }) : text,
        status: status(failed),
      };
    default:
      kind satisfies never;
      return panic("Unhandled Claude tool kind");
  }
};
