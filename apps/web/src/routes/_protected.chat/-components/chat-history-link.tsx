import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { HistoryIcon } from "@stll/ui/icons";

/** The chat header's way into the full history page. */
export const ChatHistoryLink = () => {
  const t = useTranslations();
  return (
    <Button
      aria-label={t("common.history")}
      render={<Link to="/chat/history" />}
      size="icon-sm"
      variant="ghost"
    >
      <HistoryIcon className="size-4" />
    </Button>
  );
};
