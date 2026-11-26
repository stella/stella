import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { Permission } from "../shared/permissions";
import { DictationSetupFlow } from "./DictationSetupFlow";
import { IntroductionLabel } from "./SetupScreenParts";
import { StepFooter } from "./StepFooter";
import { useDictation } from "./use-dictation";

type IntroduceDictationViewProps = {
  dictationPermissions: readonly Permission[];
  onDismiss: () => void;
  /** Opens settings, where language and the other options are. */
  onOpenSettings: () => void;
};

/** Dictation arrived after setup: the same screens as the tour's step,
 *  once, ending in Done. */
export const IntroduceDictationView = ({
  dictationPermissions,
  onDismiss,
  onOpenSettings,
}: IntroduceDictationViewProps) => {
  const t = useTranslations("onboarding");
  const controls = useDictation();
  return (
    <>
      {/* Opened on its own, outside the tour: says what arrived. */}
      <IntroductionLabel>{t("introduceDictationTitle")}</IntroductionLabel>
      <DictationSetupFlow
        controls={controls}
        finishLabel={t("done")}
        label={t("introduceDictationTitle")}
        onLeaveForward={onDismiss}
        permissions={dictationPermissions}
        renderFooter={({ onBack, primary, screens, secondary }) => (
          <StepFooter
            onBack={onBack}
            primary={primary}
            screens={screens}
            secondary={
              // The last screen has nothing left to skip; Settings holds what
              // the screens leave out, such as the language.
              secondary ??
              (controls.snapshot?.enabled === true ? (
                <Button onClick={onOpenSettings} variant="ghost">
                  {t("openSettings")}
                </Button>
              ) : null)
            }
          />
        )}
        skipLabel={t("later")}
      />
    </>
  );
};
