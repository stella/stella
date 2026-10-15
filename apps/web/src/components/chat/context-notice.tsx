import { useTranslations } from "use-intl";

import type { ChatMessageMetadata } from "@/components/chat/chat-ui-tools";
import type { TranslationKey } from "@/i18n/types";

type AnswerContextNotice = NonNullable<ChatMessageMetadata["contextNotice"]>;

const CONTEXT_NOTICE_KEYS = {
  "history-trimmed": "chat.historyTrimmed",
} as const satisfies Record<AnswerContextNotice["type"], TranslationKey>;

/**
 * Says what the answer's context left out: the server attaches the notice to
 * the answer while it streams and stores it with the answer, so it reads the
 * same live and after reload.
 */
export const ContextNotice = ({
  metadata,
}: {
  metadata: ChatMessageMetadata | undefined;
}) => {
  const t = useTranslations();
  const notice = metadata?.contextNotice;
  if (notice === undefined) {
    return null;
  }
  return (
    <p className="text-muted-foreground max-w-xl py-1 text-xs" role="status">
      {t(CONTEXT_NOTICE_KEYS[notice.type])}
    </p>
  );
};
