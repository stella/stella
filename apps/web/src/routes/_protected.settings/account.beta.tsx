import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Skeleton } from "@stll/ui/skeleton";

import { betaFeaturesAvailable } from "@/lib/beta-features";
import { detached } from "@/lib/detached";
import { useDevStore } from "@/lib/dev-store";
import { pageTitle } from "@/lib/page-title";
import { useFeatureEnrolment } from "@/queries/feature-enrolments";
import { routePresentation } from "@/routes/-route-presentation";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

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

type SelfServeFeaturePanelProps = {
  enrolment: Pick<
    ReturnType<typeof useFeatureEnrolment>,
    "feature" | "mutation"
  >;
  title: string;
  description: string;
};

/** A self-serve feature's toggle; nothing when this deployment does not offer it. */
function SelfServeFeaturePanel({
  enrolment: { feature, mutation },
  title,
  description,
}: SelfServeFeaturePanelProps) {
  if (!feature) {
    return null;
  }
  return (
    <FramePanel>
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-muted-foreground text-xs">{description}</p>
        <Field className="flex-row items-center gap-2">
          <Checkbox
            aria-label={title}
            checked={feature.enrolled}
            disabled={mutation.isPending}
            onCheckedChange={(next) => {
              if (next === feature.enrolled) {
                return;
              }
              mutation.mutate(next);
            }}
          />
          <FieldLabel>{title}</FieldLabel>
        </Field>
      </div>
    </FramePanel>
  );
}

/** Every toggle reads one list, so its loading and its failure show once. */
function SelfServeFeaturePanels() {
  const t = useTranslations();
  const timeBilling = useFeatureEnrolment("time-billing");
  const localAgents = useFeatureEnrolment("local-agents");
  const { view } = timeBilling;
  if (view.type === "pending") {
    return (
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
  }
  if (view.type === "error") {
    return (
      <FramePanel>
        <p role="alert" className="text-muted-foreground text-sm">
          {t("errors.actionFailed")}
        </p>
        <Button
          className="mt-3"
          variant="ghost"
          onClick={() => {
            detached(view.retry(), "feature-enrolments.refetch");
          }}
        >
          {t("common.retry")}
        </Button>
      </FramePanel>
    );
  }
  return (
    <>
      <SelfServeFeaturePanel
        description={t("settings.account.betaTimeBillingDescription")}
        enrolment={timeBilling}
        title={t("common.timeBilling")}
      />
      <SelfServeFeaturePanel
        description={t("settings.account.betaLocalAgentsDescription")}
        enrolment={localAgents}
        title={t("settings.account.betaLocalAgents")}
      />
    </>
  );
}

function BetaFeaturesPage() {
  const t = useTranslations();
  const workflowsPreview = useDevStore((s) => s.workflowsPreview);
  const setWorkflowsPreview = useDevStore((s) => s.setWorkflowsPreview);
  const inboxPreview = useDevStore((s) => s.inboxPreview);
  const setInboxPreview = useDevStore((s) => s.setInboxPreview);

  return (
    <>
      <SettingsPageHeader
        description={t("settings.account.betaDescription")}
        title={t("settings.account.beta")}
      />
      <Frame>
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
        <SelfServeFeaturePanels />
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
                checked={inboxPreview}
                onCheckedChange={(next) => {
                  if (next === inboxPreview) {
                    return;
                  }

                  setInboxPreview(next);
                }}
              />
              <FieldLabel>{t("settings.account.betaInbox")}</FieldLabel>
            </Field>
          </div>
        </FramePanel>
      </Frame>
    </>
  );
}
