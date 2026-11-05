import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { pageTitle } from "@/lib/page-title";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { MatterNumberingCard } from "@/routes/_protected.settings/organization/-components/organization/matter-numbering-card";

export const Route = createFileRoute(
  "/_protected/settings/organization/matter-numbering",
)({
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.organization.matterNumbering",
      to: "/settings/organization/matter-numbering",
    }),
  },
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
