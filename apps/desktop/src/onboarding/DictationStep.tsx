import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { DictationSetup } from "./DictationSetup";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";
import { useDictation } from "./use-dictation";

/**
 * Dictation, for an account that has it: turned on, its speech model
 * downloaded and tried here, or skipped. A download keeps going after the
 * flow moves on.
 */
export const DictationStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const dictationT = useTranslations("dictation");
  const controls = useDictation();
  const enabled = controls.snapshot?.enabled === true;
  return (
    <>
      <h1 className="text-xl font-semibold">{dictationT("title")}</h1>
      <DictationSetup
        controls={controls}
        permissions={snapshot.dictationPermissions}
      />
      <StepFooter
        onBack={onBack}
        primary={
          enabled ? <Button onClick={onContinue}>{t("continue")}</Button> : null
        }
        secondary={
          enabled ? null : (
            <Button onClick={onContinue} variant="ghost">
              {t("skip")}
            </Button>
          )
        }
        snapshot={snapshot}
      />
    </>
  );
};
