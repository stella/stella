import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Skeleton } from "@stll/ui/skeleton";

import { SettingsPageHeader } from "@/components/settings-page-header";
import { betaFeaturesAvailable } from "@/lib/beta-features";
import { detached } from "@/lib/detached";
import { useDevStore } from "@/lib/dev-store";
import { pageTitle } from "@/lib/page-title";
import {
  useFeatureEnrolment,
  useTimeBillingEnrolment,
} from "@/queries/feature-enrolments";
import { routePresentation } from "@/routes/-route-presentation";

export const Route = createFileRoute("/_protected/settings/account/beta")({
  beforeLoad: () => {
    if (!betaFeaturesAvailable()) {
      throw redirect({ to: "/settings/account/profile" });
    }
  },
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "settings.account.beta",
      to: "/settings/account/beta",
    }),
  },
  head: () => ({ meta: [{ title: pageTitle("settings.account.beta") }] }),
  component: BetaFeaturesPage,
});

function BetaFeaturesPage() {
  const t = useTranslations();
  const publicLawPreview = useDevStore((s) => s.publicLawPreview);
  const setPublicLawPreview = useDevStore((s) => s.setPublicLawPreview);
  const { feature: flowsFeature, mutation: flowsEnrolment } =
    useFeatureEnrolment("flows");
  const {
    feature: timeBillingFeature,
    mutation: timeBillingEnrolment,
    view: timeBillingView,
  } = useTimeBillingEnrolment();
  const { feature: signalsFeature, mutation: signalsEnrolment } =
    useFeatureEnrolment("signals");
  let timeBillingPanel = null;
  if (timeBillingView.type === "pending") {
    timeBillingPanel = (
      <>
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <FramePanel aria-hidden="true">
          <div className="flex flex-col gap-3 p-1">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-5 w-36" />
          </div>
        </FramePanel>
      </>
    );
  } else if (timeBillingView.type === "error") {
    timeBillingPanel = (
      <FramePanel>
        <p role="alert" className="text-muted-foreground text-sm">
          {t("errors.actionFailed")}
        </p>
        <Button
          className="mt-3"
          variant="ghost"
          onClick={() => {
            detached(timeBillingView.retry(), "feature-enrolments.refetch");
          }}
        >
          {t("common.retry")}
        </Button>
      </FramePanel>
    );
  } else if (timeBillingFeature) {
    timeBillingPanel = (
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-medium">{t("common.timeBilling")}</h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.account.betaTimeBillingDescription")}
          </p>
          <Field className="flex-row items-center gap-2">
            <Checkbox
              aria-label={t("common.timeBilling")}
              checked={timeBillingFeature.enrolled}
              disabled={timeBillingEnrolment.isPending}
              onCheckedChange={(next) => {
                if (next === timeBillingFeature.enrolled) {
                  return;
                }
                timeBillingEnrolment.mutate(next);
              }}
            />
            <FieldLabel>{t("common.timeBilling")}</FieldLabel>
          </Field>
        </div>
      </FramePanel>
    );
  }

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
        {flowsFeature && (
          <FramePanel>
            <div className="flex flex-col gap-3 p-1">
              <h2 className="text-sm font-medium">{t("common.workflows")}</h2>
              <p className="text-muted-foreground text-xs">
                {t("knowledge.sections.workflows.description")}
              </p>
              <Field className="flex-row items-center gap-2">
                <Checkbox
                  aria-label={t("common.workflows")}
                  disabled={flowsEnrolment.isPending}
                  checked={flowsFeature.enrolled}
                  onCheckedChange={(next) => {
                    if (next === flowsFeature.enrolled) {
                      return;
                    }

                    flowsEnrolment.mutate(next);
                  }}
                />
                <FieldLabel>{t("common.workflows")}</FieldLabel>
              </Field>
            </div>
          </FramePanel>
        )}
        {timeBillingPanel}
        {signalsFeature && (
          <FramePanel>
            <div className="flex flex-col gap-3 p-1">
              <h2 className="text-sm font-medium">
                {t("settings.account.betaInbox")}
              </h2>
              <p className="text-muted-foreground text-xs">
                {t("settings.account.betaInboxDescription")}
              </p>
              <Field className="flex-row items-center gap-2">
                <Checkbox
                  aria-label={t("settings.account.betaInbox")}
                  disabled={signalsEnrolment.isPending}
                  checked={signalsFeature.enrolled}
                  onCheckedChange={(next) => {
                    if (next === signalsFeature.enrolled) {
                      return;
                    }

                    signalsEnrolment.mutate(next);
                  }}
                />
                <FieldLabel>{t("settings.account.betaInbox")}</FieldLabel>
              </Field>
            </div>
          </FramePanel>
        )}
      </Frame>
    </>
  );
}
