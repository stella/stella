import { useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as v from "valibot";

import {
  GUIDE_TOUR_STATUSES,
  type GuideTour,
  type GuideTourId,
  type GuideTourStatus,
} from "@/features/guides/guide-types";
import { sessionOptions } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";
import { readStoredJson } from "@/lib/stored-json";

// Progress is the source of truth in the DB: it rides the `["session"]` query
// (`user.guideProgress`, a serialized JSON map), so reads add no request and it
// follows the user across devices. Writes go through `authClient.updateUser`.

const guideProgressSchema = v.record(
  v.string(),
  v.picklist([
    GUIDE_TOUR_STATUSES.notStarted,
    GUIDE_TOUR_STATUSES.completed,
    GUIDE_TOUR_STATUSES.skipped,
  ]),
);

type StoredGuideProgress = v.InferOutput<typeof guideProgressSchema>;

// Parse the serialized blob at the boundary; an unknown/stale shape falls back
// to "no progress" exactly like a missing value.
export const parseGuideProgress = (
  raw: string | null | undefined,
): StoredGuideProgress =>
  readStoredJson(raw ?? null, guideProgressSchema) ?? {};

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
  isSaving: boolean;
};

export const useOnboardingProgress = (
  tours: readonly GuideTour[],
): OnboardingProgress => {
  const queryClient = useQueryClient();
  const { data } = useQuery(sessionOptions);

  const stored = useMemo(
    () => parseGuideProgress(data?.user.guideProgress),
    [data?.user.guideProgress],
  );

  const mutation = useMutation({
    mutationFn: async (next: StoredGuideProgress) => {
      const { authClient } = await import("@/lib/auth");
      const { error } = await authClient.updateUser({
        guideProgress: JSON.stringify(next),
      });
      if (error) {
        throw toAuthClientError(error);
      }
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: sessionOptions.queryKey });
      const previous = queryClient.getQueryData(sessionOptions.queryKey);
      const serialized = JSON.stringify(next);
      queryClient.setQueryData(sessionOptions.queryKey, (current) =>
        current
          ? { ...current, user: { ...current.user, guideProgress: serialized } }
          : current,
      );
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(sessionOptions.queryKey, context.previous);
      }
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
    mutation.mutate({ ...stored, [tourId]: status });
  };

  return {
    statusFor,
    resolvedCount: countResolvedTours(tours, stored),
    totalCount: tours.length,
    setTourStatus,
    isSaving: mutation.isPending,
  };
};
