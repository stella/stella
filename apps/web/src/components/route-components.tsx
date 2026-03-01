import { useEffect, useEffectEvent, useTransition } from "react";
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

  useEffect(() => {
    if (showUnauthorizedError) {
      return;
    }

    captureError(posthog, error);
  }, [error, posthog, showUnauthorizedError]);

  const t = useTranslations();

  if (showUnauthorizedError) {
    return <UnauthorizedError />;
  }

  return (
    <StatusMessage
      actionButton={
        <Button
          disabled={isPending}
          onClick={() => {
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

              reset();
            });
          }}
        >
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
