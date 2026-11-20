import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

import { ONBOARDING_PROGRESS_LABELS } from "./onboarding-steps.logic";

type StepLabel = (typeof ONBOARDING_PROGRESS_LABELS)[number];

const pendingLabel = (id: StepLabel) => (
  <PendingText id={id} barClassName="w-5 max-w-full" />
);

export const OnboardingProgressFace = ({
  currentStep,
  label = pendingLabel,
}: {
  currentStep: number;
  label?: (id: StepLabel) => ReactNode;
}) => (
  <div className="mb-6 flex items-start gap-4 [@media(min-height:700px)]:mb-10">
    {ONBOARDING_PROGRESS_LABELS.map((id, i) => (
      <div className="flex min-w-0 flex-1 flex-col gap-1.5" key={id}>
        <div
          className={cn(
            "h-1.5 w-12 max-w-full rounded-full",
            i <= currentStep ? "bg-foreground" : "bg-border",
          )}
        />
        <span
          className={cn(
            "text-2xs wrap-anywhere",
            i <= currentStep
              ? "text-muted-foreground"
              : "text-foreground-disabled",
          )}
        >
          {label(id)}
        </span>
      </div>
    ))}
  </div>
);
