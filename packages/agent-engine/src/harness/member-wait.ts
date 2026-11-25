import {
  CHAT_LOCAL_RUN_BROWSER_ACTIONS,
  type ChatLocalRunBrowserAction,
} from "@stll/api-contract/chat-local-run-tool";

/**
 * The one owner of "a tool call that may wait on the member". A browser step
 * the member must allow asks inside its MCP call (`sidecar/browser`), so the
 * call lasts as long as the member takes to answer. Every harness and bridge
 * that carries such a call bounds it by this, never by its own per-call
 * default (60 s in Codex, 120 s in the stdio bridge), which would cut the
 * member's wait short and withdraw a question they are still reading.
 *
 * A harness needs a finite number, and a Node timer stops at 2^31 - 1 ms
 * (about 24.8 days); one day is far beyond any time an answer takes. A call
 * that still waits then is withdrawn like any step that never ran: the run
 * goes on, and its end closes the question.
 *
 * A harness's own approvals (a command, a file change, a stella tool in
 * Claude Code) are asked before the call starts and are not bounded by a
 * tool timeout. The stella MCP server never waits on the member: it answers
 * a destructive call that lacks confirmation with `confirmation_required`,
 * and the adapters decline its elicitations at once.
 */
export const MEMBER_WAIT_CALL_TIMEOUT_MS = 24 * 60 * 60_000;

/** `MEMBER_WAIT_CALL_TIMEOUT_MS`, for a harness that takes seconds. */
export const MEMBER_WAIT_CALL_TIMEOUT_SECONDS =
  MEMBER_WAIT_CALL_TIMEOUT_MS / 1000;

/**
 * Which browser tools may ask the member before they run
 * (`decideBrowserStep`): opening a website the chat has not visited, and a
 * step on an element. Reading, finding, going back and switching tabs never
 * ask.
 */
const BROWSER_TOOL_MAY_ASK = {
  open: true,
  snapshot: false,
  find: false,
  click: true,
  type: true,
  press_key: true,
  select: true,
  go_back: false,
  switch_tab: false,
} as const satisfies Record<ChatLocalRunBrowserAction, boolean>;

/** The browser tools that may wait on the member, by their MCP names. */
export const BROWSER_TOOLS_THAT_MAY_ASK: readonly ChatLocalRunBrowserAction[] =
  CHAT_LOCAL_RUN_BROWSER_ACTIONS.filter((name) => BROWSER_TOOL_MAY_ASK[name]);

/** The browser tools that never wait on the member. */
export const BROWSER_TOOLS_THAT_NEVER_ASK: readonly ChatLocalRunBrowserAction[] =
  CHAT_LOCAL_RUN_BROWSER_ACTIONS.filter((name) => !BROWSER_TOOL_MAY_ASK[name]);
