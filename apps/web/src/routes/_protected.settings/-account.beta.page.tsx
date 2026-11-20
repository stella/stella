import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { FramePanel } from "@stll/ui/frame";

import { RecoverableErrorStatus } from "@/components/recoverable-error-status";
import { detached } from "@/lib/detached";
import { useDevStore } from "@/lib/dev-store";
import { useFeatureEnrolment } from "@/queries/feature-enrolments";
import {
  BETA_FEATURES,
  BetaFeaturePanel,
  BetaPageShell,
  SelfServeFeaturePanelsPending,
} from "@/routes/_protected.settings/-account.beta.pending";
import type { BetaFeature } from "@/routes/_protected.settings/-account.beta.pending";

type BetaFeatureToggleProps = {
  feature: BetaFeature;
  checked: boolean;
  disabled?: boolean | undefined;
  onCheckedChange: (next: boolean) => void;
};

/** A preview's panel with its live checkbox. */
const BetaFeatureToggle = ({
  checked,
  disabled,
  feature,
  onCheckedChange,
}: BetaFeatureToggleProps) => {
  const t = useTranslations();
  const { title } = BETA_FEATURES[feature];
  return (
    <BetaFeaturePanel {...BETA_FEATURES[feature]}>
      {/* The face (BetaFeaturePanelPending) lays out the same row. */}
      <Field className="flex-row items-center gap-2">
        <Checkbox
          aria-label={t(title)}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => {
            if (next === checked) {
              return;
            }
            onCheckedChange(next);
          }}
        />
        <FieldLabel>{t(title)}</FieldLabel>
      </Field>
    </BetaFeaturePanel>
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
  if (!feature) {
    return null;
  }
  return (
    <BetaFeatureToggle
      checked={feature.enrolled}
      disabled={mutation.isPending}
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
      <FramePanel>
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
      </FramePanel>
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
