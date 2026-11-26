import { useTranslations } from "use-intl";

import { DictationSetupFlow } from "./DictationSetupFlow";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";
import { useDictation } from "./use-dictation";

/**
 * Dictation, for an account that has it: one choice per screen inside this
 * one step of the tour, with the tour's own Back, dots and Continue. The
 * native flow moves between steps; the screens follow the dictation state,
 * which the native flow does not hold. A download keeps going after the
 * flow moves on.
 */
export const DictationStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const dictationT = useTranslations("dictation");
  const controls = useDictation();
  return (
    <DictationSetupFlow
      controls={controls}
      finishLabel={t("continue")}
      label={dictationT("title")}
      onLeaveBack={onBack}
      onLeaveForward={onContinue}
      permissions={snapshot.dictationPermissions}
      renderFooter={(actions) => (
        <StepFooter
          onBack={actions.onBack}
          primary={actions.primary}
          screens={actions.screens}
          secondary={actions.secondary}
          snapshot={snapshot}
        />
      )}
      skipLabel={t("skip")}
    />
  );
};
