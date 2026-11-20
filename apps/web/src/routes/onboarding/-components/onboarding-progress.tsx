import { useTranslations } from "use-intl";

import { OnboardingProgressFace } from "./onboarding-progress.pending";

export const OnboardingProgress = ({
  currentStep,
}: {
  currentStep: number;
}) => {
  const t = useTranslations();
  return (
    <OnboardingProgressFace currentStep={currentStep} label={(id) => t(id)} />
  );
};
