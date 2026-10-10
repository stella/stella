import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { MenuItem } from "@stll/ui/menu";

import { detached } from "@/lib/detached";
import type { useIsWorkflowRunning } from "@/lib/workspaces/queries/workspace";

type WorkflowQueryFeedbackProps = {
  view: ReturnType<typeof useIsWorkflowRunning>;
  display?: "inline" | "menu";
};

export const WorkflowQueryFeedback = ({
  view,
  display = "inline",
}: WorkflowQueryFeedbackProps) => {
  const t = useTranslations();
  switch (view.type) {
    case "pending":
    case "empty":
      return display === "menu" ? (
        <MenuItem disabled>
          <span className="text-muted-foreground text-xs">
            {t("flows.loading")}
          </span>
        </MenuItem>
      ) : (
        <span className="text-muted-foreground text-xs" role="status">
          {t("flows.loading")}
        </span>
      );
    case "items":
      if (view.refetchError === undefined) {
        return null;
      }
      break;
    case "error":
      break;
    default:
      view satisfies never;
      return panic("Unhandled workflow query state");
  }

  const retry = () => {
    detached(view.retry(), "workflow-query-feedback.retry");
  };
  if (display === "menu") {
    return (
      <MenuItem onClick={retry}>
        <span className="text-destructive text-xs">
          {t("common.somethingWentWrong")}
        </span>
        <span>{t("common.retry")}</span>
      </MenuItem>
    );
  }
  return (
    <div className="flex items-center gap-2" role="alert">
      <span className="text-destructive text-xs">
        {t("common.somethingWentWrong")}
      </span>
      <Button onClick={retry} size="xs" variant="ghost">
        {t("common.retry")}
      </Button>
    </div>
  );
};
