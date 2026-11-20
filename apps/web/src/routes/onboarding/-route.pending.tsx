import type { ReactNode } from "react";

import { AuthPickersPending } from "@/routes/-auth-frame.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

import { OnboardingLayoutShell } from "./-components/onboarding-layout.pending";
import { OnboardingProgressFace } from "./-components/onboarding-progress.pending";
import { onboardingStepIndex } from "./-components/onboarding-steps.logic";
import { OnboardingSidebarFrame } from "./-components/sidebar-preview.pending";
import { OrganizationStepPending } from "./-components/steps/organization-step.pending";

export const OnboardingPageShell = ({
  children,
  pickers,
}: {
  children: ReactNode;
  pickers: ReactNode;
}) => (
  <>
    {children}
    <div className="fixed end-4 top-4 z-20 flex items-center gap-2 lg:end-8 lg:top-6">
      {pickers}
    </div>
  </>
);

export const OnboardingPending = framePendingView(() => (
  <OnboardingPageShell pickers={<AuthPickersPending />}>
    <OnboardingLayoutShell preview={<OnboardingSidebarFrame />}>
      <OnboardingProgressFace
        currentStep={onboardingStepIndex("organization")}
      />
      <OrganizationStepPending />
    </OnboardingLayoutShell>
  </OnboardingPageShell>
));
