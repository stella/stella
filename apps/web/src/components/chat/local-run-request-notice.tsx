import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { unansweredLocalRunRequest } from "@/components/chat/local-run-request.logic";
import type { TranslationKey } from "@/i18n/types";

type UnansweredReason = NonNullable<
  ReturnType<typeof unansweredLocalRunRequest>
>;

const UNANSWERED_KEYS = {
  runFinished: "chat.localRun.request.runFinished",
  runFailed: "chat.localRun.request.runFailed",
  withdrawn: "chat.localRun.request.withdrawn",
  runLost: "chat.localRun.request.runLost",
  cancelled: "chat.localRun.request.cancelled",
} as const satisfies Record<UnansweredReason, TranslationKey>;

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
  reason: UnansweredReason;
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
