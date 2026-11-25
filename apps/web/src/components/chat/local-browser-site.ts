import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import type { BrowserStepAskReason } from "@stll/api-contract/browser-step-gate";
import {
  CHAT_LOCAL_RUN_TOOL_NAMES,
  parseChatLocalRunToolCall,
} from "@stll/api-contract/chat-local-run-tool";

/** What a browser step on the member's computer asks, as the desktop put it. */
export type LocalBrowserQuestion = {
  /**
   * The website the step asks about, by exact origin: the page the desktop
   * read, as it named it in the question, or the address a page is opened
   * at. Null for a page that cannot hold a website approval. Always allowing
   * it answers the step for the rest of its run; the desktop then adds the
   * website it read itself, never this one.
   */
  site: string | null;
  /**
   * Why the desktop's gate asks (`decideBrowserStep`); null for a question
   * from a desktop that did not say.
   */
  reason: BrowserStepAskReason | null;
};

/** The question of a browser step on the member's computer; null for any other card. */
export const localBrowserQuestion = (
  toolName: string,
  input: unknown,
): LocalBrowserQuestion | null => {
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
  const reason = "why" in call.input ? (call.input.why ?? null) : null;
  if ("asked" in call.input) {
    return {
      reason,
      site:
        call.input.asked === undefined
          ? null
          : browserSiteGrantOrigin(call.input.asked.url),
    };
  }
  if (call.input.action !== "open") {
    return null;
  }
  return {
    reason,
    site:
      call.input.url === undefined
        ? null
        : browserSiteGrantOrigin(call.input.url),
  };
};
