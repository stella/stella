import { panic } from "better-result";
import * as v from "valibot";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TOOL_NAME,
  type BrowserControlResult,
  browserControlResultSchema,
  supersedeBrowserControlResult,
} from "@stll/api-contract/browser-control";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { ChatPart, ChatSubagentPart } from "@/api/handlers/chat/types";

// A tool-mode sub-agent part (TanStack `chat({ subagents })`) whose child
// browsed: each step a `use-browser` call and its result, each carrying a
// whole page snapshot, as the browser extension returns it.

export type SubagentStatus = ChatSubagentPart["subagent"]["status"];

export const SUBAGENT_PARENT_CALL_ID = "call-browse-1";

/** A page snapshot whose text names `label`, so a stored copy is findable. */
export const pageResult = (label: string): BrowserControlResult =>
  v.parse(browserControlResultSchema, {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [],
      revision: `rev-${label}`,
      tabId: 7,
      tabs: [{ active: true, tabId: 7, url: `https://example.cz/${label}` }],
      text: `Stránka ${label} ${"ž".repeat(BROWSER_CONTROL_LIMITS.pageTextChars - 40)}`,
      textOffset: 0,
      textTotalChars: 120_000,
      title: `Page ${label}`,
      url: `https://example.cz/${label}`,
    },
    status: "success",
  });

/** Whether `output` is a whole page, rather than its projection. */
export const isRawPage = (output: unknown): boolean =>
  v.safeParse(browserControlResultSchema, output).success &&
  supersedeBrowserControlResult(output) !== null;

const browserCall = (id: string): ChatPart => ({
  arguments: "{}",
  id,
  input: {},
  metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
  name: BROWSER_CONTROL_TOOL_NAME,
  output: pageResult(id),
  state: "complete",
  type: "tool-call",
});

const browserResult = (id: string): ChatPart => ({
  content: JSON.stringify(pageResult(id)),
  state: "complete",
  toolCallId: id,
  type: "tool-result",
});

/** The fields each status requires, as the SDK's processor writes them. */
const STATUS_FIELDS = {
  error: { error: { message: "The browser closed." } },
  finished: {},
  running: {},
  suspended: { interruptIds: ["interrupt-1"] },
} as const satisfies Record<
  SubagentStatus,
  Partial<ChatSubagentPart["subagent"]>
>;

/** The id of page `page` of the child `browsingChild(status, …)` builds. */
export const childPageId = (status: SubagentStatus, page: number) =>
  `${status}-p${String(page)}`;

/** A browsing child in `status` that read `pages` pages. */
export const browsingChild = (
  status: SubagentStatus,
  pages: number,
): ChatSubagentPart => ({
  subagent: {
    ...STATUS_FIELDS[status],
    id: `child-${status}`,
    messages: [
      {
        id: `child-${status}-task`,
        parts: [{ content: "Najdi komentář k § 88.", type: "text" }],
        role: "user",
      },
      {
        id: `child-${status}-answer`,
        parts: [
          ...Array.from({ length: pages }, (_, page) => [
            browserCall(childPageId(status, page)),
            browserResult(childPageId(status, page)),
          ]).flat(),
          { content: "Komentář je na poslední stránce.", type: "text" },
        ],
        role: "assistant",
      },
    ],
    name: "browse",
    parentToolCallId: SUBAGENT_PARENT_CALL_ID,
    status,
  },
  type: "subagent",
});

/** Each child output `part` holds, on a call or in a result part, with the
 *  id of the call it answers. */
export const childOutputs = (
  part: ChatPart | undefined,
): { id: string; output: unknown }[] => {
  if (part?.type !== "subagent") {
    return panic("Expected a subagent part");
  }
  return part.subagent.messages.flatMap((message) =>
    message.parts.flatMap((child) => {
      if (child.type === "tool-call" && child.output !== undefined) {
        return [{ id: child.id, output: child.output }];
      }
      if (child.type === "tool-result" && typeof child.content === "string") {
        const output: unknown = JSON.parse(child.content);
        return [{ id: child.toolCallId, output }];
      }
      return [];
    }),
  );
};

/** The calls whose whole page `part`'s child still holds, once per copy. */
export const rawPageIds = (part: ChatPart | undefined): string[] =>
  childOutputs(part).flatMap(({ id, output }) =>
    isRawPage(output) ? [id] : [],
  );
