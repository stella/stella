import type { PropsWithChildren } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { FileDropZone } from "@/components/file-drop-zone";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useQueryView } from "@/lib/use-query-view";
import type { CreateFileEntitiesInput } from "@/lib/workspaces/mutations/use-create-file-entities";
import { useCreateFileEntities } from "@/lib/workspaces/mutations/use-create-file-entities";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceViews } from "@/lib/workspaces/queries/views.logic";
import type { CachedWorkspaceView } from "@/lib/workspaces/queries/views.logic";

import { uploadWorkspaceDrop } from "./workspace-drop-zone.logic";

type WorkspaceDropZoneProps = PropsWithChildren<{
  workspaceId: string;
}>;

export const WorkspaceDropZone = ({
  workspaceId,
  children,
}: WorkspaceDropZoneProps) => {
  const t = useTranslations();
  const [, createFileEntities] = useCreateFileEntities(workspaceId);
  const queryClient = useQueryClient();
  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const viewsQuery = useQuery(viewsOptions(workspaceId));
  const viewsView = useQueryView(viewsQuery);
  const activeViewId = viewMatch?.params.viewId;
  const currentFolderId = viewMatch?.search.folder;
  const handleDrop = useLatestCallback((input: CreateFileEntitiesInput) => {
    uploadWorkspaceDrop({
      activeViewId,
      currentFolderId,
      input,
      loadViews: async () =>
        selectAvailableWorkspaceViews(
          await ensureWorkspaceViews(queryClient, workspaceId),
        ),
      upload: createFileEntities,
    }).catch((error: unknown) => {
      notifyUserError(
        error instanceof Error ? error : undefined,
        t("errors.uploadFailed"),
      );
    });
  });

  return (
    <FileDropZone
      exceptionScope={{ type: "handler", handlerId: "workspace.files.drop" }}
      coverage="viewport"
      label={t("workspaces.dropToUploadFiles")}
      onDrop={(files) => handleDrop({ files })}
      onDropTree={(tree) => handleDrop({ tree })}
    >
      <QueryViewFeedback view={viewsView} />
      {children}
    </FileDropZone>
  );
};

type ViewsQueryClient = {
  ensureQueryData: (
    options: ReturnType<typeof viewsOptions>,
  ) => Promise<CachedWorkspaceView[]>;
};

async function ensureWorkspaceViews(
  queryClient: ViewsQueryClient,
  workspaceId: string,
): Promise<CachedWorkspaceView[]> {
  return await queryClient.ensureQueryData(viewsOptions(workspaceId));
}
