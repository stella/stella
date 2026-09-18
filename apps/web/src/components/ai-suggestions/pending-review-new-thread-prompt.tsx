import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { PopoverDescription } from "@stll/ui/popover";

export const PENDING_REVIEW_PROMPT_STATUS = {
  choosing: "choosing",
  dismissing: "dismissing",
} as const;

type PendingReviewPromptStatus =
  (typeof PENDING_REVIEW_PROMPT_STATUS)[keyof typeof PENDING_REVIEW_PROMPT_STATUS];

type PendingReviewNewThreadPromptProps = {
  pendingCount: number;
  status: PendingReviewPromptStatus;
  onKeep: () => void;
  onDismiss: () => void;
};

/**
 * The choice shown before a new chat thread starts while the document still
 * has suggestions awaiting review.
 */
export const PendingReviewNewThreadPrompt = ({
  pendingCount,
  status,
  onKeep,
  onDismiss,
}: PendingReviewNewThreadPromptProps) => {
  const t = useTranslations();
  const dismissing = status === PENDING_REVIEW_PROMPT_STATUS.dismissing;
  return (
    <>
      <PopoverDescription className="text-foreground text-pretty">
        {t("docxReview.finalizePendingNote", { count: pendingCount })}
      </PopoverDescription>
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          disabled={dismissing}
          onClick={onKeep}
          size="sm"
          variant="ghost"
        >
          {t("docxReview.keepInReview")}
        </Button>
        <Button
          loading={dismissing}
          onClick={onDismiss}
          size="sm"
          variant="destructive-outline"
        >
          {t("common.dismiss")}
        </Button>
      </div>
    </>
  );
};
