import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  announcementKey,
  isOpeningPhase,
  TURN_ANNOUNCEMENT_KEYS,
  turnAnnouncement,
  type TurnAnnouncementInput,
} from "@/routes/_protected.chat/-components/chat-turn-announcer.logic";

type ChatTurnAnnouncerProps = TurnAnnouncementInput & {
  /** `turnsStarted` of the thread's chat runtime. */
  turnsStarted: number;
};

/**
 * One polite live region for the thread's turn: it says when the turn needs
 * the member (an approval, a question) and how it ended (stopped, failed,
 * done). It stays mounted and visually hidden; what the thread showed when
 * it opened is not announced, only what changes after. Mount one per thread
 * (keyed by it), so opening another thread starts quiet.
 */
export const ChatTurnAnnouncer = ({
  turnsStarted,
  ...turn
}: ChatTurnAnnouncerProps) => {
  const t = useTranslations();
  const current = turnAnnouncement(turn);
  const key = current === null ? null : announcementKey(current);
  const shown = { key, turnsStarted };
  // What the thread showed when it opened. A later phase has a subject of
  // its own or follows a turn the page started, so it never matches this.
  const [opening] = useState(shown);
  return (
    <div aria-atomic="true" aria-live="polite" className="sr-only">
      {current === null || isOpeningPhase({ opening, shown }) ? null : (
        // Keyed by its subject: the same words about something new (a second
        // approval) replace the node, which is the change a live region reads.
        <span key={key}>{t(TURN_ANNOUNCEMENT_KEYS[current.announcement])}</span>
      )}
    </div>
  );
};
