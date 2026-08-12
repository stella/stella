import { useState } from "react";

import { CircleHelpIcon, ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { DiscordLogoIcon } from "@stll/ui/components/brand-icons";
import { Button } from "@stll/ui/components/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/components/sheet";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { GuideChecklist } from "@/features/guides/guide-checklist";
import { GUIDE_TOURS } from "@/features/guides/guide-tours";
import {
  GUIDE_TOUR_STATUSES,
  type GuideTour,
} from "@/features/guides/guide-types";
import { useGuideRunner } from "@/features/guides/use-guide-runner";
import { useOnboardingProgress } from "@/features/guides/use-onboarding-progress";
import { COMMUNITY_FORUM_URL, CONTACT_EMAIL } from "@/lib/consts";
import { sanitizeHref } from "@/lib/sanitize-href";

const HELP_TABS = {
  guides: "guides",
  community: "community",
} as const;

// The Help & guides entry: a sidebar button opening a right-side drawer with the
// progress-tracked onboarding checklist and the community forum link. Gate the
// render on `useGuidesPreviewEnabled()` at the call site.
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
            <Tabs defaultValue={HELP_TABS.guides}>
              <TabsList className="w-full">
                <TabsTab value={HELP_TABS.guides}>
                  {t("guides.help.tabs.guides")}
                </TabsTab>
                <TabsTab value={HELP_TABS.community}>
                  {t("guides.help.tabs.community")}
                </TabsTab>
              </TabsList>
              <TabsPanel className="pt-2" value={HELP_TABS.guides}>
                <GuideChecklist
                  activeTourId={runner.activeTourId}
                  onStart={handleStart}
                  progress={progress}
                  tours={GUIDE_TOURS}
                />
              </TabsPanel>
              <TabsPanel className="pt-2" value={HELP_TABS.community}>
                <GuideCommunityPanel />
              </TabsPanel>
            </Tabs>
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </SidebarMenuItem>
  );
};

const GuideCommunityPanel = () => {
  const t = useTranslations();

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground text-sm">
        {t("guides.community.body")}
      </p>
      <Button
        render={
          <a
            // The label duplicates the visible text: the anchor's children are
            // injected by `Button`, so the linter cannot see them statically.
            aria-label={t("guides.community.linkLabel")}
            href={sanitizeHref(COMMUNITY_FORUM_URL)}
            rel="noreferrer noopener"
            target="_blank"
          />
        }
        size="sm"
        variant="secondary"
      >
        <DiscordLogoIcon />
        {t("guides.community.linkLabel")}
        <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
      </Button>
      {/* Deliberately an invitation to talk, not a service level: the product
          sells no support tier, so this must promise a conversation only. */}
      <p className="border-border text-muted-foreground border-t pt-3 text-xs">
        {t("guides.community.directPrompt")}{" "}
        <a
          className="text-foreground underline underline-offset-2"
          href={`mailto:${CONTACT_EMAIL}`}
        >
          {t("guides.community.directLinkLabel")}
        </a>
      </p>
    </div>
  );
};
