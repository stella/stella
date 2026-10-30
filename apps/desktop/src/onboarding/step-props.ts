import type { OnboardingSnapshot } from "./onboarding-types";

export type StepProps = {
  onBack: () => void;
  onContinue: () => void;
  snapshot: OnboardingSnapshot;
};
