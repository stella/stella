import { useMemo } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { stellaToast } from "@stll/ui/components/toast";

import {
  GUIDE_TOUR_IDS,
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

// Every key/value pair the current build understands, and nothing else. Entries
// this build cannot read are dropped from the parsed view but survive a write,
// because `setTourStatus` merges over the raw blob rather than over this.
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

// The blob as stored, unvalidated. Merged under a write so an entry this build
// cannot read round-trips through it intact instead of being erased.
const readRawProgress = (
  raw: string | null | undefined,
): Record<string, unknown> =>
  readStoredJson(raw ?? null, storedBlobSchema) ?? {};

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
  const t = useTranslations();
  const { data } = useQuery(sessionOptions);

  const stored = useMemo(
    () => parseGuideProgress(data?.user.guideProgress),
    [data?.user.guideProgress],
  );
  const storedRaw = useMemo(
    () => readRawProgress(data?.user.guideProgress),
    [data?.user.guideProgress],
  );

  const mutation = useMutation({
    mutationFn: async (next: Record<string, unknown>) => {
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
      // The optimistic tick has just disappeared from the card. Say why, rather
      // than let the checklist look like it silently refused the click.
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

  // Merged over the raw blob, not the parsed view: a status this build does not
  // recognize stays in the map instead of being dropped by the round trip.
  const setTourStatus = (tourId: GuideTourId, status: GuideTourStatus) => {
    mutation.mutate({ ...storedRaw, [tourId]: status });
  };

  return {
    statusFor,
    resolvedCount: countResolvedTours(tours, stored),
    totalCount: tours.length,
    setTourStatus,
    isSaving: mutation.isPending,
  };
};
