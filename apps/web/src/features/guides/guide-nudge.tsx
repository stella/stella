import { CompassIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useGuideDrawerStore } from "@/features/guides/guide-drawer-store";
import { GUIDE_TOURS } from "@/features/guides/guide-tours";
import { useOnboardingProgress } from "@/features/guides/use-onboarding-progress";

/**
 * One-line invitation on the empty chat for a user who has not touched a
 * guide yet. Progress is the server-side per-user record, so the line goes
 * away on every device as soon as any tour is completed or skipped, with no
 * dismissal state of its own.
 */
export const GuideNudge = () => {
  const t = useTranslations();
  const openDrawer = useGuideDrawerStore((store) => store.open);
  const progress = useOnboardingProgress(GUIDE_TOURS);

  if (!progress.isReady || progress.resolvedCount > 0) {
    return null;
  }

  return (
    <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm">
      <CompassIcon className="size-4 shrink-0" />
      <span>{t("guides.nudge.body")}</span>
      <Button
        onClick={() => openDrawer()}
        size="sm"
        type="button"
        variant="link"
      >
        {t("guides.nudge.action")}
      </Button>
    </div>
  );
};
