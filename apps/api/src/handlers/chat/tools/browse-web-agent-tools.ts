import { BROWSE_WEB_TOOL_NAME } from "@stll/api-contract/browser-control";

import { createBrowserControlTool } from "@/api/handlers/chat/tools/browser-control-tool";
import type { ChatTool } from "@/api/lib/chat/chat-tool-types";

/**
 * The tools each chat sub-agent's child runs, by the sub-agent's name. A
 * child's calls live inside the parent message's `subagent` part, where the
 * parent turn's tool map never reaches, so an answer to one of them is
 * checked against this list.
 */
const SUBAGENT_CHILD_TOOLS = {
  [BROWSE_WEB_TOOL_NAME]: createBrowserControlTool(),
} as const;

const CHILD_TOOLS_BY_NAME: ReadonlyMap<string, ChatTool> = new Map(
  Object.values(SUBAGENT_CHILD_TOOLS).flatMap((tools) => Object.entries(tools)),
);

/** The tool a sub-agent child's call names, or `undefined` for a name no
 *  child runs. */
export const subagentChildTool = (name: string): ChatTool | undefined =>
  CHILD_TOOLS_BY_NAME.get(name);
