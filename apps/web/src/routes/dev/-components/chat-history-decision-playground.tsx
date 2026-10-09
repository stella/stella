import { LANDING_ROW_CLASS, LandingItemText } from "@stll/ui/landing";

import {
  ChatThreadDecisionLabel,
  drawableChatThreadDecision,
} from "@/routes/_protected.chat/-components/chat-thread-decision";

import { CHAT_HISTORY_DECISION_FIXTURES } from "./chat-history-decision-fixtures";

export const ChatHistoryDecisionPlayground = () => (
  <section
    className="w-full max-w-md p-4"
    data-playground-section="chat-history-decision"
  >
    <ul className="flex flex-col gap-1">
      {CHAT_HISTORY_DECISION_FIXTURES.map((fixture) => {
        const decision = drawableChatThreadDecision(fixture);
        return (
          <li
            className={LANDING_ROW_CLASS}
            data-playground-state={fixture.state}
            key={fixture.state}
          >
            <LandingItemText
              meta={
                decision === null ? null : (
                  <ChatThreadDecisionLabel decision={decision} />
                )
              }
              title={fixture.title}
            />
          </li>
        );
      })}
    </ul>
  </section>
);
