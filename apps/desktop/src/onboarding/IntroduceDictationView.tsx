import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { Permission } from "../shared/permissions";
import { DictationSetup } from "./DictationSetup";
import { useDictation } from "./use-dictation";

type IntroduceDictationViewProps = {
  dictationPermissions: readonly Permission[];
  onDismiss: () => void;
  /** Opens settings, where language and the other options are. */
  onOpenSettings: () => void;
};

/** Dictation arrived after setup: the same setup as the tour's step, once. */
export const IntroduceDictationView = ({
  dictationPermissions,
  onDismiss,
  onOpenSettings,
}: IntroduceDictationViewProps) => {
  const t = useTranslations("onboarding");
  const controls = useDictation();
  return (
    <>
      <h1 className="text-xl font-semibold">{t("introduceDictationTitle")}</h1>
      <DictationSetup controls={controls} permissions={dictationPermissions} />
      <div className="mt-auto flex justify-end gap-2 pt-5">
        {controls.snapshot?.enabled === true ? (
          <>
            <Button
              className="me-auto"
              onClick={onOpenSettings}
              variant="ghost"
            >
              {t("openSettings")}
            </Button>
            <Button onClick={onDismiss}>{t("done")}</Button>
          </>
        ) : (
          <Button onClick={onDismiss} variant="ghost">
            {t("later")}
          </Button>
        )}
      </div>
    </>
  );
};
