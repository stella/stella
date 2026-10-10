import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { DecisionCitationRead } from "@/components/chat/chat-decision-citation-metadata.logic";
import { detached } from "@/lib/detached";

export const CitationReadFeedback = ({
  read,
}: {
  read: DecisionCitationRead;
}) => {
  const t = useTranslations();
  if (read.type === "source") {
    return null;
  }
  const { view } = read;
  switch (view.type) {
    case "pending":
      return (
        <span className="text-muted-foreground ms-1 text-xs" role="status">
          {t("common.loading")}
        </span>
      );
    case "empty":
      return (
        <span className="text-muted-foreground ms-1 text-xs">
          {t("common.noResults")}
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
      return panic("Unhandled citation read feedback");
  }
  return (
    <span className="text-destructive ms-1 text-xs" role="alert">
      {t("common.somethingWentWrong")}
      <Button
        size="xs"
        variant="ghost"
        onClick={() => detached(view.retry(), "chat-decision-citation.retry")}
      >
        {t("common.retry")}
      </Button>
    </span>
  );
};
