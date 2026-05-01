import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  useTransition,
} from "react";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";
import { CancelledError, useQueryClient } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { RefreshCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { StellaMark } from "@/components/stella-mark";
import { useSignOut } from "@/hooks/use-sign-out";
import { useAnalytics } from "@/lib/analytics/provider";
import { isMemberError, isUnauthorizedError } from "@/lib/errors";

type DefaultErrorComponentProps = ErrorComponentProps & {
  className?: string;
};

/** Network errors that indicate a transient connectivity
 *  issue (API down, DNS failure, etc.).
 *  Message varies by browser engine:
 *  - Chromium: "Failed to fetch"
 *  - Firefox:  "NetworkError when attempting to fetch resource."
 *  - Safari:   "Load failed" */
const NETWORK_ERROR_MESSAGES = new Set([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
]);

const isNetworkError = (error: unknown): boolean =>
  error instanceof TypeError && NETWORK_ERROR_MESSAGES.has(error.message);

/** Max number of automatic recovery attempts before
 *  falling back to the manual "Try again" button.
 *  Module-scoped so the counter survives error boundary
 *  remounts (which re-create the component instance). */
const AUTO_RETRY_LIMIT = 5;
const AUTO_RETRY_DELAY_MS = 3000;
let networkRetryCount = 0;

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
  const [isAutoRetrying, setIsAutoRetrying] = useState(
    () => networkError && networkRetryCount < AUTO_RETRY_LIMIT,
  );

  const retryErroredQueries = useCallback(() => {
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

      setIsAutoRetrying(false);
      reset();
      // Don't reset networkRetryCount here. If the error
      // persists, the error boundary re-catches and the
      // counter keeps accumulating toward AUTO_RETRY_LIMIT.
      // The counter resets when a non-network error occurs
      // or when recovery succeeds (component unmounts).
    });
  }, [queryClient, analytics, reset]);

  // Reset the retry counter when the component unmounts
  // (successful recovery) or when the error is no longer
  // a network error.
  useEffect(() => {
    if (!networkError) {
      networkRetryCount = 0;
    }
    return () => {
      networkRetryCount = 0;
    };
  }, [networkError]);

  useEffect(() => {
    if (showUnauthorizedError || networkError || isCancelledError) {
      return;
    }

    analytics.captureError(error);
  }, [error, analytics, showUnauthorizedError, networkError, isCancelledError]);

  // Capture network errors only once retries are exhausted,
  // avoiding inflated error counts during transient outages.
  useEffect(() => {
    if (networkError && networkRetryCount >= AUTO_RETRY_LIMIT) {
      analytics.captureError(error);
    }
  }, [networkError, error, analytics]);

  // Auto-retry on transient network errors.
  useEffect(() => {
    if (!networkError || networkRetryCount >= AUTO_RETRY_LIMIT) {
      setIsAutoRetrying(false);
      return undefined;
    }
    networkRetryCount += 1;
    setIsAutoRetrying(true);
    const timer = setTimeout(retryErroredQueries, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [networkError, retryErroredQueries]);

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
    const retriesExhausted =
      networkRetryCount >= AUTO_RETRY_LIMIT && !isPending;

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
    <StatusMessage
      actionButton={
        <Button disabled={isPending} onClick={retryErroredQueries}>
          <RefreshCcwIcon /> {t("common.tryAgain")}
        </Button>
      }
      className={className}
      description={t("common.unexpectedError")}
      status="error"
      title={t("common.somethingWentWrong")}
    />
  );
};

const UnauthorizedError = () => {
  const { mutate } = useSignOut();
  const signOut = useEffectEvent(mutate);

  useEffect(() => {
    signOut();
  }, []);

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
      "mx-auto flex h-full w-screen max-w-md flex-col items-center justify-center gap-y-6 p-6 text-center",
      className,
    )}
  >
    <StellaMark
      className={cn(
        "size-10",
        status === "error"
          ? "text-muted-foreground/40"
          : "text-muted-foreground/60",
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

export const DefaultPendingComponent = ({
  className,
}: DefaultPendingComponentProps) => (
  <div
    className={cn("flex h-full w-full items-center justify-center", className)}
  >
    <StellaMark className="text-muted-foreground size-8 animate-pulse" />
  </div>
);

export const DefaultNotFoundComponent = () => <Navigate to="/workspaces" />;
