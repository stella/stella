import { useState, useTransition } from "react";

import { CancelledError, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { CopyIcon, MailIcon, RefreshCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { MattersNavIcon } from "@/components/matter-icon";
import {
  buildErrorReportMailto,
  isNetworkError,
  recoverRouteError,
  resolveRouteErrorRecovery,
  resolveRouteErrorSupport,
} from "@/components/route-components.logic";
import { StellaMark } from "@/components/stella-mark";
import { env } from "@/env";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useSignOut } from "@/hooks/use-sign-out";
import { createErrorReference } from "@/lib/analytics/error-reference";
import type { ErrorReference } from "@/lib/analytics/error-reference";
import { useAnalytics } from "@/lib/analytics/provider";
import { useRouteErrorLifecycle } from "@/lib/analytics/route-error-lifecycle-context";
import { detached } from "@/lib/detached";
import { isMemberError, isUnauthorizedError } from "@/lib/errors/auth";
import { sanitizeHref } from "@/lib/sanitize-href";

type DefaultErrorComponentProps = ErrorComponentProps & {
  className?: string;
};

/** Max number of automatic recovery attempts before
 *  falling back to the manual "Try again" button.
 *  Module-scoped so the counter survives error boundary
 *  remounts (which re-create the component instance). */
const AUTO_RETRY_LIMIT = 5;
const AUTO_RETRY_DELAY_MS = 3000;
const PENDING_ERROR_REFERENCE = "—";
let networkRetryCount = 0;

type UseNetworkRetryOptions = {
  networkError: boolean;
  retry: () => void;
};

type UseNetworkRetryResult = {
  isAutoRetrying: boolean;
  retriesExhausted: boolean;
};

/** Drive the auto-retry lifecycle for transient network errors.
 *  - Resets the module-scoped counter when the error is cleared
 *    or the component unmounts (i.e. recovery succeeded).
 *  - Schedules a single delayed retry per render where the error
 *    is still network-shaped and the counter is below the limit.
 *  - Cleans up the pending timer on unmount or when the network
 *    flag flips, so a stale retry never fires after recovery. */
const useNetworkRetry = ({
  networkError,
  retry,
}: UseNetworkRetryOptions): UseNetworkRetryResult => {
  const [isAutoRetrying, setIsAutoRetrying] = useState(
    () => networkError && networkRetryCount < AUTO_RETRY_LIMIT,
  );

  useExternalSyncEffect(() => {
    if (!networkError) {
      networkRetryCount = 0;
      setIsAutoRetrying(false);
      return undefined;
    }

    if (networkRetryCount >= AUTO_RETRY_LIMIT) {
      setIsAutoRetrying(false);
      return undefined;
    }

    networkRetryCount += 1;
    setIsAutoRetrying(true);
    const timer = setTimeout(retry, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [networkError, retry]);

  useMountEffect(() => () => {
    networkRetryCount = 0;
  });

  return {
    isAutoRetrying,
    retriesExhausted: networkError && networkRetryCount >= AUTO_RETRY_LIMIT,
  };
};

export const DefaultErrorComponent = ({
  error,
  reset,
  className,
}: DefaultErrorComponentProps) => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();
  const isCancelledError = error instanceof CancelledError;
  const showUnauthorizedError =
    isUnauthorizedError(error) || isMemberError(error);
  const networkError = isNetworkError(error);

  const retryErroredQueries = () => {
    startTransition(async () => {
      await queryClient
        .refetchQueries({
          predicate: (query) =>
            query.state.fetchStatus === "idle" &&
            query.state.status === "error",
        })
        .catch((refetchError: unknown) => {
          analytics.captureError(refetchError);
        });

      reset();
      // Don't reset networkRetryCount here. If the error
      // persists, the error boundary re-catches and the
      // counter keeps accumulating toward AUTO_RETRY_LIMIT.
      // The counter resets when a non-network error occurs
      // or when recovery succeeds (component unmounts).
    });
  };

  const { isAutoRetrying, retriesExhausted: retriesAtLimit } = useNetworkRetry({
    networkError,
    retry: retryErroredQueries,
  });

  // Capture exhausted network failures. Unexpected errors are captured by
  // their recovery panel so the visible support reference can be attached.
  useExternalSyncEffect(() => {
    if (showUnauthorizedError || isCancelledError || !networkError) {
      return;
    }

    if (retriesAtLimit) {
      analytics.captureError(error);
    }
  }, [
    error,
    analytics,
    showUnauthorizedError,
    networkError,
    isCancelledError,
    retriesAtLimit,
  ]);

  const t = useTranslations();

  // CancelledError is benign — React Query throws it when a
  // suspense query unmounts during route transitions or when
  // sidebar preloads race with the current route. Return early
  // to avoid showing the error screen; the route will recover
  // on the next render cycle.
  if (isCancelledError) {
    return null;
  }

  if (showUnauthorizedError) {
    return <UnauthorizedError />;
  }

  // Network error: show "Connection lost" with reconnecting
  // indicator instead of generic "Something went wrong".
  if (networkError) {
    const retriesExhausted = retriesAtLimit && !isPending;

    return (
      <StatusMessage
        actionButton={
          retriesExhausted ? (
            <Button disabled={isPending} onClick={retryErroredQueries}>
              <RefreshCcwIcon /> {t("common.tryAgain")}
            </Button>
          ) : null
        }
        className={className}
        description={
          !retriesExhausted && (isAutoRetrying || isPending)
            ? t("common.reconnecting")
            : t("common.connectionLostDescription")
        }
        status="error"
        title={t("common.connectionLost")}
      />
    );
  }

  return (
    <UnexpectedRouteError
      className={className}
      error={error}
      isPending={isPending}
      retry={retryErroredQueries}
    />
  );
};

type UnexpectedRouteErrorProps = {
  className?: string | undefined;
  error: unknown;
  isPending: boolean;
  retry: () => void;
};

const focusHeading = (heading: HTMLHeadingElement | null) => {
  heading?.focus();
};

const UnexpectedRouteError = ({
  className,
  error: routeError,
  isPending,
  retry,
}: UnexpectedRouteErrorProps) => {
  const analytics = useAnalytics();
  const routeErrorLifecycle = useRouteErrorLifecycle();
  const t = useTranslations();
  const [errorReference, setErrorReference] = useState<ErrorReference | null>(
    null,
  );
  const visibleErrorReference = errorReference ?? PENDING_ERROR_REFERENCE;
  const recovery = resolveRouteErrorRecovery(routeError);
  const support = resolveRouteErrorSupport({
    deployment: env.VITE_SELFHOST ? "selfHosted" : "hosted",
    feedbackRecipient: env.VITE_FEEDBACK_EMAIL_TO,
  });
  let description: string;
  switch (support.type) {
    case "report":
      description = t("routeError.descriptionReport");
      break;
    case "administrator":
      description = t("routeError.descriptionAdministrator");
      break;
    case "none":
      description = t("routeError.descriptionNone");
      break;
    default: {
      support satisfies never;
      description = panic(`Unhandled support: ${String(support)}`);
    }
  }

  useMountEffect(() => {
    setErrorReference(createErrorReference());
  });

  useExternalSyncEffect(() => {
    if (errorReference === null) {
      return;
    }
    routeErrorLifecycle.shown({
      error: routeError,
      recovery: recovery.type,
      reference: errorReference,
    });
  }, [routeErrorLifecycle, routeError, errorReference, recovery.type]);

  const handleCopyReference = async () => {
    if (errorReference === null) {
      return;
    }
    const copied = await copyToClipboard(errorReference);
    if (Result.isError(copied)) {
      analytics.captureError(copied.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("common.copied"), type: "success" });
  };

  const reportHref =
    support.type === "report" && errorReference !== null
      ? buildErrorReportMailto({
          recipient: support.recipient,
          subject: t("routeError.reportSubject", {
            reference: errorReference,
          }),
          body: t("routeError.reportBody", {
            reference: errorReference,
          }),
        })
      : null;

  const handleRecovery = () => {
    if (errorReference === null) {
      return;
    }
    detached(
      recoverRouteError({
        error: routeError,
        recordRetryStarted: async (recoveryType) =>
          routeErrorLifecycle.retryStarted(errorReference, recoveryType),
        reloadPage: () => window.location.reload(),
        retryRoute: retry,
      }),
      "route-error.recover",
    );
  };

  return (
    <div
      className={cn(
        "error-gradient flex h-full w-full items-center overflow-auto px-6 py-10 sm:px-10",
        className,
      )}
    >
      <style>{`
        .error-gradient {
          background: linear-gradient(
            to bottom,
            var(--background) 40%,
            var(--error-gradient-end)
          );
        }
        :root { --error-gradient-end: #fbe9e4; }
        .dark { --error-gradient-end: #261815; }
      `}</style>
      <section
        aria-labelledby="route-error-title"
        className="mx-auto flex w-full max-w-xl flex-col gap-6"
        role="alert"
      >
        <div className="flex flex-col gap-2">
          <h1
            className="text-foreground text-xl font-semibold text-balance outline-none"
            id="route-error-title"
            ref={focusHeading}
            tabIndex={-1}
          >
            {t("routeError.title")}
          </h1>
          <p className="text-muted-foreground max-w-lg text-sm leading-6 text-pretty">
            {description}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={errorReference === null}
            loading={isPending}
            onClick={handleRecovery}
          >
            <RefreshCcwIcon /> {t("common.tryAgain")}
          </Button>
          <Button render={<Link from="/" to="/workspaces" />} variant="outline">
            <MattersNavIcon /> {t("routeError.backToMatters")}
          </Button>
          {reportHref ? (
            <Button
              render={
                <a
                  aria-label={t("routeError.reportProblem")}
                  href={sanitizeHref(reportHref)}
                />
              }
              variant="ghost"
            >
              <MailIcon /> {t("routeError.reportProblem")}
            </Button>
          ) : null}
        </div>

        <div className="border-border bg-muted/40 flex items-center justify-between gap-3 rounded-xl border p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">
              {t("routeError.reference")}
            </span>
            <bdi className="text-foreground truncate font-mono text-sm">
              {visibleErrorReference}
            </bdi>
          </div>
          <Button
            aria-label={t("routeError.copyReference")}
            disabled={errorReference === null}
            onClick={() => {
              detached(handleCopyReference(), "route-error.copy-reference");
            }}
            size="icon"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        </div>
      </section>
    </div>
  );
};

const UnauthorizedError = () => {
  const { mutate } = useSignOut();
  const signOut = useLatestCallback(mutate);

  useMountEffect(() => {
    signOut();
  });

  return null;
};

export type StatusMessageProps = {
  status: "success" | "error";
  title: string;
  description?: string;
  actionButton?: React.ReactNode;
  className?: string | undefined;
};

export const StatusMessage = ({
  status,
  title,
  description,
  actionButton,
  className,
}: StatusMessageProps) => (
  <div
    className={cn(
      "mx-auto flex h-full w-full max-w-md flex-col items-center justify-center gap-y-6 p-6 text-center",
      className,
    )}
  >
    <StellaMark
      className={cn(
        "size-10",
        status === "error"
          ? "text-foreground-disabled"
          : "text-foreground-muted",
      )}
    />
    <div className="flex flex-col items-center gap-y-1.5">
      <h1 className="text-foreground text-lg font-medium">{title}</h1>
      {description && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
    </div>
    {actionButton}
  </div>
);

type DefaultPendingComponentProps = {
  className?: string | undefined;
};

// The router's pending fallback renders before the intl provider exists (it
// covers the root route's own load), so it cannot read a translation: the
// label is a constant.
const PENDING_LABEL = "Loading";

export const DefaultPendingComponent = ({
  className,
}: DefaultPendingComponentProps) => (
  <div
    className={cn("flex h-full w-full items-center justify-center", className)}
  >
    <Loader label={PENDING_LABEL} size="lg" />
  </div>
);

export const DefaultNotFoundComponent = () => <Navigate to="/workspaces" />;
