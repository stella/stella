import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/components/checkbox";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Frame, FramePanel } from "@stll/ui/components/frame";

import { betaFeaturesAvailable } from "@/lib/beta-features";
import { useDevStore } from "@/lib/dev-store";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/beta")({
  beforeLoad: () => {
    if (!betaFeaturesAvailable()) {
      throw redirect({ to: "/settings/account/profile" });
    }
  },
  component: BetaFeaturesPage,
});

function BetaFeaturesPage() {
  const t = useTranslations();
  const publicLawPreview = useDevStore((s) => s.publicLawPreview);
  const setPublicLawPreview = useDevStore((s) => s.setPublicLawPreview);

  return (
    <>
      <SettingsPageHeader
        description={t("settings.account.betaDescription")}
        title={t("settings.account.beta")}
      />
      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-3 p-1">
            <h2 className="text-sm font-medium">{t("common.caseLaw")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("settings.account.betaCaseLawDescription")}
            </p>
            <Field className="flex-row items-center gap-2">
              <Checkbox
                checked={publicLawPreview}
                onCheckedChange={(next) => {
                  setPublicLawPreview(next);
                }}
              />
              <FieldLabel>{t("common.caseLaw")}</FieldLabel>
            </Field>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}
