import type { QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";

import { RESOURCE_TYPE } from "@stll/api-contract";
import type { ChatCellCitationTarget } from "@stll/api-contract";

import { cellCitationFields } from "@/components/chat/cell-citation-open.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { getTranslator } from "@/i18n/i18n-store";
import { APIError } from "@/lib/errors/api";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { ensureRouteQueryData } from "@/lib/react-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { justificationsOptions } from "@/lib/workspaces/queries/workspace";
import { getCurrentWorkspaceView } from "@/lib/workspaces/use-workspace-view-params";
import {
  cellCitationColumnHidden,
  cellCitationViewId,
} from "@/lib/workspaces/view-layout";

type OpenCellCitationOptions = {
  navigate: ReturnType<typeof useNavigate>;
  queryClient: QueryClient;
  router: Pick<RegisteredRouter, "state">;
  target: ChatCellCitationTarget;
};

let latestOpen = 0;

/** Open the matter's review table on a cited cell, with the document its
 * value was extracted from open on that value's evidence. A document or
 * column removed since the answer was written gets a notice instead. */
export const openCellCitation = async ({
  navigate,
  queryClient,
  router,
  target: { entityId, propertyId, workspaceId },
}: OpenCellCitationOptions): Promise<void> => {
  const t = getTranslator();
  const open = ++latestOpen;
  const opened = await Result.tryPromise({
    try: async () => {
      const [views, entity, justifications] = await Promise.all([
        ensureRouteQueryData(
          queryClient,
          resourceQueryOptions(viewsOptions(workspaceId), {
            resources: [RESOURCE_TYPE.WORKSPACE_VIEW],
            scope: { type: "workspace", workspaceId },
          }),
        ),
        ensureRouteQueryData(
          queryClient,
          resourceQueryOptions(
            { ...entityOptions(workspaceId, entityId), staleTime: 0 },
            {
              resources: [
                RESOURCE_TYPE.ENTITY,
                RESOURCE_TYPE.FIELD,
                RESOURCE_TYPE.PROPERTY,
              ],
              scope: { type: "workspace", workspaceId },
            },
          ),
        ),
        ensureRouteQueryData(
          queryClient,
          resourceQueryOptions(
            justificationsOptions({ workspaceId, entityIds: [entityId] }),
            {
              resources: [RESOURCE_TYPE.FIELD],
              scope: { type: "workspace", workspaceId },
            },
          ),
        ),
      ]);
      if (open !== latestOpen) {
        return;
      }
      const fields = cellCitationFields({
        fields: entity.fields,
        justifications,
        propertyId,
      });
      const viewId = cellCitationViewId(
        views,
        propertyId,
        getCurrentWorkspaceView(router.state.matches)?.viewId,
      );
      if (fields === null || viewId === null) {
        notifyUserProblem(t("chat.cellCitationUnavailable"));
        return;
      }
      await navigate({
        to: "/workspaces/$workspaceId/$viewId",
        params: { workspaceId, viewId },
      });
      if (open !== latestOpen) {
        return;
      }
      if (cellCitationColumnHidden(views, viewId, propertyId)) {
        notifyUserProblem(t("chat.cellCitationColumnHidden"));
      }
      const { cell, file } = fields;
      if (file?.content.type !== "file") {
        return;
      }
      useInspectorTabsStore.getState().openFile({
        id: file.id,
        entityId,
        label: file.content.fileName,
        fileName: file.content.fileName,
        mimeType: file.content.mimeType,
        pdfFileId: file.content.pdfFileId,
        justificationFieldId: cell.id,
        propertyId: file.propertyId,
        workspaceId,
      });
    },
    catch: (cause) => cause,
  });
  if (opened.isOk()) {
    return;
  }
  const error = opened.error;
  if (APIError.is(error) && error.status === 404) {
    notifyUserProblem(t("chat.cellCitationUnavailable"));
    return;
  }
  notifyUserError(error, t("errors.actionFailed"));
};
