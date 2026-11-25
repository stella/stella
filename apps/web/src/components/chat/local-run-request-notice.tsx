import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { LocalRunRequestUnanswered } from "@stll/api-contract/chat-local-run-request";

import type { TranslationKey } from "@/i18n/types";

const UNANSWERED_KEYS = {
  runFinished: "chat.localRun.request.runFinished",
  runFailed: "chat.localRun.request.runFailed",
  withdrawn: "chat.localRun.request.withdrawn",
  runLost: "chat.localRun.request.runLost",
  cancelled: "chat.localRun.request.cancelled",
} as const satisfies Record<LocalRunRequestUnanswered, TranslationKey>;

/**
 * A step the run on the member's computer asked about and went on without:
 * the step as it stands, and why nobody needs to answer it any more, said
 * neutrally. The run's output beside it is the answer.
 */
export const LocalRunRequestNotice = ({
  card,
  reason,
}: {
  card: ReactNode;
  reason: LocalRunRequestUnanswered;
}) => {
  const t = useTranslations();
  return (
    <div>
      {card}
      <p className="text-muted-foreground max-w-xl py-1 text-xs" role="status">
        {t(UNANSWERED_KEYS[reason])}
      </p>
    </div>
  );
};
