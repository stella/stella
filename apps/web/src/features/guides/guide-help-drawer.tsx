import { useState } from "react";

import { CircleHelpIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/components/sheet";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { GuideChecklist } from "@/features/guides/guide-checklist";
import { GUIDE_TOURS } from "@/features/guides/guide-tours";
import {
  GUIDE_TOUR_STATUSES,
  type GuideTour,
} from "@/features/guides/guide-types";
import { useGuideRunner } from "@/features/guides/use-guide-runner";
import { useOnboardingProgress } from "@/features/guides/use-onboarding-progress";

// The Help & guides entry: a sidebar button opening a right-side drawer with the
// progress-tracked onboarding checklist. Gate the render on
// `useGuidesPreviewEnabled()` at the call site.
export const GuideHelpDrawer = () => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const progress = useOnboardingProgress(GUIDE_TOURS);
  const runner = useGuideRunner({
    onCompleted: (tourId) =>
      progress.setTourStatus(tourId, GUIDE_TOUR_STATUSES.completed),
  });

  const handleStart = (tour: GuideTour) => {
    // Close the drawer first so the spotlight lands on the real UI, not the
    // panel that launched it.
    setOpen(false);
    runner.runTour(tour);
  };

  return (
    <SidebarMenuItem>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetTrigger
          render={
            <SidebarMenuButton
              size="sm"
              tooltip={t("guides.help.buttonLabel")}
            />
          }
        >
          <CircleHelpIcon className="size-4" />
          <span>{t("guides.help.buttonLabel")}</span>
        </SheetTrigger>
        <SheetPopup side="inline-end">
          <SheetHeader>
            <SheetTitle>{t("guides.help.title")}</SheetTitle>
            <SheetDescription>{t("guides.help.subtitle")}</SheetDescription>
          </SheetHeader>
          <SheetPanel>
            <GuideChecklist
              activeTourId={runner.activeTourId}
              onStart={handleStart}
              progress={progress}
              tours={GUIDE_TOURS}
            />
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </SidebarMenuItem>
  );
};
