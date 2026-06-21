import { useEffectEvent, useRef } from "react";

import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
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
  const inflightRef = useRef(new Set<string>());

  const mutation = useMutation({
    scope: {
      id: justification.id,
    },
    mutationKey: [CREATE_BBOXES_MUTATION_KEY],
    mutationFn: async () => {
      if (
        justification.boundingBoxes ||
        inflightRef.current.has(justification.id)
      ) {
        return undefined;
      }

      inflightRef.current.add(justification.id);

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
      inflightRef.current.delete(justification.id);
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  return useEffectEvent(() => {
    if (!aiAvailability?.available) {
      return;
    }

    if (pendingMutationsCount > 0) {
      return;
    }

    mutation.mutate();
  });
};

export const useIsCreatingBBoxes = () => {
  const count = useIsMutating({
    mutationKey: [CREATE_BBOXES_MUTATION_KEY],
  });

  return count > 0;
};
