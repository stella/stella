import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { ClockIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { chatThreadRecapOptions } from "@/routes/_protected.chat/-queries";

// Mirrors RECAP_STALENESS_THRESHOLD_MS in
// apps/api/src/handlers/chat/thread-recap.ts. The server re-checks
// staleness before spending a model call, so the two only need to
// agree loosely.
const RECAP_STALENESS_THRESHOLD_MS = 4 * 60 * 60 * 1000;
// A user + assistant pair is the least that has anything to recap.
const RECAP_MIN_MESSAGE_COUNT = 2;

type ChatThreadRecapProps = {
  activeOrganizationId: string;
  isGenerating: boolean;
  lastActivityAt: string | null;
  lastMessageId: string | null;
  lastMessageRole: PersistedChatMessage["role"] | null;
  messageCount: number;
  threadRef: ChatThreadRef;
};

/**
 * Subtle "where you left off" recap shown below the last message when
 * the user reopens a thread after a gap. The component is keyed by
 * threadId at the call site so it remounts (and re-stamps `openedAt`)
 * per thread; it renders nothing until the thread is both idle and
 * stale enough to count as a revisit.
 */
export const ChatThreadRecap = ({
  activeOrganizationId,
  isGenerating,
  lastActivityAt,
  lastMessageId,
  lastMessageRole,
  messageCount,
  threadRef,
}: ChatThreadRecapProps) => {
  const t = useTranslations();
  // Stamp "now" and the message the thread opened on once per mount,
  // so the staleness check stays pure and is evaluated at thread-open
  // time. The component is keyed by threadId at the call site, so both
  // re-capture per thread.
  const [openedAt] = useState(() => Date.now());
  const [openedOnMessageId] = useState(() => lastMessageId);
  const isStale =
    lastActivityAt !== null &&
    openedAt - new Date(lastActivityAt).getTime() >
      RECAP_STALENESS_THRESHOLD_MS;
  const eligible =
    !isGenerating &&
    lastMessageId !== null &&
    // The recap describes the thread as it was reopened; once the user
    // sends in this thread, the live last message advances past the one
    // we opened on and the recap retires (no flash, no wasted call).
    lastMessageId === openedOnMessageId &&
    lastMessageRole === "assistant" &&
    messageCount >= RECAP_MIN_MESSAGE_COUNT &&
    isStale;

  const { data, isFetching } = useQuery(
    chatThreadRecapOptions({
      activeOrganizationId,
      enabled: eligible,
      lastMessageId: lastMessageId ?? "",
      threadRef,
    }),
  );

  if (!eligible) {
    return null;
  }

  if (data?.recap) {
    return (
      <div className="text-muted-foreground flex items-start gap-2 px-1 text-sm italic">
        <ClockIcon aria-hidden className="mt-[0.2rem] size-3.5 shrink-0" />
        <p>{data.recap}</p>
      </div>
    );
  }

  if (isFetching) {
    return (
      <div className="text-muted-foreground/70 flex animate-pulse items-center gap-2 px-1 text-sm italic">
        <ClockIcon aria-hidden className="size-3.5 shrink-0" />
        <span>{t("chat.recapLoading")}</span>
      </div>
    );
  }

  return null;
};
