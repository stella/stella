import { useTranslations } from "use-intl";

import { useBillingDraftSettings } from "../activity/billing-draft-settings";
import { ActivitySetupFlow } from "./ActivitySetupFlow";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";
import { useActivitySetup } from "./use-activity-setup";

/**
 * Activity, for an account that has it: one choice per screen inside this
 * one step of the tour, with the tour's own Back, dots and Continue. The
 * native flow moves between steps; the screens follow the activity state,
 * which the native flow does not hold.
 */
export const ActivityStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const activityT = useTranslations("activity");
  const controls = useActivitySetup();
  const drafts = useBillingDraftSettings(true);
  return (
    <ActivitySetupFlow
      controls={controls}
      drafts={drafts}
      finishLabel={t("continue")}
      label={activityT("title")}
      onLeaveBack={onBack}
      onLeaveForward={onContinue}
      permissions={snapshot.activityPermissions}
      recordingBody={t("activityBody")}
      renderFooter={(actions) => (
        <StepFooter
          backDisabledReason={actions.backDisabledReason}
          onBack={actions.onBack}
          primary={actions.primary}
          secondary={actions.secondary}
          snapshot={snapshot}
        />
      )}
      skipLabel={t("skip")}
    />
  );
};
