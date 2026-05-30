import type { ReactNode } from "react";

import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { OnboardingProgress } from "@/routes/onboarding/-components/onboarding-progress";

type OnboardingLayoutProps = {
  children: ReactNode;
  preview: ReactNode;
  currentStep: number;
  totalSteps: number;
  onBack?: () => void;
  /** Pixel width for the inner content column. Defaults to 460. */
  contentMaxWidth?: number;
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
  contentMaxWidth = 460,
}: OnboardingLayoutProps) => {
  const t = useTranslations();

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Left: form. overflow-y-auto so tall steps (AI provider/model
          picker, invite form) stay scrollable on short viewports
          instead of clipping the footer controls. */}
      <div className="flex w-full flex-col overflow-y-auto px-6 pt-[8vh] pb-10 md:w-1/2 md:px-12 md:pt-[10vh] lg:px-20">
        <div
          className="relative mx-auto flex min-h-0 w-full flex-1 flex-col"
          style={{ maxWidth: contentMaxWidth }}
        >
          {onBack && (
            <button
              aria-label={t("common.goBack")}
              className="text-muted-foreground hover:text-foreground absolute -top-12 flex size-8 items-center justify-center rounded-md transition-colors"
              onClick={onBack}
              style={{ insetInlineStart: "-12px" }}
              type="button"
            >
              <ArrowLeftIcon className="size-4" />
            </button>
          )}
          <OnboardingProgress
            currentStep={currentStep}
            totalSteps={totalSteps}
          />
          {children}
        </div>
      </div>

      {/* Right: preview — matches left column's vertical padding so the
          floating Theme/Language buttons (top-4) and the back arrow
          have breathing room above the card. */}
      <div className="bg-muted hidden items-center justify-center px-6 pt-[10vh] pb-10 md:flex md:w-1/2">
        {preview}
      </div>
    </div>
  );
};
