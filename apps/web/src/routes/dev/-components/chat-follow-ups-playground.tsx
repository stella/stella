import { toChatThreadId } from "@/lib/chat-thread-ref";

import { CHAT_ANSWER_FOOTER_CASSETTE } from "./chat-answer-footer-cassette";
import { ChatCitationsPlayground } from "./chat-citations-playground";

const noop = () => undefined;

const ANSWER_ID = CHAT_ANSWER_FOOTER_CASSETTE.at(-1)?.id ?? "";

// Three suggestions, one long enough to wrap in a narrow column.
const FOLLOW_UPS = [
  "Ověř, zda výpověď musí obsahovat poučení o právu podat žalobu na přezkoumání výpovědi a v jaké lhůtě.",
  "Najdi rozhodnutí Nejvyššího soudu k opakovanému prodlení s nájemným.",
  "Připrav vzor výzvy k zaplacení dlužného nájemného.",
  "Shrň, co z toho plyne pro nájemce.",
];

/**
 * Suggested follow-ups where they appear: after a finished answer's actions,
 * in the transcript's flow. A fourth suggestion is passed and never shown.
 */
export const ChatFollowUpsPlayground = () => (
  <ChatCitationsPlayground
    cassette={CHAT_ANSWER_FOOTER_CASSETTE}
    followUps={{
      analyticsSurface: "chat-thread",
      messageId: ANSWER_ID,
      onSelect: noop,
      prompts: FOLLOW_UPS,
      threadId: toChatThreadId("dev-follow-ups"),
    }}
  />
);
