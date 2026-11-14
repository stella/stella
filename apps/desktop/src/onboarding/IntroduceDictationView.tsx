import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { Permission } from "../shared/permissions";
import { DictationSetup } from "./DictationSetup";
import { useDictation } from "./use-dictation";

type IntroduceDictationViewProps = {
  dictationPermissions: readonly Permission[];
  onDismiss: () => void;
};

/** Dictation arrived after setup: the same setup as the tour's step, once. */
export const IntroduceDictationView = ({
  dictationPermissions,
  onDismiss,
}: IntroduceDictationViewProps) => {
  const t = useTranslations("onboarding");
  const controls = useDictation();
  return (
    <>
      <h1 className="text-xl font-semibold">{t("introduceDictationTitle")}</h1>
      <DictationSetup controls={controls} permissions={dictationPermissions} />
      <div className="mt-auto flex justify-end gap-2 pt-5">
        {controls.snapshot?.enabled === true ? (
          <Button onClick={onDismiss}>{t("done")}</Button>
        ) : (
          <Button onClick={onDismiss} variant="ghost">
            {t("later")}
          </Button>
        )}
      </div>
    </>
  );
};
