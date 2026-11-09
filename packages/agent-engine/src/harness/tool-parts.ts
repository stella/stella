import { panic } from "better-result";
import path from "node:path";

import {
  CHAT_LOCAL_RUN_TOOL_NAMES,
  type ChatLocalRunToolCall,
  type ChatLocalRunToolCallInput,
  isChatLocalRunToolName,
  parseChatLocalRunToolCall,
} from "@stll/api-contract/chat-local-run-tool";
import { CHAT_LOCAL_RUN_QUESTION_TOOL } from "@stll/api-contract/chat-run-target";
import {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  type BuiltInChatToolPolicyKindByName,
} from "@stll/api-contract/chat-tool-policy";
import { MCP_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract/mcp-chat-tool-policy";
import {
  STELLA_MCP_TOOL_NAMES,
  type StellaMcpToolName,
} from "@stll/api-contract/mcp-tool-names";
import { isPathInside, repoRelativePath } from "@stll/portable-path";

import type { HarnessToolCall, HarnessToolResult } from "./events";

/**
 * How a local harness's tool activity is named in chat, shared by every
 * adapter. A cloud chat turn persists a stella tool under its registry name
 * and an external connector tool as `mcp__<server>__<tool>`; the web chat
 * picks cards, approvals, citations and source chips by that name. A harness
 * reports both kinds as MCP calls, so the adapter names a call to the stella
 * server the way a cloud turn does, and gives harness-native actions names no
 * stella tool uses.
 */

type ChatToolName = keyof BuiltInChatToolPolicyKindByName;

/**
 * Registry tools a chat turn knows under their registry name. A registry name
 * that is also a hand-written chat tool names a different tool there
 * (`read_document` reads the document open in the editor), so a call to it
 * keeps its server prefix and renders as the MCP call it is. Chat-projected
 * registry tools are generated into the chat policy from the same registry,
 * so for those the chat tool is the registry tool.
 */
const CHAT_NAMED_STELLA_TOOLS: ReadonlySet<string> = new Set(
  STELLA_MCP_TOOL_NAMES.filter(
    (name) =>
      !Object.hasOwn(BUILT_IN_CHAT_TOOL_POLICY_KINDS, name) ||
      Object.hasOwn(MCP_CHAT_TOOL_POLICY_KINDS, name),
  ),
);

/**
 * The chat name of an MCP tool call. `stellaServer` is the server name the
 * turn registered the stella MCP binding under; a tool the registry does not
 * define (a dynamic one) keeps its prefix like any connector tool.
 */
export const mcpToolCallName = ({
  server,
  tool,
  stellaServer,
}: {
  server: string;
  tool: string;
  stellaServer: string;
}): string =>
  server === stellaServer && CHAT_NAMED_STELLA_TOOLS.has(tool)
    ? tool
    : `mcp__${server}__${tool}`;

/** A harness-native action's name; a chat or stella tool name fails to compile. */
const harnessToolName = <const TName extends string>(
  name: TName extends ChatToolName | StellaMcpToolName ? never : TName,
): TName => name;

/**
 * Harness-native actions, persisted as tool calls the web chat shows as
 * generic activity. `web_search` is a stella chat tool with its own result
 * schema, so the harness's search is named apart from it. `nativeTool` is
 * any other built-in harness tool (reading a file, listing a directory),
 * with the harness's own tool name in its input.
 */
export const HARNESS_TOOL_NAMES = {
  commandExecution: harnessToolName(CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution),
  fileChange: harnessToolName(CHAT_LOCAL_RUN_TOOL_NAMES.fileChange),
  webSearch: harnessToolName(CHAT_LOCAL_RUN_TOOL_NAMES.webSearch),
  question: harnessToolName(CHAT_LOCAL_RUN_QUESTION_TOOL),
  permissions: harnessToolName("request_permissions"),
  nativeTool: harnessToolName(CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool),
  unsupportedItem: harnessToolName(CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem),
} as const;

/**
 * A harness-native step in the contract's shape (`chat-local-run-tool`),
 * before it is bounded: adapters build every native call through this, so
 * the fields a call may carry are the contract's and no others.
 */
export const nativeToolCall = (
  id: string,
  call: ChatLocalRunToolCallInput,
  localInput?: unknown,
): HarnessToolCall => ({
  id,
  name: call.name,
  input: call.input,
  ...(localInput === undefined ? {} : { localInput }),
});

/**
 * `file` relative to the run's folder, with `/` between its parts, when it is
 * inside the folder; else as given.
 */
const runRelative = (file: string, workspaceDir: string) => {
  if (!path.isAbsolute(file) || !isPathInside(workspaceDir, file)) {
    return file;
  }
  const relative = repoRelativePath(workspaceDir, file);
  return relative === "" ? "." : relative;
};

const withRunRelativePaths = (
  call: ChatLocalRunToolCall,
  workspaceDir: string,
): ChatLocalRunToolCall => {
  const relative = (file: string) => runRelative(file, workspaceDir);
  switch (call.name) {
    case CHAT_LOCAL_RUN_TOOL_NAMES.fileChange:
      return {
        ...call,
        input: {
          changes: call.input.changes.map((change) => ({
            ...change,
            path: relative(change.path),
          })),
        },
      };
    case CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool: {
      const { detail } = call.input;
      if (detail?.kind === "read") {
        return {
          ...call,
          input: {
            ...call.input,
            detail: { ...detail, path: relative(detail.path) },
          },
        };
      }
      if (detail?.kind === "search" && detail.path !== undefined) {
        return {
          ...call,
          input: {
            ...call.input,
            detail: { ...detail, path: relative(detail.path) },
          },
        };
      }
      return call;
    }
    case CHAT_LOCAL_RUN_TOOL_NAMES.commandExecution:
    case CHAT_LOCAL_RUN_TOOL_NAMES.webSearch:
    case CHAT_LOCAL_RUN_TOOL_NAMES.unsupportedItem:
      return call;
    default:
      call satisfies never;
      return panic("Unhandled local run tool call");
  }
};

/**
 * The input a call is reported with. A harness-native step keeps only the
 * contract's bounded fields, with its file names relative to the run's
 * folder `workspaceDir`; it runs after the skill filter, so a skill's path is
 * already `<skill:name>` and is never cut in half. Any other call (an MCP
 * tool, a question) is reported as the adapter built it.
 */
export const shownToolInput = (
  call: HarnessToolCall,
  workspaceDir: string,
): unknown => {
  if (!isChatLocalRunToolName(call.name)) {
    return call.input;
  }
  const shown = parseChatLocalRunToolCall(call.name, call.input);
  return shown === null ? {} : withRunRelativePaths(shown, workspaceDir).input;
};

const ITEM_TYPE_MAX_LENGTH = 128;

/**
 * A harness item kind the adapter does not know, as a failed tool call: the
 * user sees that the harness did something Stella cannot show, and the call
 * carries only the kind, never the item's payload.
 */
export const unsupportedItem = (
  id: string,
  itemType: string,
): { toolCall: HarnessToolCall; result: HarnessToolResult } => {
  const kind = itemType.slice(0, ITEM_TYPE_MAX_LENGTH);
  return {
    toolCall: {
      id,
      name: HARNESS_TOOL_NAMES.unsupportedItem,
      input: { itemType: kind },
    },
    result: {
      content: JSON.stringify({
        error: {
          code: "unsupported_item",
          message: `The harness reported a ${kind} item, which stella cannot show.`,
        },
      }),
      status: "failed",
    },
  };
};
