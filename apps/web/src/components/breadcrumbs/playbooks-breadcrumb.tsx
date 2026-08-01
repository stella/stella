import { useTranslations } from "use-intl";

import { DetailBreadcrumb } from "@/components/breadcrumbs/detail-breadcrumb";
import { usePlaybookNavStore } from "@/stores/knowledge/playbook-nav-store";

export const PlaybooksBreadcrumb = () => {
  const t = useTranslations();
  const open = usePlaybookNavStore((s) => s.open);

  return (
    <DetailBreadcrumb
      label={t("common.playbooks")}
      open={open}
      to="/knowledge/playbooks"
    />
  );
};
