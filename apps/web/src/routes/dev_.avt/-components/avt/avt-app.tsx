import { CloudOffIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";

import { ThemePicker } from "@/components/theme-picker";
import { AnchorFactsPanel } from "@/routes/dev_.avt/-components/avt/anchor-facts-panel";
import { VerificationView } from "@/routes/dev_.avt/-components/avt/verification-view";

export function AvtApp() {
  const t = useTranslations();

  return (
    <div className="mx-auto h-dvh max-w-6xl p-6">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">{t("avt.devHarness.title")}</h1>
        <ThemePicker />
      </div>
      <div className="bg-muted text-muted-foreground mb-4 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs">
        <CloudOffIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {t("avt.devHarness.localSessionNotice")}
      </div>
      <Tabs defaultValue="verify">
        <TabsList>
          <TabsTab value="anchors">{t("avt.anchorFacts.title")}</TabsTab>
          <TabsTab value="verify">{t("avt.devHarness.verifyDocument")}</TabsTab>
        </TabsList>
        <TabsPanel value="anchors">
          <AnchorFactsPanel />
        </TabsPanel>
        <TabsPanel value="verify">
          <VerificationView />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
