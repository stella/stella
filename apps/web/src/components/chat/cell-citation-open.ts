import type { QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter, useNavigate } from "@tanstack/react-router";

import type { ChatCellCitationTarget } from "@stll/api-contract";

import { cellCitationFields } from "@/components/chat/cell-citation-open.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { getTranslator } from "@/i18n/i18n-store";
import { APIError } from "@/lib/errors/api";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { ensureRouteQueryData } from "@/lib/react-query";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { justificationsOptions } from "@/lib/workspaces/queries/workspace";
import { getCurrentWorkspaceView } from "@/lib/workspaces/use-workspace-view-params";
import { cellCitationViewId } from "@/lib/workspaces/view-layout";

type OpenCellCitationOptions = {
  navigate: ReturnType<typeof useNavigate>;
  queryClient: QueryClient;
  router: Pick<RegisteredRouter, "state">;
  target: ChatCellCitationTarget;
};

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
  try {
    const [views, entity, justifications] = await Promise.all([
      ensureRouteQueryData(queryClient, viewsOptions(workspaceId)),
      ensureRouteQueryData(queryClient, entityOptions(workspaceId, entityId)),
      ensureRouteQueryData(
        queryClient,
        justificationsOptions({ workspaceId, entityIds: [entityId] }),
      ),
    ]);
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
  } catch (error) {
    if (APIError.is(error) && error.status === 404) {
      notifyUserProblem(t("chat.cellCitationUnavailable"));
      return;
    }
    notifyUserError(error, t("errors.actionFailed"));
  }
};
