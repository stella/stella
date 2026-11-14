import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";

import { OnboardingProgress } from "@/routes/onboarding/-components/onboarding-progress";

const ONBOARDING_GRADIENT_DARK_URL = "/branding/onboarding-gradient-dark.svg";
const ONBOARDING_GRADIENT_LIGHT_URL = "/branding/onboarding-gradient-light.svg";

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
      <div className="flex w-full flex-col overflow-y-auto px-6 pt-[8svh] pb-10 md:w-1/2 md:px-12 md:pt-[10svh] lg:px-20">
        <div
          className="relative mx-auto flex min-h-0 w-full flex-1 flex-col"
          style={{ maxWidth: contentMaxWidth }}
        >
          {onBack && (
            <Button
              aria-label={t("common.goBack")}
              className="absolute -top-12"
              onClick={onBack}
              size="icon-sm"
              style={{ insetInlineStart: "-12px" }}
              variant="muted"
            >
              <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
            </Button>
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
      <div className="bg-muted relative hidden items-center justify-center overflow-hidden px-6 pt-[10svh] pb-10 md:flex md:w-1/2">
        {/* The landing hero SVGs are the source of truth for these rays;
            onboarding only lowers their opacity. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            maskImage:
              "linear-gradient(to right, var(--foreground) 0%, var(--foreground) 14%, transparent 43%, transparent 62%, var(--foreground) 88%, var(--foreground) 100%)",
            WebkitMaskImage:
              "linear-gradient(to right, var(--foreground) 0%, var(--foreground) 14%, transparent 43%, transparent 62%, var(--foreground) 88%, var(--foreground) 100%)",
          }}
        >
          <img
            alt=""
            className="absolute inset-0 size-full opacity-25 dark:hidden"
            src={ONBOARDING_GRADIENT_LIGHT_URL}
          />
          <img
            alt=""
            className="absolute inset-0 hidden size-full opacity-[0.18] dark:block"
            src={ONBOARDING_GRADIENT_DARK_URL}
          />
        </div>
        <div className="relative z-10 flex h-full w-full items-center justify-center">
          {preview}
        </div>
      </div>
    </div>
  );
};
