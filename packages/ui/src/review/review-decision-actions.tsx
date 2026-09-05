import type { ReactNode } from "react";

import { panic } from "better-result";
import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "../components/button";
import { cn } from "../lib/utils";

/**
 * Where a reviewable item stands. Undecided items offer accept/reject;
 * decided ones offer the way back (revert the applied change, or reopen the
 * decision). `applying` is undecided but in flight: the same pair, inert,
 * so the row does not resize while the write lands.
 */
export type ReviewDecisionState =
  | "pending"
  | "accepted"
  | "rejected"
  | "dismissed"
  | "applying";

export type ReviewDecisionSize = "xs" | "sm";

type ReviewDecisionActionsProps = {
  state: ReviewDecisionState;
  onAccept?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  onRevert?: (() => void) | undefined;
  onReopen?: (() => void) | undefined;
  size?: ReviewDecisionSize;
  /** Labels are supplied by the host: this package carries no catalogs. */
  acceptLabel?: ReactNode;
  rejectLabel?: ReactNode;
  revertLabel?: ReactNode;
  /** Accessible name for the icon-only reopen control. */
  reopenLabel?: string | undefined;
  acceptTooltip?: ReactNode;
  rejectTooltip?: ReactNode;
  disabled?: boolean;
  className?: string;
};

/** Accept / reject / revert / reopen, in one shape, for every review surface. */
export const ReviewDecisionActions = ({
  state,
  onAccept,
  onReject,
  onRevert,
  onReopen,
  size = "sm",
  acceptLabel,
  rejectLabel,
  revertLabel,
  reopenLabel,
  acceptTooltip,
  rejectTooltip,
  disabled = false,
  className,
}: ReviewDecisionActionsProps) => {
  const controls = renderControls({
    acceptLabel,
    acceptTooltip,
    disabled,
    onAccept,
    onReject,
    onReopen,
    onRevert,
    rejectLabel,
    rejectTooltip,
    reopenLabel,
    revertLabel,
    size,
    state,
  });
  if (controls === null) {
    return null;
  }

  return (
    <div
      className={cn("flex items-center gap-1.5", className)}
      data-slot="review-decision-actions"
    >
      {controls}
    </div>
  );
};

type RenderControlsOptions = Required<
  Pick<ReviewDecisionActionsProps, "disabled" | "size" | "state">
> &
  Omit<ReviewDecisionActionsProps, "className" | "disabled" | "size" | "state">;

const renderControls = ({
  acceptLabel,
  acceptTooltip,
  disabled,
  onAccept,
  onReject,
  onReopen,
  onRevert,
  rejectLabel,
  rejectTooltip,
  reopenLabel,
  revertLabel,
  size,
  state,
}: RenderControlsOptions): ReactNode => {
  switch (state) {
    case "pending":
    case "applying": {
      const inert = disabled || state === "applying";
      return (
        <>
          {onAccept === undefined ? null : (
            <Button
              disabled={inert}
              onClick={onAccept}
              size={size}
              tooltip={acceptTooltip}
              variant="default"
            >
              <CheckIcon />
              {acceptLabel}
            </Button>
          )}
          {onReject === undefined ? null : (
            <Button
              disabled={inert}
              onClick={onReject}
              size={size}
              tooltip={rejectTooltip}
              variant="outline"
            >
              <XIcon />
              {rejectLabel}
            </Button>
          )}
        </>
      );
    }
    case "accepted":
    case "rejected":
    case "dismissed":
      if (onRevert === undefined && onReopen === undefined) {
        return null;
      }
      return (
        <>
          {onRevert === undefined ? null : (
            <Button
              className="text-muted-foreground hover:text-foreground"
              disabled={disabled}
              onClick={onRevert}
              size={size}
              variant="ghost"
            >
              {revertLabel}
            </Button>
          )}
          {onReopen === undefined ? null : (
            <Button
              aria-label={reopenLabel}
              disabled={disabled}
              onClick={onReopen}
              size={size === "xs" ? "icon-xs" : "icon-sm"}
              variant="ghost"
            >
              <RotateCcwIcon />
            </Button>
          )}
        </>
      );
    default:
      state satisfies never;
      return panic(`Unhandled state: ${String(state)}`);
  }
};
