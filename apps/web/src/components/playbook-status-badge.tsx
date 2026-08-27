import { useTranslations } from "use-intl";

import { ReviewStatusBadge } from "@stll/ui/review/review-status-badge";

import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";

export const PlaybookStatusBadge = ({ status }: Props) => {
  const t = useTranslations();
  const approved = status === "approved";
  return (
    <ReviewStatusBadge
      size="sm"
      tone={approved ? "success" : "neutral"}
      variant="solid"
    >
      {approved
        ? t("knowledge.playbooks.approval.statusApproved")
        : t("knowledge.playbooks.approval.statusDraft")}
    </ReviewStatusBadge>
  );
};

type Props = {
  status: PlaybookListItem["status"];
};
