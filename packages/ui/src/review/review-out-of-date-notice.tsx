import type { ReactNode } from "react";

import { Button } from "../components/button";
import { cn } from "../lib/utils";

export type ReviewOutOfDateTone = "warning" | "muted";

/**
 * One reason a review has fallen behind. Carries its own key so the list is
 * never rendered by array index: reasons come and go independently (the
 * document changed, the playbook moved on, the source was deleted) and each
 * one has a stable identity at its call site.
 */
export type ReviewOutOfDateReason = {
  id: string;
  label: ReactNode;
};

type ReviewOutOfDateNoticeProps = {
  reasons: readonly ReviewOutOfDateReason[];
  actionLabel?: ReactNode;
  onAction?: (() => void) | undefined;
  /** The action is running: its button shows it and takes no second press. */
  actionPending?: boolean;
  /** The action is not available now. */
  actionDisabled?: boolean;
  /** Why the action is not available now, shown on hover over it. */
  actionDisabledReason?: ReactNode;
  tone?: ReviewOutOfDateTone;
  className?: string;
};

/**
 * What a review no longer reflects. Every applicable reason is listed
 * together: they are different reasons to run again, and a reviewer working
 * through findings should see each one rather than the first.
 */
export const ReviewOutOfDateNotice = ({
  reasons,
  actionLabel,
  onAction,
  actionPending = false,
  actionDisabled = false,
  actionDisabledReason,
  tone = "warning",
  className,
}: ReviewOutOfDateNoticeProps) => {
  if (reasons.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "mb-2 rounded-lg border px-3 py-2",
        TONE_CLASS[tone],
        className,
      )}
      data-slot="review-out-of-date-notice"
    >
      <ul className="space-y-1 text-xs">
        {reasons.map((reason) => (
          <li key={reason.id}>{reason.label}</li>
        ))}
      </ul>
      {onAction === undefined ? null : (
        <Button
          className="mt-2"
          disabled={actionDisabled}
          loading={actionPending}
          onClick={onAction}
          size="xs"
          // A disabled button with a reason stays hoverable and focusable,
          // so it can say why.
          tooltip={actionDisabled ? actionDisabledReason : undefined}
          variant="outline"
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
};

const TONE_CLASS = {
  warning: "border-warning/30 bg-warning/10 text-warning-foreground",
  muted: "border-border bg-muted/50 text-muted-foreground",
} as const satisfies Record<ReviewOutOfDateTone, string>;
