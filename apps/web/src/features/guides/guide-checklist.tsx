import { CheckIcon, ClockIcon, ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import { GuideTourPreview } from "@/features/guides/guide-tour-preview";
import {
  GUIDE_TOUR_STATUSES,
  type GuideTour,
  type GuideTourId,
  type GuideTourStatus,
} from "@/features/guides/guide-types";
import type { OnboardingProgress } from "@/features/guides/use-onboarding-progress";
import { useFormatter } from "@/i18n/formatting-context";
import { COMMUNITY_FORUM_URL } from "@/lib/consts";
import { sanitizeHref } from "@/lib/sanitize-href";

type GuideChecklistProps = {
  tours: readonly GuideTour[];
  progress: OnboardingProgress;
  activeTourId: GuideTourId | null;
  onStart: (tour: GuideTour) => void;
};

export const GuideChecklistSkeleton = ({
  tourCount,
}: {
  tourCount: number;
}) => (
  <div aria-busy="true" className="flex flex-col gap-4">
    <div aria-hidden="true" className="flex flex-col gap-2">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
    <div aria-hidden="true" className="flex flex-col gap-2">
      {Array.from({ length: tourCount }, (_, index) => (
        <div
          className="border-border flex gap-3 rounded-lg border p-3"
          key={`guide-checklist-skeleton-${index}`}
        >
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <Skeleton className="h-16 w-20 rounded-md" />
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <div className="flex gap-2">
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-8 w-14" />
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const GuideChecklist = ({
  tours,
  progress,
  activeTourId,
  onStart,
}: GuideChecklistProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const { resolvedCount, totalCount } = progress;
  const fraction = totalCount > 0 ? resolvedCount / totalCount : 0;

  if (tours.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3" role="status">
        <p className="text-muted-foreground text-sm">
          {t("guides.unavailable")}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("guides.community.body")}
        </p>
        <Button
          render={
            <a
              aria-label={t("guides.community.linkLabel")}
              href={sanitizeHref(COMMUNITY_FORUM_URL)}
              rel="noreferrer noopener"
              target="_blank"
            />
          }
          size="sm"
          variant="secondary"
        >
          {t("guides.community.linkLabel")}
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">
          {t("guides.checklist.progress", {
            completed: format.number(resolvedCount),
            total: format.number(totalCount),
          })}
        </p>
        <div
          aria-hidden="true"
          className="bg-border h-1.5 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-foreground h-full rounded-full"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {tours.map((tour) => (
          <GuideTourCard
            key={tour.id}
            disabled={
              activeTourId !== null || progress.isSaving || !progress.isReady
            }
            onSkip={() =>
              progress.setTourStatus(tour.id, GUIDE_TOUR_STATUSES.skipped)
            }
            onStart={() => onStart(tour)}
            status={progress.statusFor(tour.id)}
            tour={tour}
          />
        ))}
      </ul>
    </div>
  );
};

type GuideTourCardProps = {
  tour: GuideTour;
  status: GuideTourStatus;
  disabled: boolean;
  onStart: () => void;
  onSkip: () => void;
};

const GuideStatusBadge = ({ status }: { status: GuideTourStatus }) => {
  const t = useTranslations();
  switch (status) {
    case "not-started":
      return null;
    case "completed":
      return (
        <span className="text-success inline-flex items-center gap-1 text-xs">
          <CheckIcon className="size-3" />
          {t("common.done")}
        </span>
      );
    case "skipped":
      return (
        <span className="text-muted-foreground text-xs">
          {t("guides.status.skipped")}
        </span>
      );
    default:
      status satisfies never;
      return null;
  }
};

const GuideTourCard = ({
  tour,
  status,
  disabled,
  onStart,
  onSkip,
}: GuideTourCardProps) => {
  const t = useTranslations();
  const format = useFormatter();

  const cta = (() => {
    switch (status) {
      case "not-started":
        return (
          <>
            <Button disabled={disabled} onClick={onStart} size="sm">
              {t("guides.action.start")}
            </Button>
            <Button
              disabled={disabled}
              onClick={onSkip}
              size="sm"
              variant="ghost"
            >
              {t("guides.action.skip")}
            </Button>
          </>
        );
      case "completed":
        return (
          <Button
            disabled={disabled}
            onClick={onStart}
            size="sm"
            variant="secondary"
          >
            {t("guides.action.replay")}
          </Button>
        );
      case "skipped":
        return (
          <Button disabled={disabled} onClick={onStart} size="sm">
            {t("guides.action.start")}
          </Button>
        );
      default:
        status satisfies never;
        return null;
    }
  })();

  return (
    <li className="border-border flex gap-3 rounded-lg border p-3">
      {/* The run length belongs to the thumbnail, the way a clip's duration
          sits under its poster; on a narrow drawer the preview drops out and
          this column carries the time alone. */}
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <GuideTourPreview tourId={tour.id} />
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <ClockIcon className="size-3" />
          {t("guides.minutes", { count: format.number(tour.estMinutes) })}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">{t(tour.titleKey)}</p>
          <GuideStatusBadge status={status} />
        </div>
        <p className="text-muted-foreground text-xs">
          {t(tour.descriptionKey)}
        </p>
        <div className="flex items-center gap-2">{cta}</div>
      </div>
    </li>
  );
};
