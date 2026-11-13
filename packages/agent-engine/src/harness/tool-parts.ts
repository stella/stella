import { panic } from "better-result";

import {
  CHAT_LOCAL_RUN_TOOL_NAMES,
  type ChatLocalRunToolCall,
  type ChatLocalRunToolCallInput,
  chatLocalRunToolResultContent,
  chatLocalRunToolStatusContent,
  isChatLocalRunBrowserAction,
  isChatLocalRunToolName,
  parseChatLocalRunToolCall,
  parseChatLocalRunToolResult,
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

import type { HarnessToolCall, HarnessToolResult } from "./events";
import { runRelativePath } from "./step-output";

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
  browser: harnessToolName(CHAT_LOCAL_RUN_TOOL_NAMES.browser),
} as const;

/**
 * The MCP server name a local run's browser tools are registered under
 * (`sidecar/browser`). Their calls are steps on the member's computer, not
 * stella or connector tools.
 */
export const LOCAL_BROWSER_MCP_SERVER_NAME = "stella_browser";

/**
 * The call an adapter reports for an MCP tool. A browser step keeps only
 * its kind and, for `open`, the address the agent chose: the element it
 * clicked and the text it typed stay on the computer, and so does its
 * result (`shownToolResult`). Any other call is named by `mcpToolCallName`.
 */
export const mcpToolCall = ({
  id,
  input,
  server,
  stellaServer,
  tool,
}: {
  id: string;
  input: unknown;
  server: string;
  stellaServer: string;
  tool: string;
}): HarnessToolCall => {
  if (server !== LOCAL_BROWSER_MCP_SERVER_NAME) {
    return { id, name: mcpToolCallName({ server, tool, stellaServer }), input };
  }
  if (!isChatLocalRunBrowserAction(tool)) {
    return unsupportedItem(id, `${server}:${tool}`).toolCall;
  }
  if (tool !== "open") {
    return nativeToolCall(id, {
      name: HARNESS_TOOL_NAMES.browser,
      input: { action: tool },
    });
  }
  const url: unknown =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "url")
      : undefined;
  return nativeToolCall(id, {
    name: HARNESS_TOOL_NAMES.browser,
    input: { action: tool, ...(typeof url === "string" ? { url } : {}) },
  });
};

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
 * `call` as a step of the subagent whose own step is `parentCallId`, or as
 * it is on the main thread (`null`). Only a harness-native step names its
 * subagent: the link is a field of the contract's input, and any other call
 * (an MCP tool, a question) is reported with the input its tool defines, so
 * it stays on the turn itself.
 */
export const stepOfSubagent = (
  call: HarnessToolCall,
  parentCallId: string | null,
): HarnessToolCall =>
  parentCallId === null ||
  !isChatLocalRunToolName(call.name) ||
  typeof call.input !== "object" ||
  call.input === null
    ? call
    : { ...call, input: { ...call.input, parentCallId } };

const withRunRelativePaths = (
  call: ChatLocalRunToolCall,
  workspaceDir: string,
): ChatLocalRunToolCall => {
  const relative = (file: string) => runRelativePath(file, workspaceDir);
  switch (call.name) {
    case CHAT_LOCAL_RUN_TOOL_NAMES.fileChange:
      return {
        ...call,
        input: {
          ...call.input,
          changes: call.input.changes.map((change) => ({
            ...change,
            path: relative(change.path),
          })),
        },
      };
    case CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool: {
      const { detail } = call.input;
      if (detail?.kind === "read" || detail?.kind === "image") {
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
    case CHAT_LOCAL_RUN_TOOL_NAMES.browser:
      return call;
    default:
      call satisfies never;
      return panic("Unhandled local run tool call");
  }
};

/**
 * The result content a call is reported with. A harness-native step keeps
 * only how it ended (`chat-local-run-tool`), with a change's file names
 * relative to the run's folder as its call names them; any other call's
 * content is reported as the adapter built it.
 */
export const shownToolResult = (
  call: HarnessToolCall,
  content: string,
  failed: boolean,
  workspaceDir: string,
): string => {
  if (!isChatLocalRunToolName(call.name)) {
    return content;
  }
  const shown = parseChatLocalRunToolResult(call.name, content);
  if (shown === null) {
    return chatLocalRunToolStatusContent(failed);
  }
  if (shown.name !== CHAT_LOCAL_RUN_TOOL_NAMES.fileChange) {
    return JSON.stringify(shown.result);
  }
  return JSON.stringify({
    ...shown.result,
    changes: shown.result.changes.map((change) => ({
      ...change,
      path: runRelativePath(change.path, workspaceDir),
    })),
  });
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
      // The title says stella cannot show the step; nothing of it is sent.
      content: chatLocalRunToolResultContent({
        name: HARNESS_TOOL_NAMES.unsupportedItem,
        result: { status: "failed" },
      }),
      status: "failed",
    },
  };
};
