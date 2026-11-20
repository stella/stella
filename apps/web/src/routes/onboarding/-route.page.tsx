import { LanguagePicker } from "@/components/language-picker";
import { ThemePicker } from "@/components/theme-picker";

import { OnboardingWizard } from "./-components/onboarding-wizard";
import { OnboardingPageShell } from "./-route.pending";

export function OnboardingPage() {
  return (
    <OnboardingPageShell
      pickers={
        <>
          <ThemePicker />
          <LanguagePicker />
        </>
      }
    >
      <OnboardingWizard />
    </OnboardingPageShell>
  );
}
