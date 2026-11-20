import { createFileRoute } from "@tanstack/react-router";

import { loadRouteResource } from "@/lib/errors/route-resource";
import { ensureRouteQueryData } from "@/lib/react-query";
import { correspondenceByIdOptions } from "@/lib/workspaces/queries/correspondence";

import { CorrespondenceDetailPage } from "./-correspondence-detail.page";
import { CorrespondenceDetailPending } from "./-correspondence-detail.pending";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/correspondence/$correspondenceId",
)({
  component: CorrespondenceDetailPage,
  loader: async ({ context, params }) => {
    await loadRouteResource({
      ids: [params.workspaceId, params.correspondenceId],
      load: async () =>
        await ensureRouteQueryData(
          context.queryClient,
          correspondenceByIdOptions(
            params.workspaceId,
            params.correspondenceId,
          ),
        ),
    });
  },
  pendingComponent: CorrespondenceDetailPending,
});
