const LABEL_BY_STEP = {
  organization: "onboarding.stepOrganization",
  jurisdiction: "onboarding.stepJurisdiction",
  catalogue: "common.catalogue",
  ai: "onboarding.stepAi",
  invite: "onboarding.stepTeam",
  download: "onboarding.stepApps",
} as const;

export type OnboardingStep = keyof typeof LABEL_BY_STEP;

const ONBOARDING_STEPS = Object.keys(LABEL_BY_STEP);
export const ONBOARDING_PROGRESS_LABELS = Object.values(LABEL_BY_STEP);
export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

export const onboardingStepIndex = (step: OnboardingStep) =>
  ONBOARDING_STEPS.indexOf(step);
