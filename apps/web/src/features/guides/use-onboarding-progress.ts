import { useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { stellaToast } from "@stll/ui/toast";

import {
  GUIDE_TOUR_IDS,
  GUIDE_TOUR_STATUSES,
  type GuideTour,
  type GuideTourId,
  type GuideTourStatus,
} from "@/features/guides/guide-types";
import { api } from "@/lib/api";
import { sessionOptions } from "@/lib/auth-queries";
import { unwrapEden } from "@/lib/errors/api";
import { readStoredJson } from "@/lib/stored-json";

// Progress is the source of truth in the DB: it rides the `["session"]` query
// (`user.guideProgress`, a serialized JSON map), so reads add no request and it
// follows the user across devices. Writes patch one key atomically through the
// authenticated API so concurrent tabs/devices cannot overwrite each other.

// Read as an open record and validated entry by entry, deliberately: the blob
// is written by whichever build the user last ran, so a newer release adding a
// status must not make an older client read the whole map as empty. Rejecting
// wholesale would be silent data loss rather than caution, because the very
// next `setTourStatus` persists whatever was read.
const storedBlobSchema = v.record(v.string(), v.unknown());

const guideTourStatusSchema = v.picklist([
  GUIDE_TOUR_STATUSES.notStarted,
  GUIDE_TOUR_STATUSES.completed,
  GUIDE_TOUR_STATUSES.skipped,
]);

type StoredGuideProgress = Partial<Record<GuideTourId, GuideTourStatus>>;

// Every key/value pair the current build understands, and nothing else.
export const parseGuideProgress = (
  raw: string | null | undefined,
): StoredGuideProgress => {
  const blob = readStoredJson(raw ?? null, storedBlobSchema);
  if (!blob) {
    return {};
  }
  const progress: StoredGuideProgress = {};
  for (const [tourId, status] of Object.entries(blob)) {
    const parsedStatus = v.safeParse(guideTourStatusSchema, status);
    if (isGuideTourId(tourId) && parsedStatus.success) {
      progress[tourId] = parsedStatus.output;
    }
  }
  return progress;
};

const isGuideTourId = (value: string): value is GuideTourId =>
  Object.values(GUIDE_TOUR_IDS).some((id) => id === value);

export const countResolvedTours = (
  tours: readonly GuideTour[],
  stored: StoredGuideProgress,
): number =>
  tours.filter(
    (tour) =>
      (stored[tour.id] ?? GUIDE_TOUR_STATUSES.notStarted) !==
      GUIDE_TOUR_STATUSES.notStarted,
  ).length;

export type OnboardingProgress = {
  statusFor: (tourId: GuideTourId) => GuideTourStatus;
  resolvedCount: number;
  totalCount: number;
  setTourStatus: (tourId: GuideTourId, status: GuideTourStatus) => void;
  isReady: boolean;
  isSaving: boolean;
};

export const useOnboardingProgress = (
  tours: readonly GuideTour[],
): OnboardingProgress => {
  const queryClient = useQueryClient();
  const t = useTranslations();
  const { data } = useQuery(sessionOptions);

  const stored = useMemo(
    () => parseGuideProgress(data?.user.guideProgress),
    [data?.user.guideProgress],
  );
  const mutation = useMutation({
    mutationFn: async ({
      tourId,
      status,
    }: {
      tourId: GuideTourId;
      status: GuideTourStatus;
    }) => {
      const response = await api.me["guide-progress"].patch({
        tourId,
        status,
      });
      return unwrapEden(response);
    },
    onSuccess: ({ guideProgress }) => {
      queryClient.setQueryData(sessionOptions.queryKey, (current) =>
        current
          ? { ...current, user: { ...current.user, guideProgress } }
          : current,
      );
    },
    onError: () => {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: sessionOptions.queryKey,
      });
    },
  });

  const statusFor = (tourId: GuideTourId): GuideTourStatus =>
    stored[tourId] ?? GUIDE_TOUR_STATUSES.notStarted;

  const setTourStatus = (tourId: GuideTourId, status: GuideTourStatus) => {
    mutation.mutate({ tourId, status });
  };

  return {
    statusFor,
    resolvedCount: countResolvedTours(tours, stored),
    totalCount: tours.length,
    setTourStatus,
    isReady: data !== undefined,
    isSaving: mutation.isPending,
  };
};
