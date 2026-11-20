import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

export const OnboardingProgressFace = ({
  currentStep,
  labels,
  totalSteps,
}: {
  currentStep: number;
  labels: readonly ReactNode[];
  totalSteps: number;
}) => (
  <div className="mb-6 flex items-start gap-4 [@media(min-height:700px)]:mb-10">
    {Array.from({ length: totalSteps }, (_, i) => (
      <div className="flex min-w-0 flex-1 flex-col gap-1.5" key={i}>
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
          {labels[i]}
        </span>
      </div>
    ))}
  </div>
);
