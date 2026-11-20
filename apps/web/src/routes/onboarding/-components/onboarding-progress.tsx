import { useTranslations } from "use-intl";

import { OnboardingProgressFace } from "./onboarding-progress.pending";
import { ONBOARDING_PROGRESS_LABELS } from "./onboarding-steps.logic";

type OnboardingProgressProps = {
  currentStep: number;
  totalSteps: number;
};

export const OnboardingProgress = ({
  currentStep,
  totalSteps,
}: OnboardingProgressProps) => {
  const t = useTranslations();
  const labels = ONBOARDING_PROGRESS_LABELS.map((key) => t(key));

  return (
    <OnboardingProgressFace
      currentStep={currentStep}
      labels={labels}
      totalSteps={totalSteps}
    />
  );
};
