import { useCallback, useRef } from "react";

import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceJustification } from "@/lib/types";
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
        throw new Error("Failed to generate bounding boxes");
      }

      return response.data;
    },
    onSuccess: () => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
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

  // Refs keep callback identity stable — avoids re-triggering
  // effects in PeekJustification that list this as a dependency.
  const pendingRef = useRef(pendingMutationsCount);
  pendingRef.current = pendingMutationsCount;
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(() => {
    if (pendingRef.current > 0) {
      return;
    }

    mutateRef.current();
  }, []);
};

export const useIsCreatingBBoxes = () => {
  const count = useIsMutating({
    mutationKey: [CREATE_BBOXES_MUTATION_KEY],
  });

  return count > 0;
};
