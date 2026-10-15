import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { getTranslator } from "@/i18n/translator";
import { actionAdmissionOutcome } from "@/lib/errors/action-admission";

export const ActionAdmissionOutcome = ({
  error,
  onRetry,
  disabled,
  className,
}: {
  error: unknown;
  onRetry?: (() => void) | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) => {
  const t = useTranslations();
  const outcome = actionAdmissionOutcome(error);
  if (!outcome) {
    return null;
  }
  return (
    <div
      className={cn(
        "bg-muted text-foreground flex flex-col gap-2 rounded-lg p-3 text-sm",
        className,
      )}
      role="status"
    >
      <p>{t(outcome.messageKey)}</p>
      <div className="flex flex-wrap items-center gap-2">
        {outcome.contactUrl && (
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-4"
            href={sanitizeHref(outcome.contactUrl)}
            rel="noreferrer"
            target="_blank"
          >
            {t("errors.actionAdmission.contact")}
          </a>
        )}
        {outcome.retryable && onRetry && (
          <Button
            disabled={disabled}
            onClick={onRetry}
            size="sm"
            variant="outline"
          >
            {t("common.tryAgain")}
          </Button>
        )}
      </div>
    </div>
  );
};

export const notifyActionAdmissionRefusal = (error: unknown): boolean => {
  const outcome = actionAdmissionOutcome(error);
  if (!outcome) {
    return false;
  }
  const t = getTranslator();
  stellaToast.add({
    id: outcome.code,
    title: t(outcome.messageKey),
    type: "info",
    ...(outcome.contactUrl
      ? {
          description: (
            <a
              className="underline underline-offset-4"
              href={sanitizeHref(outcome.contactUrl)}
              rel="noreferrer"
              target="_blank"
            >
              {t("errors.actionAdmission.contact")}
            </a>
          ),
        }
      : {}),
  });
  return true;
};
