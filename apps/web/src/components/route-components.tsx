import { useCallback, useEffect, useEffectEvent, useTransition } from "react";
import { usePostHog } from "@posthog/react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, type ErrorComponentProps } from "@tanstack/react-router";
import { RefreshCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { cn } from "@stella/ui/lib/utils";

import { StellaMark } from "@/components/stella-mark";
import { useSignOut } from "@/hooks/use-sign-out";
import { isMemberError, isUnauthorizedError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";

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
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();
  const showUnauthorizedError =
    isUnauthorizedError(error) || isMemberError(error);

  const retryErroredQueries = useCallback(() => {
    startTransition(async () => {
      await queryClient
        .refetchQueries({
          predicate: (query) =>
            query.state.fetchStatus === "idle" &&
            query.state.status === "error",
        })
        .catch((e) => {
          captureError(posthog, e);
        });

      networkRetryCount = 0;
      reset();
    });
  }, [queryClient, posthog, reset]);

  useEffect(() => {
    if (showUnauthorizedError) {
      return;
    }

    captureError(posthog, error);
  }, [error, posthog, showUnauthorizedError]);

  // Auto-retry on transient network errors.
  useEffect(() => {
    if (!isNetworkError(error) || networkRetryCount >= AUTO_RETRY_LIMIT) {
      return;
    }
    networkRetryCount += 1;
    const timer = setTimeout(retryErroredQueries, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [error, retryErroredQueries]);

  const t = useTranslations();

  if (showUnauthorizedError) {
    return <UnauthorizedError />;
  }

  // While auto-retrying, show a "Reconnecting" state
  // instead of the error message.
  if (isNetworkError(error) && isPending) {
    return <DefaultPendingComponent className={className} />;
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

export const UnauthorizedError = () => {
  const { mutate } = useSignOut();
  const signOut = useEffectEvent(mutate);

  useEffect(() => {
    signOut();
  }, []);

  return null;
};

type StatusMessageProps = {
  status: "success" | "error";
  title: string;
  description?: string;
  actionButton?: React.ReactNode;
  className?: string;
};

export const StatusMessage = ({
  status,
  title,
  description,
  actionButton,
  className,
}: StatusMessageProps) => {
  return (
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
        <h1 className="text-lg font-medium text-foreground">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actionButton}
    </div>
  );
};

type DefaultPendingComponentProps = {
  className?: string;
};

export const DefaultPendingComponent = ({
  className,
}: DefaultPendingComponentProps) => {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center bg-background",
        className,
      )}
    >
      <StellaMark className="size-8 animate-pulse text-muted-foreground" />
    </div>
  );
};

export const DefaultNotFoundComponent = () => {
  return <Navigate to={"/workspaces"} />;
};
