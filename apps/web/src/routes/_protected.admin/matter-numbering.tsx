import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { pageTitle } from "@/lib/page-title";
import { MatterNumberingCard } from "@/routes/_protected.admin/-components/organization/matter-numbering-card";

export const Route = createFileRoute("/_protected/admin/matter-numbering")({
  head: () => ({
    meta: [{ title: pageTitle("settings.organization.matterNumbering") }],
  }),
  component: MatterNumberingPage,
});

function MatterNumberingPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.matterNumberingDescription")}
        title={t("settings.organization.matterNumbering")}
      />
      <MatterNumberingCard />
    </>
  );
}
