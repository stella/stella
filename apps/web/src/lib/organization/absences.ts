import {
  infiniteQueryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { WebApiRoutes } from "@/lib/eden-client";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { stringCursorSeed } from "@/lib/infinite-query";
import { myTimeEntriesKeys } from "@/lib/workspaces/queries/my-time-entries";

export type AbsenceRequest = WebApiRoutes["absences"]["post"]["body"];
export type AbsenceEntry =
  WebApiRoutes["absences"]["mine"]["get"]["response"][200]["items"][number];

const ABSENCE_PAGE_SIZE = 50;

export const absencesKeys = {
  all: (organizationId: string) => ["absences", organizationId],
  mine: (organizationId: string, userId: string) => [
    "absences",
    organizationId,
    userId,
    "mine",
  ],
  approvalQueue: (organizationId: string, userId: string) => [
    "absences",
    organizationId,
    userId,
    "approvalQueue",
  ],
};

export const absencesMineInfiniteOptions = (
  organizationId: string,
  userId: string,
) =>
  infiniteQueryOptions({
    queryKey: absencesKeys.mine(organizationId, userId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api.absences.mine.get({
          query: {
            limit: ABSENCE_PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const absencesApprovalQueueInfiniteOptions = (
  organizationId: string,
  userId: string,
) =>
  infiniteQueryOptions({
    queryKey: absencesKeys.approvalQueue(organizationId, userId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      unwrapEden(
        await api.absences["approval-queue"].get({
          query: {
            limit: ABSENCE_PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

const useAbsenceMutationEffects = (organizationId: string) => {
  const client = useQueryClient();
  const analytics = useAnalytics();
  const t = useTranslations();
  return {
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: absencesKeys.all(organizationId),
        }),
        client.invalidateQueries({
          queryKey: myTimeEntriesKeys.all(organizationId),
        }),
      ]);
    },
    onError: (error: Error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  };
};

export const useRequestAbsence = (organizationId: string) => {
  const effects = useAbsenceMutationEffects(organizationId);
  return useMutation({
    mutationFn: async (body: AbsenceRequest) =>
      unwrapEden(await api.absences.post(body)),
    ...effects,
  });
};

type AbsenceDecision = {
  id: AbsenceEntry["id"];
  version: number;
} & (
  | { action: "approve"; comment: string }
  | { action: "reject"; comment: string }
  | { action: "cancel" }
);

export const useDecideAbsence = (organizationId: string) => {
  const effects = useAbsenceMutationEffects(organizationId);
  return useMutation({
    mutationFn: async (decision: AbsenceDecision) => {
      const endpoint = api.absences({ id: decision.id });
      switch (decision.action) {
        case "approve":
          return unwrapEden(
            await endpoint.approve.post({
              version: decision.version,
              ...(decision.comment.trim()
                ? { comment: decision.comment.trim() }
                : {}),
            }),
          );
        case "reject":
          return unwrapEden(
            await endpoint.reject.post({
              version: decision.version,
              comment: decision.comment.trim(),
            }),
          );
        case "cancel":
          return unwrapEden(
            await endpoint.cancel.post({ version: decision.version }),
          );
        default: {
          decision satisfies never;
          return panic("Unknown absence decision");
        }
      }
    },
    ...effects,
  });
};
