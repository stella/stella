import type { ReactNode } from "react";

import { ArrowLeftIcon } from "lucide-react";

import { OnboardingProgress } from "@/routes/onboarding/-components/onboarding-progress";

type OnboardingLayoutProps = {
  children: ReactNode;
  preview: ReactNode;
  currentStep: number;
  totalSteps: number;
  onBack?: () => void;
};

/**
 * Split layout for onboarding wizard steps.
 * Left half: form content with progress bar and optional back.
 * Right half: bg-muted with sidebar preview (hidden on mobile).
 */
export const OnboardingLayout = ({
  children,
  preview,
  currentStep,
  totalSteps,
  onBack,
}: OnboardingLayoutProps) => (
  <div className="flex min-h-dvh">
    {/* Left: form */}
    <div className="flex w-full flex-col px-6 pt-[8vh] pb-10 md:w-1/2 md:px-12 md:pt-[10vh] lg:px-20">
      <div className="mx-auto w-full max-w-[460px]">
        {onBack && (
          <button
            aria-label="Go back"
            className="text-muted-foreground hover:text-foreground mb-4 flex items-center gap-1 text-sm transition-colors"
            onClick={onBack}
            type="button"
          >
            <ArrowLeftIcon className="size-3.5" />
          </button>
        )}
        <OnboardingProgress currentStep={currentStep} totalSteps={totalSteps} />
        {children}
      </div>
    </div>

    {/* Right: preview */}
    <div className="bg-muted hidden items-center justify-center px-6 py-8 md:flex md:w-1/2">
      {preview}
    </div>
  </div>
);
