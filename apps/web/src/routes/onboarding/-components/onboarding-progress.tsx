import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

type OnboardingProgressProps = {
  currentStep: number;
  totalSteps: number;
};

export const OnboardingProgress = ({
  currentStep,
  totalSteps,
}: OnboardingProgressProps) => {
  const t = useTranslations();
  const labels = [
    t("onboarding.stepOrganization"),
    t("onboarding.stepJurisdiction"),
    t("onboarding.stepCatalogue"),
    t("onboarding.stepAi"),
    t("onboarding.stepTeam"),
    t("onboarding.stepApps"),
  ];

  return (
    <div className="mb-10 flex items-start gap-4">
      {Array.from({ length: totalSteps }, (_, i) => (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5" key={i}>
          <div
            className={cn(
              "h-1.5 w-12 max-w-full rounded-full transition-colors duration-300",
              i <= currentStep ? "bg-foreground" : "bg-border",
            )}
          />
          <span
            className={cn(
              "text-[11px] wrap-anywhere transition-colors duration-300",
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
};
