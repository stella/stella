import { useCallback } from "react";

import { useIsMutating, useMutation } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { eventHandler } from "@/lib/rivet";
import type { WorkspaceJustification } from "@/lib/types";
import { useBBoxActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-b-box-actor";
import { workspaceKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

type UseCreateBBoxesProps = {
  justification: WorkspaceJustification;
};

const createBBoxesMutationKey = "create-bounding-boxes";

export const useCreateBBoxes = ({ justification }: UseCreateBBoxesProps) => {
  const analytics = useAnalytics();
  const workspaceId = useParams({
    from: "/_protected/workspaces/$workspaceId",
    select: (s) => s.workspaceId,
  });
  const setPendingBoundingBoxId = useWorkspaceStore(
    (s) => s.setPendingBoundingBoxId,
  );
  const pendingMutationsCount = useIsMutating({
    mutationKey: [createBBoxesMutationKey],
  });
  const bBoxActor = useBBoxActor(workspaceId);

  bBoxActor.useEvent(
    ...eventHandler("b-box-status", (event) => {
      setPendingBoundingBoxId(
        justification.id,
        event.status === "pending" ? "add" : "remove",
      );
    }),
  );

  const mutation = useMutation({
    scope: {
      id: justification.id,
    },
    mutationKey: [createBBoxesMutationKey],
    mutationFn: async () => {
      const store = useWorkspaceStore.getState();

      if (
        justification.boundingBoxes ||
        store.pendingBoundingBoxIds.has(justification.id)
      ) {
        return;
      }

      setPendingBoundingBoxId(justification.id, "add");

      await bBoxActor.handle?.generateBBoxes({
        queryKey: workspaceKeys.justifications(workspaceId),
        justificationId: justification.id,
      });
    },

    onSettled: () => {
      setPendingBoundingBoxId(justification.id, "remove");
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  return useCallback(() => {
    if (pendingMutationsCount > 0) {
      return;
    }

    mutation.mutate();
  }, [pendingMutationsCount, mutation]);
};

export const useIsCreatingBBoxes = () => {
  const justificationId = useSearch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    select: (s) => s.justification?.id,
  });
  const isPending = useWorkspaceStore((s) =>
    justificationId ? s.pendingBoundingBoxIds.has(justificationId) : false,
  );

  return isPending;
};
