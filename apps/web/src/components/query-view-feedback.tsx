import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { detached } from "@/lib/detached";
import type { QueryView } from "@/lib/query-view.logic";

type QueryViewFeedbackProps<TData, TError> = {
  view: QueryView<TData, TError>;
};

export const QueryViewFeedback = <TData, TError>({
  view,
}: QueryViewFeedbackProps<TData, TError>) => {
  const t = useTranslations();
  switch (view.type) {
    case "pending":
      return (
        <p role="status" className="text-muted-foreground text-sm">
          {t("common.loading")}
        </p>
      );
    case "empty":
      return null;
    case "items":
      if (view.refetchError === undefined) {
        return null;
      }
      break;
    case "error":
      break;
    default:
      view satisfies never;
      return panic("Unhandled query feedback state");
  }
  return (
    <div role="alert" className="flex items-center gap-2">
      <span className="text-destructive text-sm">
        {t("common.somethingWentWrong")}
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => detached(view.retry(), "query-view-feedback.retry")}
      >
        {t("common.retry")}
      </Button>
    </div>
  );
};
