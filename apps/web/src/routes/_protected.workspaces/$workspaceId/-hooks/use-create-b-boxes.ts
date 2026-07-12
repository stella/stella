import { useCallback, useRef } from "react";

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceJustification } from "@/lib/types";
import { aiAvailabilityOptions } from "@/routes/_protected.organization/-ai-config-queries";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

type UseCreateBBoxesProps = {
  workspaceId: string;
  justification: WorkspaceJustification;
};

const CREATE_BBOXES_MUTATION_KEY = "create-bounding-boxes";

export const useCreateBBoxes = ({
  workspaceId,
  justification,
}: UseCreateBBoxesProps) => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: aiAvailability } = useQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  const pendingMutationsCount = useIsMutating({
    mutationKey: [CREATE_BBOXES_MUTATION_KEY],
  });
  const inflightSetRef = useRef<Set<string> | null>(null);
  inflightSetRef.current ??= new Set<string>();
  const inflight = inflightSetRef.current;

  const mutation = useMutation({
    scope: {
      id: justification.id,
    },
    mutationKey: [CREATE_BBOXES_MUTATION_KEY],
    mutationFn: async () => {
      if (justification.boundingBoxes || inflight.has(justification.id)) {
        return undefined;
      }

      inflight.add(justification.id);

      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["bounding-boxes"].post({
          queryKey: workspaceKeys.justifications(workspaceId),
          justificationId: toSafeId<"justification">(justification.id),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.justifications(workspaceId),
      });
    },
    onSettled: () => {
      inflight.delete(justification.id);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  // Latest-value refs kept in sync during render so the returned stable
  // useCallback (deps: [aiAvailability?.available]) reads the freshest
  // pendingMutationsCount + mutation.mutate without being recreated on every
  // mutation; a stable callback identity is load-bearing for consumers.
  /* eslint-disable react/react-compiler -- deliberate latest-value ref writes during render, see comment above */
  const pendingRef = useRef(pendingMutationsCount);
  pendingRef.current = pendingMutationsCount;
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;
  /* eslint-enable react/react-compiler */

  return useCallback(() => {
    if (!aiAvailability?.available) {
      return;
    }

    if (pendingRef.current > 0) {
      return;
    }

    mutateRef.current();
  }, [aiAvailability?.available]);
};

export const useIsCreatingBBoxes = () => {
  const count = useIsMutating({
    mutationKey: [CREATE_BBOXES_MUTATION_KEY],
  });

  return count > 0;
};
