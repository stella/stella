import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { SettingsPanel, settingsRowIds } from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { detached } from "@/lib/detached";
import { useDevStore } from "@/lib/dev-store";
import { useFeatureEnrolment } from "@/queries/feature-enrolments";
import {
  BETA_FEATURES,
  BetaFeatureRow,
  betaFeatureRowId,
  BetaPageShell,
  SelfServeFeaturePanelsPending,
} from "@/routes/_protected.settings/-account.beta.pending";
import type { BetaFeature } from "@/routes/_protected.settings/-account.beta.pending";

type BetaFeatureToggleProps = {
  feature: BetaFeature;
  checked: boolean;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  onCheckedChange: (next: boolean) => void;
};

/** A preview's row with its live switch. */
const BetaFeatureToggle = ({
  checked,
  disabled,
  disabledReason,
  feature,
  onCheckedChange,
}: BetaFeatureToggleProps) => {
  const t = useTranslations();
  const ids = settingsRowIds(betaFeatureRowId(feature));
  const { description, title } = BETA_FEATURES[feature];
  return (
    <BetaFeatureRow
      description={t(description)}
      feature={feature}
      title={t(title)}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        id={ids.control}
        checked={checked}
        disabled={disabled}
        disabledReason={disabledReason}
        onCheckedChange={(next) => {
          if (next === checked) {
            return;
          }
          onCheckedChange(next);
        }}
      />
    </BetaFeatureRow>
  );
};

type SelfServeFeaturePanelProps = {
  enrolment: Pick<
    ReturnType<typeof useFeatureEnrolment>,
    "feature" | "mutation"
  >;
  feature: BetaFeature;
};

/** A self-serve feature's toggle; nothing when this deployment does not offer it. */
function SelfServeFeaturePanel({
  enrolment: { feature, mutation },
  feature: name,
}: SelfServeFeaturePanelProps) {
  const t = useTranslations();
  if (!feature) {
    return null;
  }
  return (
    <BetaFeatureToggle
      checked={feature.enrolled}
      disabled={mutation.isPending}
      disabledReason={t("common.saving")}
      feature={name}
      onCheckedChange={(next) => mutation.mutate(next)}
    />
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
        <SelfServeFeaturePanelsPending />
      </>
    );
  }
  if (view.type === "error") {
    return (
      <SettingsPanel>
        <RecoverableErrorStatus
          actions={
            <Button
              className="mt-3"
              variant="ghost"
              onClick={() => {
                detached(view.retry(), "feature-enrolments.refetch");
              }}
            >
              {t("common.retry")}
            </Button>
          }
          className="flex flex-col items-start"
          message={t("errors.actionFailed")}
          messageClassName="text-muted-foreground text-sm"
        />
      </SettingsPanel>
    );
  }
  return (
    <>
      <SelfServeFeaturePanel enrolment={timeBilling} feature="timeBilling" />
      <SelfServeFeaturePanel enrolment={localAgents} feature="localAgents" />
    </>
  );
}

/** The beta page: its shell (`BetaPageShell`) with the live toggles. */
export function BetaFeaturesPage() {
  const workflowsPreview = useDevStore((s) => s.workflowsPreview);
  const setWorkflowsPreview = useDevStore((s) => s.setWorkflowsPreview);
  const inboxPreview = useDevStore((s) => s.inboxPreview);
  const setInboxPreview = useDevStore((s) => s.setInboxPreview);

  return (
    <BetaPageShell
      inbox={
        <BetaFeatureToggle
          checked={inboxPreview}
          feature="inbox"
          onCheckedChange={setInboxPreview}
        />
      }
      selfServe={<SelfServeFeaturePanels />}
      workflows={
        <BetaFeatureToggle
          checked={workflowsPreview}
          feature="workflows"
          onCheckedChange={setWorkflowsPreview}
        />
      }
    />
  );
}
