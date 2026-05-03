import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { MatterNumberingCard } from "@/routes/_protected.settings/-components/organization/matter-numbering-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute(
  "/_protected/settings/organization/matter-numbering",
)({
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
