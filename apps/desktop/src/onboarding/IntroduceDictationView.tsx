import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { Permission } from "../shared/permissions";
import { DictationSetupFlow } from "./DictationSetupFlow";
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
    <DictationSetupFlow
      controls={controls}
      finishLabel={t("done")}
      label={t("introduceDictationTitle")}
      onLeaveForward={onDismiss}
      permissions={dictationPermissions}
      renderFooter={({ onBack, primary, secondary }) => (
        <div className="mt-auto flex items-center gap-2 pt-5">
          {onBack === undefined ? null : (
            <Button onClick={onBack} variant="ghost">
              {t("back")}
            </Button>
          )}
          <span className="flex-1" />
          {/* The last screen has nothing left to skip; Settings holds what
              the screens leave out, such as the language. */}
          {secondary ??
            (controls.snapshot?.enabled === true ? (
              <Button onClick={onOpenSettings} variant="ghost">
                {t("openSettings")}
              </Button>
            ) : null)}
          {primary}
        </div>
      )}
      skipLabel={t("later")}
    />
  );
};
