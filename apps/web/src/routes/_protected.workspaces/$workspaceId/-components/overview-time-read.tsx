import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import type { QueryView } from "@/lib/query-view.logic";

type OverviewTimeReadProps<TData> = {
  view: QueryView<TData, unknown>;
  children: (data: TData) => ReactNode;
};

export const OverviewTimeRead = <TData,>({
  view,
  children,
}: OverviewTimeReadProps<TData>) => {
  const t = useTranslations();
  const readError = (error: unknown, retry: () => unknown) => (
    <div className="flex items-center gap-2" role="alert">
      <span className="text-destructive text-xs">
        {userErrorFromThrown(error, t("errors.actionFailed"))}
      </span>
      <Button
        onClick={() => {
          retry();
        }}
        size="xs"
        variant="ghost"
      >
        {t("common.retry")}
      </Button>
    </div>
  );
  switch (view.type) {
    case "pending":
      return (
        <span aria-label={t("common.loading")} role="status">
          <Skeleton className="h-5 w-16" />
        </span>
      );
    case "error":
      return readError(view.error, () =>
        detached(view.retry(), "overview-time-summary.retry"),
      );
    case "empty":
      return (
        <span className="text-muted-foreground text-xs">
          {t("common.noResults")}
        </span>
      );
    case "items":
      return (
        <>
          {view.refetchError !== undefined &&
            readError(view.refetchError, () =>
              detached(view.retry(), "overview-time-summary.retry"),
            )}
          {children(view.items)}
        </>
      );
    default:
      view satisfies never;
      return panic("Unhandled overview time summary state");
  }
};
