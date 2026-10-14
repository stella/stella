import type { ReactNode } from "react";

import type { UseQueryResult } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { detached } from "@/lib/detached";

type TextFileQueryStateProps<T> = {
  textQuery: UseQueryResult<T>;
  children: (data: T) => ReactNode;
};

/**
 * Loading and retryable error states for a viewer that reads a file's
 * decoded text. Plain text and Markdown share it so the two cannot drift.
 */
export const TextFileQueryState = <T,>({
  textQuery,
  children,
}: TextFileQueryStateProps<T>) => {
  const t = useTranslations();
  if (textQuery.isPending) {
    return (
      <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-sm">
        {t("common.loading")}
      </div>
    );
  }
  if (textQuery.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground max-w-sm text-sm">
          {textQuery.error.message || t("errors.actionFailed")}
        </p>
        <Button
          onClick={() => {
            detached(textQuery.refetch(), "text-file-query-state.refetch");
          }}
          size="xs"
          variant="secondary"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  return children(textQuery.data);
};
