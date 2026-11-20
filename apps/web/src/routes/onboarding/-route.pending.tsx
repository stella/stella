import type { ReactNode } from "react";

import { GlobeIcon, MonitorIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";
import { PickerTriggerPending } from "@/components/picker-trigger.pending";
import { framePendingView } from "@/routes/-pending-view.logic";

import { OnboardingLayoutShell } from "./-components/onboarding-layout.pending";
import { OnboardingProgressFace } from "./-components/onboarding-progress.pending";
import {
  ONBOARDING_PROGRESS_LABELS,
  ONBOARDING_STEP_COUNT,
  onboardingStepIndex,
} from "./-components/onboarding-steps.logic";
import { OnboardingSidebarPending } from "./-components/sidebar-preview.pending";
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
  <OnboardingPageShell
    pickers={
      <>
        <PickerTriggerPending icon={MonitorIcon} />
        <PickerTriggerPending icon={GlobeIcon} />
      </>
    }
  >
    <OnboardingLayoutShell preview={<OnboardingSidebarPending />}>
      <OnboardingProgressFace
        currentStep={onboardingStepIndex("organization")}
        labels={ONBOARDING_PROGRESS_LABELS.map((id) => (
          <PendingText id={id} barClassName="w-5 max-w-full" key={id} />
        ))}
        totalSteps={ONBOARDING_STEP_COUNT}
      />
      <OrganizationStepPending />
    </OnboardingLayoutShell>
  </OnboardingPageShell>
));
