import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { MemoryPanel } from "@/routes/_protected.settings/-components/organization/memory/memory-panel";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("memory.pageDescription")}
        title={t("memory.pageTitle")}
      />
      <MemoryPanel />
    </>
  );
}
