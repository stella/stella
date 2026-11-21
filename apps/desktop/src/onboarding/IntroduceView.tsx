import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useBillingDraftSettings } from "../activity/billing-draft-settings";
import type { Permission } from "../shared/permissions";
import { ActivitySetupFlow } from "./ActivitySetupFlow";
import { useActivitySetup } from "./use-activity-setup";

type IntroduceViewProps = {
  activityPermissions: readonly Permission[];
  onDismiss: () => void;
  onOpenActivity: () => void;
};

/** Activity arrived after setup: the same screens as the tour's step,
 *  once, ending in Done. */
export const IntroduceView = ({
  activityPermissions,
  onDismiss,
  onOpenActivity,
}: IntroduceViewProps) => {
  const t = useTranslations("onboarding");
  const controls = useActivitySetup();
  const drafts = useBillingDraftSettings(true);
  return (
    <ActivitySetupFlow
      controls={controls}
      drafts={drafts}
      finishLabel={t("done")}
      label={t("introduceActivityTitle")}
      onLeaveForward={onDismiss}
      permissions={activityPermissions}
      recordingBody={t("introduceActivityBody")}
      renderFooter={({ onBack, primary, secondary }) => (
        <div className="mt-auto flex items-center gap-2 pt-5">
          {onBack === undefined ? null : (
            <Button onClick={onBack} variant="ghost">
              {t("back")}
            </Button>
          )}
          <span className="flex-1" />
          {/* The last screen has nothing left to skip; the day itself is in
              the Activity window. */}
          {secondary ??
            (controls.snapshot?.recordingStatus === "recording" ? (
              <Button onClick={onOpenActivity} variant="ghost">
                {t("openActivity")}
              </Button>
            ) : null)}
          {primary}
        </div>
      )}
      skipLabel={t("later")}
    />
  );
};
