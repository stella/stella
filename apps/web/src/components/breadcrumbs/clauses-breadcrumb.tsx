import { useTranslations } from "use-intl";

import { DetailBreadcrumb } from "@/components/breadcrumbs/detail-breadcrumb";
import { useClauseNavStore } from "@/routes/_protected.knowledge/-components/clause-nav-store";

export const ClausesBreadcrumb = () => {
  const t = useTranslations();
  const open = useClauseNavStore((s) => s.open);

  return (
    <DetailBreadcrumb
      label={t("common.clauses")}
      open={open}
      to="/knowledge/clauses"
    />
  );
};
