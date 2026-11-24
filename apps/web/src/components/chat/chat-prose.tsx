import type { ReactNode } from "react";

/**
 * Marks the words a message says (an answer's text, the member's own
 * message) as distinct from the chrome around them: tool and approval cards,
 * step rows, headers and footers. Only words inside it offer the selection
 * actions (ask in a new chat, quote in the reply, edit the answer), so a card
 * added to a message can never offer them by accident.
 */
const CHAT_PROSE_ATTRIBUTE = "data-chat-prose";

/** Wraps a message's prose; adds no box of its own. */
export const ChatProse = ({ children }: { children: ReactNode }) => (
  // Spelled as `CHAT_PROSE_ATTRIBUTE`.
  <div className="contents" data-chat-prose="">
    {children}
  </div>
);

/** The prose element `node` sits in, if any. */
export const chatProseElementOf = (node: Node | null): Element | null => {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest(`[${CHAT_PROSE_ATTRIBUTE}]`) ?? null;
};
