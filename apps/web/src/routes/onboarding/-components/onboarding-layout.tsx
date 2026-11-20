import { Fragment, ViewTransition } from "react";
import type { FragmentInstance, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";

import { OnboardingProgress } from "@/routes/onboarding/-components/onboarding-progress";

import { OnboardingLayoutShell } from "./onboarding-layout.pending";

import "./onboarding-layout.css";

export const ONBOARDING_TRANSITION_TYPE = {
  forward: "onboarding-forward",
  backward: "onboarding-backward",
} as const;

const STEP_TRANSITION_CLASS = {
  default: "none",
  [ONBOARDING_TRANSITION_TYPE.forward]: "onboarding-step-forward",
  [ONBOARDING_TRANSITION_TYPE.backward]: "onboarding-step-backward",
} as const satisfies Record<
  | "default"
  | (typeof ONBOARDING_TRANSITION_TYPE)[keyof typeof ONBOARDING_TRANSITION_TYPE],
  string
>;

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
    <OnboardingLayoutShell contentMaxWidth={contentMaxWidth} preview={preview}>
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
      <Fragment key={currentStep} ref={focusStep}>
        <OnboardingProgress currentStep={currentStep} totalSteps={totalSteps} />
        <ViewTransition
          default="none"
          enter={STEP_TRANSITION_CLASS}
          exit={STEP_TRANSITION_CLASS}
        >
          {children}
        </ViewTransition>
      </Fragment>
    </OnboardingLayoutShell>
  );
};

/** Focuses the newly rendered step without moving the current viewport. */
const focusStep = (fragment: FragmentInstance | null) => {
  fragment?.focus({ preventScroll: true });
};
