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
import { HARNESS_QUESTION_TOOL } from "./stream-chunks";

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
  commandExecution: harnessToolName("command_execution"),
  fileChange: harnessToolName("file_change"),
  webSearch: harnessToolName("harness_web_search"),
  question: harnessToolName(HARNESS_QUESTION_TOOL),
  permissions: harnessToolName("request_permissions"),
  nativeTool: harnessToolName("harness_native_tool"),
  unsupportedItem: harnessToolName("harness_unsupported_item"),
} as const;

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
