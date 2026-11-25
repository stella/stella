import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import {
  CHAT_LOCAL_RUN_TOOL_NAMES,
  parseChatLocalRunToolCall,
} from "@stll/api-contract/chat-local-run-tool";

/**
 * The website a browser step on the member's computer asks about, by exact
 * origin: the page the desktop read, as it named it in the question, or the
 * address a page is opened at. Null
 * for any other card, or a page that cannot hold a website approval.
 * Always allowing it answers the step for the rest of its run; the desktop
 * then adds the website it read itself, never this one.
 */
export const localBrowserApprovalSite = (
  toolName: string,
  input: unknown,
): string | null => {
  if (toolName !== CHAT_LOCAL_RUN_TOOL_NAMES.browser) {
    return null;
  }
  const call = parseChatLocalRunToolCall(
    CHAT_LOCAL_RUN_TOOL_NAMES.browser,
    input,
  );
  if (call?.name !== CHAT_LOCAL_RUN_TOOL_NAMES.browser) {
    return null;
  }
  if ("asked" in call.input) {
    return call.input.asked === undefined
      ? null
      : browserSiteGrantOrigin(call.input.asked.url);
  }
  return "url" in call.input && call.input.url !== undefined
    ? browserSiteGrantOrigin(call.input.url)
    : null;
};
