import { CHAT_LOCAL_RUN_STEP_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";
import { chatLocalRunToolResultContent } from "@stll/api-contract/chat-local-run-tool";

import type { HarnessToolCall, HarnessToolResult } from "../events";
import {
  type HarnessFileDiff,
  type HarnessStepOutput,
  replacementDiff,
  wholeFileDiff,
} from "../step-output";
import { HARNESS_TOOL_NAMES, mcpToolCall, nativeToolCall } from "../tool-parts";
import {
  acpBlockText,
  type AcpLocation,
  type AcpToolCallContent,
  type AcpToolCallFields,
  parseToolCallContent,
} from "./protocol";

/**
 * A tool call as the agent has described it so far. ACP sends a call once
 * (`tool_call`) and then partial updates (`tool_call_update`): a field that
 * is absent is unchanged, `null` clears it, and a present list replaces the
 * old one. An update without a title keeps the title, an update that only
 * moves the call's locations still counts, and an empty `rawInput` never
 * wipes the input an earlier message gave.
 */
export type AcpToolCallState = {
  id: string;
  title: string;
  kind: string | null;
  status: string;
  content: readonly AcpToolCallContent[];
  locations: readonly AcpLocation[];
  rawInput: unknown;
  rawOutput: unknown;
};

/** A string kept in memory for a step: its last `max` UTF-16 units, whole. */
export const boundedTail = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }
  const tail = text.slice(text.length - max);
  // Never start on the second half of a surrogate pair.
  return /^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail;
};

/** What a step's output may hold; the sidecar bounds it again in bytes. */
const OUTPUT_MAX_CHARS = CHAT_LOCAL_RUN_STEP_MAX_BYTES.text;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mergedInput = (previous: unknown, next: unknown): unknown => {
  if (next === undefined || next === null) {
    return previous;
  }
  if (isRecord(next)) {
    if (Object.keys(next).length === 0) {
      return previous;
    }
    return isRecord(previous) ? { ...previous, ...next } : next;
  }
  return next;
};

/** `fields` applied over `previous`, or a new call from them. */
export const mergeToolCall = (
  previous: AcpToolCallState | null,
  fields: AcpToolCallFields,
): AcpToolCallState => {
  const title =
    typeof fields.title === "string" && fields.title.trim() !== ""
      ? fields.title
      : (previous?.title ?? "");
  return {
    id: fields.toolCallId,
    title,
    kind: fields.kind ?? previous?.kind ?? null,
    status: fields.status ?? previous?.status ?? "pending",
    content:
      fields.content === undefined
        ? (previous?.content ?? [])
        : parseToolCallContent(fields.content ?? []),
    locations:
      fields.locations === undefined
        ? (previous?.locations ?? [])
        : (fields.locations ?? []),
    rawInput: mergedInput(previous?.rawInput, fields.rawInput),
    rawOutput:
      fields.rawOutput === undefined
        ? previous?.rawOutput
        : (fields.rawOutput ?? undefined),
  };
};

/** Whether `next` says anything `previous` did not, locations included. */
export const toolCallChanged = (
  previous: AcpToolCallState,
  next: AcpToolCallState,
) =>
  previous.title !== next.title ||
  previous.kind !== next.kind ||
  previous.status !== next.status ||
  previous.content !== next.content ||
  previous.rawInput !== next.rawInput ||
  previous.rawOutput !== next.rawOutput ||
  JSON.stringify(previous.locations) !== JSON.stringify(next.locations);

export const isFinished = (call: AcpToolCallState) =>
  call.status === "completed" || call.status === "failed";

/** The MCP servers a turn registered, by the names it gave them. */
export type AcpMcpNames = { stella: string; others: readonly string[] };

const MCP_TITLE_PREFIX = /^(?:running|run|calling|call)\s+/iu;

/**
 * The MCP server and tool a call's title names, for the servers the turn
 * registered. ACP has no field for it, so agents spell it in the title:
 * `mcp__<server>__<tool>`, `mcp_<server>_<tool>`, `<server>__<tool>`,
 * `<server>/<tool>` or `<tool> (<server> MCP Server)`, sometimes after a
 * verb ("Running ...", "Run ...") and with a trailing `?`.
 */
export const mcpToolOfTitle = (
  title: string,
  names: AcpMcpNames,
): { server: string; tool: string } | null => {
  const bare = title.trim().replace(MCP_TITLE_PREFIX, "").replace(/\?$/u, "");
  const servers = [names.stella, ...names.others];
  const suffixed = /^(?<tool>[\w.-]+) \((?<server>[\w.-]+) MCP Server\)$/u.exec(
    bare,
  );
  if (
    suffixed?.groups?.["tool"] !== undefined &&
    servers.includes(suffixed.groups["server"] ?? "")
  ) {
    return {
      server: suffixed.groups["server"] ?? "",
      tool: suffixed.groups["tool"],
    };
  }
  for (const server of servers) {
    for (const prefix of [
      `mcp__${server}__`,
      `mcp_${server}_`,
      `${server}__`,
      `${server}/`,
    ]) {
      if (bare.startsWith(prefix) && bare.length > prefix.length) {
        const tool = bare.slice(prefix.length);
        if (/^[\w.-]+$/u.test(tool)) {
          return { server, tool };
        }
      }
    }
  }
  return null;
};

const stringField = (
  value: unknown,
  keys: readonly string[],
): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim() !== "") {
      return field;
    }
    if (
      Array.isArray(field) &&
      field.length > 0 &&
      field.every((part) => typeof part === "string")
    ) {
      return field.join(" ");
    }
  }
  return null;
};

const COMMAND_KEYS = [
  "command",
  "cmd",
  "commandLine",
  "CommandLine",
  "command_line",
];
const PATH_KEYS = ["path", "file_path", "filePath", "abs_path", "AbsolutePath"];
const PATTERN_KEYS = ["pattern", "query", "Query", "regex", "glob"];
const URL_KEYS = ["url", "Url", "uri"];

/** A title wrapped in backticks, as agents title a command. */
const unquoted = (title: string) => title.replace(/^`([^`]*)`$/u, "$1").trim();

const firstPath = (call: AcpToolCallState): string | null =>
  call.locations[0]?.path ?? stringField(call.rawInput, PATH_KEYS);

const changeKind = (call: AcpToolCallState, diff: AcpToolCallContent) => {
  if (call.kind === "delete") {
    return "delete" as const;
  }
  return diff.type === "diff" &&
    (diff.oldText === null || diff.oldText === undefined)
    ? ("add" as const)
    : ("update" as const);
};

const diffsOf = (call: AcpToolCallState) =>
  call.content.flatMap((entry) => (entry.type === "diff" ? [entry] : []));

/** The files a change touched: its diffs, else its locations. */
const fileChanges = (call: AcpToolCallState) => {
  const diffs = diffsOf(call);
  if (diffs.length > 0) {
    return diffs.map((diff) => ({
      path: diff.path,
      kind: changeKind(call, diff),
    }));
  }
  const kind = call.kind === "delete" ? "delete" : "update";
  return call.locations.map(({ path }) => ({ path, kind }));
};

/**
 * The call chat shows for `call`. A call to an MCP server the turn
 * registered is named as a cloud turn names it; the agent's own actions by
 * their ACP kind; anything else is a native tool under its title.
 */
export const harnessToolCall = (
  call: AcpToolCallState,
  names: AcpMcpNames,
): HarnessToolCall => {
  const mcp = mcpToolOfTitle(call.title, names);
  if (mcp !== null) {
    return mcpToolCall({
      id: call.id,
      input: isRecord(call.rawInput) ? call.rawInput : {},
      server: mcp.server,
      stellaServer: names.stella,
      tool: mcp.tool,
    });
  }
  const tool = call.title.trim() === "" ? (call.kind ?? "tool") : call.title;
  switch (call.kind) {
    case "execute": {
      const command =
        stringField(call.rawInput, COMMAND_KEYS) ?? unquoted(call.title);
      return nativeToolCall(call.id, {
        name: HARNESS_TOOL_NAMES.commandExecution,
        input: { command },
      });
    }
    case "edit":
    case "delete":
    case "move":
      return nativeToolCall(call.id, {
        name: HARNESS_TOOL_NAMES.fileChange,
        input: { changes: fileChanges(call) },
      });
    case "read": {
      const path = firstPath(call);
      return nativeToolCall(call.id, {
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: {
          tool,
          ...(path === null ? {} : { detail: { kind: "read" as const, path } }),
        },
      });
    }
    case "search": {
      const pattern = stringField(call.rawInput, PATTERN_KEYS);
      const path = firstPath(call);
      return nativeToolCall(call.id, {
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: {
          tool,
          ...(pattern === null
            ? {}
            : {
                detail: {
                  kind: "search" as const,
                  pattern,
                  ...(path === null ? {} : { path }),
                },
              }),
        },
      });
    }
    case "fetch": {
      const url = stringField(call.rawInput, URL_KEYS);
      if (url === null) {
        const query = stringField(call.rawInput, PATTERN_KEYS);
        return query === null
          ? nativeToolCall(call.id, {
              name: HARNESS_TOOL_NAMES.nativeTool,
              input: { tool },
            })
          : nativeToolCall(call.id, {
              name: HARNESS_TOOL_NAMES.webSearch,
              input: { query },
            });
      }
      return nativeToolCall(call.id, {
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: { tool, detail: { kind: "fetch" as const, url } },
      });
    }
    default:
      return nativeToolCall(call.id, {
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: { tool },
      });
  }
};

const contentText = (call: AcpToolCallState) =>
  call.content
    .flatMap((entry) => {
      if (entry.type !== "content") {
        return [];
      }
      const text = acpBlockText(entry.content);
      return text === null ? [] : [text];
    })
    .join("\n");

const OUTPUT_KEYS = [
  "output",
  "stdout",
  "combinedOutput",
  "formatted_output",
  "content",
];

/** What the call produced as text: its content, else its raw output. */
const outputText = (call: AcpToolCallState): string => {
  const text = contentText(call);
  if (text !== "") {
    return text;
  }
  if (typeof call.rawOutput === "string") {
    return call.rawOutput;
  }
  return stringField(call.rawOutput, OUTPUT_KEYS) ?? "";
};

const EXIT_CODE_KEYS = ["exitCode", "exit_code", "ExitCode"];

const exitCodeOf = (call: AcpToolCallState): number | null => {
  if (!isRecord(call.rawOutput)) {
    return null;
  }
  for (const key of EXIT_CODE_KEYS) {
    const code = call.rawOutput[key];
    if (typeof code === "number" && Number.isSafeInteger(code)) {
      return code;
    }
  }
  return null;
};

const diffOutput = (call: AcpToolCallState): HarnessStepOutput | null => {
  const files: HarnessFileDiff[] = diffsOf(call).map((diff) => ({
    path: diff.path,
    diff:
      diff.oldText === null || diff.oldText === undefined
        ? wholeFileDiff(diff.newText, "add")
        : replacementDiff(diff.oldText, diff.newText),
  }));
  return files.length === 0 ? null : { type: "diff", files };
};

/** The ending a call's status reports, in chat's words. */
type Ending = "completed" | "failed" | "declined" | "interrupted";

const RESULT_STATUS: Readonly<Record<Ending, HarnessToolResult["status"]>> = {
  completed: "succeeded",
  failed: "failed",
  declined: "failed",
  interrupted: "cancelled",
};

/**
 * How `call` ended, as chat keeps it. `ending` overrides the agent's status
 * for a call the turn ended or the member declined.
 */
export const harnessToolResult = (
  call: AcpToolCallState,
  shown: HarnessToolCall,
  ending: Ending,
): HarnessToolResult => {
  const status = RESULT_STATUS[ending];
  switch (shown.name) {
    case HARNESS_TOOL_NAMES.commandExecution: {
      const exitCode = exitCodeOf(call);
      const output = boundedTail(outputText(call), OUTPUT_MAX_CHARS);
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.commandExecution,
          result: {
            status: ending,
            ...(exitCode === null ? {} : { exit_code: exitCode }),
          },
        }),
        status,
        ...(output === "" ? {} : { localOutput: { type: "command", output } }),
      };
    }
    case HARNESS_TOOL_NAMES.fileChange: {
      const diff = diffOutput(call);
      return {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.fileChange,
          result: { changes: fileChanges(call), status: ending },
        }),
        status,
        ...(diff === null ? {} : { localOutput: diff }),
      };
    }
    case HARNESS_TOOL_NAMES.webSearch:
    case HARNESS_TOOL_NAMES.nativeTool:
    case HARNESS_TOOL_NAMES.browser:
      return {
        content: chatLocalRunToolResultContent({
          name: shown.name,
          result: { status: ending },
        }),
        status,
      };
    default: {
      // An MCP tool: its text is the tool's own result, as a cloud turn
      // stores it.
      const text = boundedTail(outputText(call), OUTPUT_MAX_CHARS);
      return {
        content:
          text === ""
            ? JSON.stringify({
                status: ending === "completed" ? "completed" : "failed",
              })
            : text,
        status,
      };
    }
  }
};
