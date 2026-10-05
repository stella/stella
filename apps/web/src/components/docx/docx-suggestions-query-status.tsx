import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import type { QueryView } from "@/lib/query-view.logic";

const SuggestionsReadError = ({
  error,
  retry,
}: {
  error: unknown;
  retry: () => Promise<unknown>;
}) => {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-2 px-3 py-2" role="alert">
      <p className="text-destructive text-sm">
        {userErrorFromThrown(error, t("errors.actionFailed"))}
      </p>
      <Button
        onClick={() => detached(retry(), "docx-suggestions.retry")}
        size="xs"
        variant="ghost"
      >
        {t("common.retry")}
      </Button>
    </div>
  );
};

export const DocxSuggestionsQueryStatus = ({
  view,
}: {
  view: QueryView<unknown, unknown>;
}) => {
  const t = useTranslations();
  switch (view.type) {
    case "pending":
      return (
        <p className="text-muted-foreground px-3 py-2 text-sm" role="status">
          {t("common.loading")}
        </p>
      );
    case "empty":
      return null;
    case "items":
      if (view.refetchError === undefined) {
        return null;
      }
      return (
        <SuggestionsReadError error={view.refetchError} retry={view.retry} />
      );
    case "error":
      return <SuggestionsReadError error={view.error} retry={view.retry} />;
    default:
      view satisfies never;
      return panic("Unhandled DOCX suggestions query state");
  }
};
