import { cn } from "@stll/ui/lib/utils";
import { useTranslations } from "use-intl";

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
    t("onboarding.stepAi"),
    t("onboarding.stepTeam"),
    t("onboarding.stepDesktop"),
  ];

  return (
    <div className="mb-10 flex items-center gap-4">
      {Array.from({ length: totalSteps }, (_, i) => (
        <div className="flex flex-col gap-1.5" key={i}>
          <div
            className={cn(
              "h-1.5 w-12 rounded-full transition-colors duration-300",
              i <= currentStep ? "bg-foreground" : "bg-border",
            )}
          />
          <span
            className={cn(
              "text-[11px] transition-colors duration-300",
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
