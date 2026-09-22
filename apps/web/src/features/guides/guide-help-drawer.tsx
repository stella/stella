import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, MailIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  ENTITIES_PER_WORKSPACE_MAX,
  PROPERTIES_PER_WORKSPACE_MAX,
} from "@stll/api-contract";
import { DiscordLogoIcon, GitHubLogoIcon } from "@stll/ui/brand-icons";
import { Button } from "@stll/ui/button";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";

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
import { roleOptions } from "@/lib/auth-queries";
import {
  COMMUNITY_FORUM_URL,
  CONTACT_EMAIL,
  GITHUB_FEEDBACK_URL,
  TECHNICAL_DOCS_URL,
} from "@/lib/consts";
import { detached } from "@/lib/detached";
import { sanitizeHref } from "@/lib/sanitize-href";
import { entitySummariesCountOptions } from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";

const SUPPORT_CHANNEL_NAMES = {
  discord: "Discord",
  github: "GitHub",
} as const;

// The sidebar's matter list decides which matter the matter tours run in.
// Until it has loaded the checklist cannot be final; when it has failed the
// matter tours are missing for a reason the user must be able to retry.
export type GuideWorkspaceListState =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "failed"; isRetrying: boolean; retry: () => void };

type GuideHelpDrawerProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceList: GuideWorkspaceListState;
  workspaceId: string | undefined;
};

export const GuideHelpDrawer = ({
  onOpenChange,
  open,
  workspaceList,
  workspaceId,
}: GuideHelpDrawerProps) => {
  const t = useTranslations();
  // `usePermissions` fails closed while the role loads; without this the
  // drawer would briefly render a checklist missing every permission-gated
  // tour instead of the skeleton.
  const { isPending: rolePending } = useQuery(roleOptions);
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
    (rolePending ||
      workspaceList.status === "pending" ||
      availabilityQueries.some((query) => query.isPending));
  const failedAvailabilityQueries = availabilityQueries.filter(
    (query) => query.isError,
  );
  const workspaceListFailed = workspaceList.status === "failed";
  const availabilityFailed =
    workspaceListFailed || failedAvailabilityQueries.length > 0;
  const availabilityRetrying =
    (workspaceList.status === "failed" && workspaceList.isRetrying) ||
    failedAvailabilityQueries.some((query) => query.isFetching);
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
      <SheetPopup side="inline-start">
        <SheetHeader>
          <SheetTitle>{t("guides.help.title")}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          {availabilityFailed && (
            <div className="mb-3 flex flex-col items-start gap-1" role="alert">
              <p className="text-muted-foreground text-sm">
                {t("errors.actionFailed")}
              </p>
              <Button
                disabled={availabilityRetrying}
                onClick={() => {
                  if (workspaceList.status === "failed") {
                    workspaceList.retry();
                  }
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
        </SheetPanel>
        <GuideSupportFooter />
      </SheetPopup>
    </Sheet>
  );
};

const GuideSupportFooter = () => {
  const t = useTranslations();

  return (
    <SheetFooter className="flex-col items-stretch gap-2 sm:flex-col sm:justify-start">
      <div className="grid grid-cols-3 gap-2">
        <Button
          className="min-w-0"
          render={
            <a
              // The label duplicates the visible text: the anchor's children
              // are injected by `Button`, so the linter cannot see them.
              aria-label={SUPPORT_CHANNEL_NAMES.discord}
              href={sanitizeHref(COMMUNITY_FORUM_URL)}
              rel="noreferrer noopener"
              target="_blank"
            />
          }
          size="sm"
          variant="secondary"
        >
          <DiscordLogoIcon />
          <bdi>{SUPPORT_CHANNEL_NAMES.discord}</bdi>
        </Button>
        <Button
          className="min-w-0"
          render={
            <a
              aria-label={SUPPORT_CHANNEL_NAMES.github}
              href={sanitizeHref(GITHUB_FEEDBACK_URL)}
              rel="noreferrer noopener"
              target="_blank"
            />
          }
          size="sm"
          variant="secondary"
        >
          <GitHubLogoIcon />
          <bdi>{SUPPORT_CHANNEL_NAMES.github}</bdi>
        </Button>
        <Button
          className="min-w-0"
          render={
            <a
              aria-label={t("common.documentation")}
              href={sanitizeHref(TECHNICAL_DOCS_URL)}
              rel="noreferrer noopener"
              target="_blank"
            />
          }
          size="sm"
          variant="secondary"
        >
          <BookOpenIcon />
          {t("common.documentation")}
        </Button>
      </div>
      <div className="border-border flex justify-center border-t pt-2">
        <Button
          render={
            <a
              aria-label={t("guides.community.personalSupport")}
              href={`mailto:${CONTACT_EMAIL}`}
            />
          }
          size="sm"
          variant="secondary"
        >
          <MailIcon />
          {t("guides.community.personalSupport")}
        </Button>
      </div>
    </SheetFooter>
  );
};
