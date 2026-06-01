import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { AIConfigCard } from "@/routes/_protected.settings/-components/organization/ai-config-card";
import { DeepLKeyCard } from "@/routes/_protected.settings/-components/organization/deepl-key-card";
import { PromptCachingCard } from "@/routes/_protected.settings/-components/organization/prompt-caching-card";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/organization/ai")({
  component: AIConfigPage,
});

function AIConfigPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("settings.organization.aiDescription")}
        title={t("settings.organization.ai")}
      />
      <AIConfigCard />
      <PromptCachingCard />
      <div className="my-8 border-t" />
      <DeepLKeyCard />
    </>
  );
}
