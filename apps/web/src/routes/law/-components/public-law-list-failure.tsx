import type { ReactNode } from "react";

import { CatchBoundary } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { RefreshCwIcon } from "@stll/ui/icons";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { reportErrorOnce } from "@/lib/analytics/reported-error";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { publicLawFailureDisposition } from "@/lib/public-law-api";
import type { QueryView } from "@/lib/query-view.logic";

type PublicLawResultsBoundaryProps = {
  children: ReactNode;
  searchKey: string;
  resetOn: unknown;
};

// The boundary resets when a new response arrives. Responses are objects,
// so each distinct one gets its own number; the reset key must be primitive.
const responseKeys = new WeakMap<object, number>();
const responseKeyCounter = { next: 0 };
const resetKeyOf = (value: unknown): string | number => {
  if (typeof value !== "object" || value === null) {
    return String(value);
  }
  const known = responseKeys.get(value);
  if (known !== undefined) {
    return known;
  }
  responseKeyCounter.next += 1;
  responseKeys.set(value, responseKeyCounter.next);
  return responseKeyCounter.next;
};

/** A row failure cannot remove the search controls that can recover it. */
export const PublicLawResultsBoundary = ({
  children,
  searchKey,
  resetOn,
}: PublicLawResultsBoundaryProps) => (
  <CatchBoundary
    key={searchKey}
    getResetKey={() => resetKeyOf(resetOn)}
    errorComponent={PublicLawListFailure}
  >
    {children}
  </CatchBoundary>
);

type PublicLawListFailureProps = ErrorComponentProps & {
  description?: ReactNode;
};

export function PublicLawListFailure({
  error,
  reset,
  description,
}: PublicLawListFailureProps) {
  const t = useTranslations();
  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    if (error === null || error === undefined) {
      return;
    }
    reportErrorOnce(error, (caught) => {
      analytics.captureError(caught, {
        fingerprintKey: "PublicLawListFailure:failure",
        scope: { type: "handler", handlerId: "PublicLawListFailure:failure" },
      });
    });
  }, [analytics, error]);
  const disposition =
    error === null ? "retryable" : publicLawFailureDisposition(error);
  const fallback =
    disposition === "retryable"
      ? t("caseLaw.searchUnavailable.title")
      : t("common.somethingWentWrong");

  return (
    <RecoverableErrorStatus
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
      message={
        <>
          <span>
            {disposition === "retryable"
              ? fallback
              : userErrorFromThrown(error, fallback)}
          </span>
          {disposition === "retryable" && description !== undefined && (
            <span className="text-foreground-strong-muted mt-1 block text-xs">
              {description}
            </span>
          )}
        </>
      }
      messageClassName="text-sm"
      actions={
        disposition === "rejected" ? null : (
          <Button onClick={reset} size="sm" variant="secondary">
            <RefreshCwIcon />
            {t("common.retry")}
          </Button>
        )
      }
    />
  );
}

/** Both list readers share the API failure disposition, including failed refreshes. */
export function PublicLawQueryFeedback<TData, TError>({
  view,
}: {
  view: QueryView<TData, TError>;
}) {
  if (view.type === "error") {
    return (
      <PublicLawListFailure
        error={view.error}
        reset={() => detached(view.retry(), "public-law.query-retry")}
      />
    );
  }
  if (view.type === "items" && view.refetchError !== undefined) {
    return (
      <PublicLawListFailure
        error={view.refetchError}
        reset={() => detached(view.retry(), "public-law.query-retry")}
      />
    );
  }
  return <QueryViewFeedback view={view} />;
}
