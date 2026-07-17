/**
 * AcceptAllButton — the single owner of the "accept all" affordance,
 * shared by the inspector ReviewPanel footer and the floating
 * ReviewBar so the confirm-threshold behaviour can never drift.
 *
 * Up to {@link ACCEPT_ALL_CONFIRM_THRESHOLD} pending suggestions is a
 * one-click accept. Above it, a confirm dialog summarising the counts
 * by severity gates the batch, since applying dozens of tracked
 * changes at once is not casually undoable.
 */

import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { CheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPanel,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";

import type {
  ReviewSeverityKey,
  ReviewSuggestion,
} from "@/components/ai-suggestions/review-store";
import type { TranslationKey } from "@/i18n/types";

/** Above this many pending suggestions, "accept all" asks to confirm first. */
export const ACCEPT_ALL_CONFIRM_THRESHOLD = 10;

const SEVERITY_COUNT_KEYS = {
  high: "docxReview.countHigh",
  medium: "docxReview.countMedium",
  low: "docxReview.countLow",
  unspecified: "docxReview.countUnspecified",
} as const satisfies Record<ReviewSeverityKey, TranslationKey>;

const SEVERITY_ORDER: readonly ReviewSeverityKey[] = [
  "high",
  "medium",
  "low",
  "unspecified",
];

type ButtonProps = ComponentProps<typeof Button>;

type AcceptAllButtonProps = {
  /** The pending suggestions this control would accept. */
  pendingItems: readonly ReviewSuggestion[];
  onAcceptAll: (items: readonly ReviewSuggestion[]) => void | Promise<void>;
  className?: string | undefined;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  children: ReactNode;
};

export const AcceptAllButton = ({
  pendingItems,
  onAcceptAll,
  className,
  size = "sm",
  variant = "default",
  children,
}: AcceptAllButtonProps) => {
  const t = useTranslations();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runAccept = () => {
    void onAcceptAll(pendingItems);
  };

  const handleClick = () => {
    if (pendingItems.length > ACCEPT_ALL_CONFIRM_THRESHOLD) {
      setConfirmOpen(true);
      return;
    }
    runAccept();
  };

  const breakdown = SEVERITY_ORDER.flatMap((severity) => {
    const count = pendingItems.filter(
      (item) => item.severity === severity,
    ).length;
    if (count === 0) {
      return [];
    }
    return [t(SEVERITY_COUNT_KEYS[severity], { count: String(count) })];
  });

  return (
    <>
      <Button
        className={className}
        disabled={pendingItems.length === 0}
        onClick={handleClick}
        size={size}
        variant={variant}
      >
        <CheckIcon className="me-1 size-3.5" />
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
                count: String(pendingItems.length),
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
              onClick={() => {
                setConfirmOpen(false);
                runAccept();
              }}
              size="sm"
              variant="default"
            >
              <CheckIcon className="me-1 size-3.5" />
              {t("docxReview.acceptAll")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
