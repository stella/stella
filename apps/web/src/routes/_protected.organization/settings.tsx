import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { AIConfigSection } from "@/routes/_protected.organization/-ai-config-section";
import {
  MatterNumberingSection,
  OrganizationProfileSection,
} from "@/routes/_protected.organization/-components/organization-settings-sections";

export const Route = createFileRoute("/_protected/organization/settings")({
  component: OrganizationSettings,
});

function OrganizationSettings() {
  const t = useTranslations();

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t("organization.settings")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("organization.settingsDescription")}
        </p>
      </div>
      <OrganizationProfileSection />
      <MatterNumberingSection />
      <AIConfigSection />
    </div>
  );
}
