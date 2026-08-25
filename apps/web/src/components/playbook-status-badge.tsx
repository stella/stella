import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";

export const PlaybookStatusBadge = ({ status }: Props) => {
  const t = useTranslations();
  const approved = status === "approved";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        approved
          ? "bg-success/15 text-success"
          : "bg-muted text-muted-foreground",
      )}
    >
      {approved
        ? t("knowledge.playbooks.approval.statusApproved")
        : t("knowledge.playbooks.approval.statusDraft")}
    </span>
  );
};

type Props = {
  status: PlaybookListItem["status"];
};
