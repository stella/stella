import { useTranslations } from "use-intl";

import { DetailBreadcrumb } from "@/components/breadcrumbs/detail-breadcrumb";
import { useTemplateNavStore } from "@/stores/knowledge/template-nav-store";

export const TemplatesBreadcrumb = () => {
  const t = useTranslations();
  const open = useTemplateNavStore((s) => s.open);

  return (
    <DetailBreadcrumb
      label={t("navigation.templates")}
      open={open}
      to="/knowledge/templates"
    />
  );
};
