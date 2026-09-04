import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  ENTITIES_PER_WORKSPACE_MAX,
  PROPERTIES_PER_WORKSPACE_MAX,
} from "@stll/api-contract";
import { DiscordLogoIcon } from "@stll/ui/brand-icons";
import { Button } from "@stll/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/tabs";

import { isGuideTourAvailable } from "@/features/guides/guide-availability";
import {
  GuideChecklist,
  GuideChecklistSkeleton,
} from "@/features/guides/guide-checklist";
import { hasGuideWorkspaceView } from "@/features/guides/guide-route";
import { GUIDE_TOURS } from "@/features/guides/guide-tours";
import {
  GUIDE_TOUR_STATUSES,
  type GuideTour,
} from "@/features/guides/guide-types";
import { useGuideRunner } from "@/features/guides/use-guide-runner";
import { useOnboardingProgress } from "@/features/guides/use-onboarding-progress";
import { usePermissions } from "@/hooks/use-permissions";
import { useWorkflowsPreviewEnabled } from "@/hooks/use-workflows-preview";
import { COMMUNITY_FORUM_URL, CONTACT_EMAIL } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";
import { entitySummariesCountOptions } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";

const HELP_TABS = {
  guides: "guides",
  community: "community",
} as const;

type GuideHelpDrawerProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceSelectionPending: boolean;
  workspaceId: string | undefined;
};

export const GuideHelpDrawer = ({
  onOpenChange,
  open,
  workspaceSelectionPending,
  workspaceId,
}: GuideHelpDrawerProps) => {
  const t = useTranslations();
  const workflowsEnabled = useWorkflowsPreviewEnabled();
  const canUseChat = usePermissions({ chat: ["create"] });
  const canCreateDocument = usePermissions({ entity: ["create"] });
  const canCreateProperty = usePermissions({ property: ["create"] });
  const canCreatePlaybook = usePermissions({ playbook: ["create"] });
  const canCreateWorkflow = usePermissions({ flow: ["create"] });
  const availabilityWorkspaceId = workspaceId ?? "";
  const matterToursPermitted = canCreateDocument || canCreateProperty;
  const entitiesCountQuery = useQuery({
    ...entitySummariesCountOptions(availabilityWorkspaceId),
    enabled: open && workspaceId !== undefined && canCreateDocument,
  });
  const propertiesCountQuery = useQuery({
    ...propertiesOptions(availabilityWorkspaceId),
    enabled: open && workspaceId !== undefined && canCreateProperty,
    select: (properties) => properties.length,
  });
  const viewsQuery = useQuery({
    ...viewsOptions(availabilityWorkspaceId),
    enabled: open && workspaceId !== undefined && matterToursPermitted,
  });
  const entitiesCount = entitiesCountQuery.data;
  const propertiesCount = propertiesCountQuery.data;
  const viewsAvailable =
    viewsQuery.data !== undefined && hasGuideWorkspaceView(viewsQuery.data);
  const availabilityQueries = [
    entitiesCountQuery,
    propertiesCountQuery,
    viewsQuery,
  ].filter((query) => query.isEnabled);
  const availabilityPending =
    open &&
    (workspaceSelectionPending ||
      availabilityQueries.some((query) => query.isPending));
  const failedAvailabilityQueries = availabilityQueries.filter(
    (query) => query.isError,
  );
  const availabilityRetrying = failedAvailabilityQueries.some(
    (query) => query.isFetching,
  );
  const tours = GUIDE_TOURS.filter((tour) =>
    isGuideTourAvailable(tour.id, {
      canUseChat,
      canCreateDocument,
      canCreateProperty,
      documentsAvailable:
        entitiesCount !== undefined &&
        viewsAvailable &&
        entitiesCount < ENTITIES_PER_WORKSPACE_MAX,
      tabularReviewAvailable:
        propertiesCount !== undefined &&
        viewsAvailable &&
        propertiesCount < PROPERTIES_PER_WORKSPACE_MAX,
      workflowsAvailable: workflowsEnabled,
      canCreatePlaybook,
      canCreateWorkflow,
    }),
  );
  const expectedTours = GUIDE_TOURS.filter((tour) =>
    isGuideTourAvailable(tour.id, {
      canUseChat,
      canCreateDocument,
      canCreateProperty,
      documentsAvailable:
        canCreateDocument &&
        (viewsQuery.data === undefined || viewsAvailable) &&
        (entitiesCount === undefined ||
          entitiesCount < ENTITIES_PER_WORKSPACE_MAX),
      tabularReviewAvailable:
        canCreateProperty &&
        (viewsQuery.data === undefined || viewsAvailable) &&
        (propertiesCount === undefined ||
          propertiesCount < PROPERTIES_PER_WORKSPACE_MAX),
      workflowsAvailable: workflowsEnabled,
      canCreatePlaybook,
      canCreateWorkflow,
    }),
  );
  const progress = useOnboardingProgress(tours);
  const runner = useGuideRunner({
    onCompleted: (tourId) =>
      progress.setTourStatus(tourId, GUIDE_TOUR_STATUSES.completed),
    workspaceId,
  });

  const handleStart = (tour: GuideTour) => {
    onOpenChange(false);
    runner.runTour(tour);
  };

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
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
              {failedAvailabilityQueries.length > 0 && (
                <div
                  className="mb-3 flex flex-col items-start gap-1"
                  role="alert"
                >
                  <p className="text-muted-foreground text-sm">
                    {t("errors.actionFailed")}
                  </p>
                  <Button
                    disabled={availabilityRetrying}
                    onClick={() => {
                      detached(
                        Promise.all(
                          failedAvailabilityQueries.map(async (query) =>
                            query.refetch(),
                          ),
                        ),
                        "guides.availability-retry",
                      );
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              {availabilityPending ? (
                <GuideChecklistSkeleton tourCount={expectedTours.length} />
              ) : (
                <GuideChecklist
                  activeTourId={runner.activeTourId}
                  onStart={handleStart}
                  progress={progress}
                  tours={tours}
                />
              )}
            </TabsPanel>
            <TabsPanel className="pt-2" value={HELP_TABS.community}>
              <GuideCommunityPanel />
            </TabsPanel>
          </Tabs>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
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
