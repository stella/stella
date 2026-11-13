import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  TURN_ANNOUNCEMENT_KEYS,
  turnAnnouncement,
  type TurnAnnouncementInput,
} from "@/components/chat/chat-turn-announcer.logic";

/**
 * One polite live region for the thread's turn: it says when the turn needs
 * the member (an approval, a question) and how it ended (stopped, failed,
 * done). It stays mounted and visually hidden; what the thread showed when
 * it opened is not announced, only what changes after. Mount one per thread
 * (keyed by it), so opening another thread starts quiet.
 */
export const ChatTurnAnnouncer = (props: TurnAnnouncementInput) => {
  const t = useTranslations();
  const current = turnAnnouncement(props);
  const key =
    current === null ? null : `${current.announcement}:${current.subject}`;
  // What the thread showed when it opened. Every later phase has a subject
  // of its own, so it never matches this one.
  const [opening] = useState(key);
  return (
    <div aria-atomic="true" aria-live="polite" className="sr-only">
      {current === null || key === opening
        ? ""
        : t(TURN_ANNOUNCEMENT_KEYS[current.announcement])}
    </div>
  );
};
