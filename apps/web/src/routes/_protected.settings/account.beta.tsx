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
  const playbooksPreview = useDevStore((s) => s.playbooksPreview);
  const setPlaybooksPreview = useDevStore((s) => s.setPlaybooksPreview);
  const workflowsPreview = useDevStore((s) => s.workflowsPreview);
  const setWorkflowsPreview = useDevStore((s) => s.setWorkflowsPreview);
  const timeBillingPreview = useDevStore((s) => s.timeBillingPreview);
  const setTimeBillingPreview = useDevStore((s) => s.setTimeBillingPreview);

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
                  if (next === publicLawPreview) {
                    return;
                  }

                  setPublicLawPreview(next);
                }}
              />
              <FieldLabel>{t("common.caseLaw")}</FieldLabel>
            </Field>
          </div>
        </FramePanel>
        <FramePanel>
          <div className="flex flex-col gap-3 p-1">
            <h2 className="text-sm font-medium">{t("common.playbooks")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("knowledge.sections.playbooks.description")}
            </p>
            <Field className="flex-row items-center gap-2">
              <Checkbox
                checked={playbooksPreview}
                onCheckedChange={(next) => {
                  if (next === playbooksPreview) {
                    return;
                  }

                  setPlaybooksPreview(next);
                }}
              />
              <FieldLabel>{t("common.playbooks")}</FieldLabel>
            </Field>
          </div>
        </FramePanel>
        <FramePanel>
          <div className="flex flex-col gap-3 p-1">
            <h2 className="text-sm font-medium">{t("common.workflows")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("knowledge.sections.workflows.description")}
            </p>
            <Field className="flex-row items-center gap-2">
              <Checkbox
                checked={workflowsPreview}
                onCheckedChange={(next) => {
                  if (next === workflowsPreview) {
                    return;
                  }

                  setWorkflowsPreview(next);
                }}
              />
              <FieldLabel>{t("common.workflows")}</FieldLabel>
            </Field>
          </div>
        </FramePanel>
        <FramePanel>
          <div className="flex flex-col gap-3 p-1">
            <h2 className="text-sm font-medium">{t("common.timeBilling")}</h2>
            <p className="text-muted-foreground text-xs">
              {t("settings.account.betaTimeBillingDescription")}
            </p>
            <Field className="flex-row items-center gap-2">
              <Checkbox
                checked={timeBillingPreview}
                onCheckedChange={(next) => {
                  if (next === timeBillingPreview) {
                    return;
                  }

                  setTimeBillingPreview(next);
                }}
              />
              <FieldLabel>{t("common.timeBilling")}</FieldLabel>
            </Field>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}
