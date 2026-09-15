/**
 * AcceptAllButton — the single owner of the "accept all" affordance,
 * shared by the document-review facet's header and the floating
 * ReviewBar so the confirm-threshold behaviour can never drift.
 *
 * Up to {@link ACCEPT_ALL_CONFIRM_THRESHOLD} pending changes is a
 * one-click accept. Above it, a confirm dialog summarising the counts
 * by severity gates the batch, since applying dozens of tracked
 * changes at once is not casually undoable.
 */

import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { CheckCheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPanel,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";

import type { ReviewChange } from "@/components/ai-suggestions/review-bar.logic";
import {
  SEVERITY_ORDER,
  type ReviewSeverityKey,
} from "@/components/ai-suggestions/review-store";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";

/** Above this many pending changes, "accept all" asks to confirm first. */
export const ACCEPT_ALL_CONFIRM_THRESHOLD = 10;

const SEVERITY_COUNT_KEYS = {
  high: "docxReview.countHigh",
  medium: "docxReview.countMedium",
  low: "docxReview.countLow",
  unspecified: "docxReview.countUnspecified",
} as const satisfies Record<ReviewSeverityKey, TranslationKey>;

type ButtonProps = ComponentProps<typeof Button>;

type AcceptAllButtonProps = {
  /** The pending changes this control would accept. */
  pendingChanges: readonly ReviewChange[];
  onAcceptAll: (changes: readonly ReviewChange[]) => void | Promise<void>;
  className?: string | undefined;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  children: ReactNode;
};

export const AcceptAllButton = ({
  pendingChanges,
  onAcceptAll,
  className,
  size,
  variant,
  children,
}: AcceptAllButtonProps) => {
  const t = useTranslations();
  // Defaults live here, not as destructuring defaults: an `AssignmentPattern`
  // in the object parameter pattern trips the React Compiler's HIR lowering
  // (`BuildHIR::lowerAssignment` Todo) and bails the whole component out of
  // optimization. `?? default` is behaviorally identical for an absent prop.
  const buttonSize = size ?? "sm";
  const buttonVariant = variant ?? "default";
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Serialise acceptance: block re-invocation (double-click, or the confirm
  // action firing twice) while an accept-all is still applying, so the same
  // stale suggestion set can't be applied twice.
  const [isAccepting, setIsAccepting] = useState(false);

  // `.finally` (not try/finally): a try-without-catch trips the React
  // Compiler's HIR lowering and bails the component out of optimization.
  const runAccept = () => {
    if (isAccepting) {
      return;
    }
    setIsAccepting(true);
    detached(
      Promise.resolve(onAcceptAll(pendingChanges)).finally(() => {
        setIsAccepting(false);
      }),
      "accept-all-button.accept-all",
    );
  };

  const handleClick = () => {
    if (pendingChanges.length > ACCEPT_ALL_CONFIRM_THRESHOLD) {
      setConfirmOpen(true);
      return;
    }
    runAccept();
  };

  const breakdown = SEVERITY_ORDER.flatMap((severity) => {
    const count = pendingChanges.filter(
      (change) => change.members[0].severity === severity,
    ).length;
    if (count === 0) {
      return [];
    }
    return [t(SEVERITY_COUNT_KEYS[severity], { count })];
  });

  return (
    <>
      <Button
        aria-label={t("docxReview.acceptAll")}
        className={className}
        disabled={pendingChanges.length === 0 || isAccepting}
        onClick={handleClick}
        size={buttonSize}
        tooltip={t("docxReview.acceptAll")}
        variant={buttonVariant}
      >
        <CheckCheckIcon className="me-1 size-3.5" />
        {children}
      </Button>
      <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("docxReview.acceptAllConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("docxReview.acceptAllConfirmDescription", {
                count: String(pendingChanges.length),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogPanel>
            <ul className="flex flex-wrap gap-x-2 gap-y-1 text-sm">
              {breakdown.map((label) => (
                <li className="text-foreground font-medium" key={label}>
                  {label}
                </li>
              ))}
            </ul>
          </AlertDialogPanel>
          <AlertDialogFooter>
            <Button
              onClick={() => setConfirmOpen(false)}
              size="sm"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={isAccepting}
              onClick={() => {
                setConfirmOpen(false);
                runAccept();
              }}
              size="sm"
              variant="default"
            >
              <CheckCheckIcon className="me-1 size-3.5" />
              {t("docxReview.acceptAll")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
