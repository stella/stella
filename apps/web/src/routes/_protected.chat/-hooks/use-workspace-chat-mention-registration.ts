import { useEffect } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { useChatEditorExtensions } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { getMentionViewScope } from "@/components/chat-mention-helpers";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import {
  getEntityName,
  getFirstFile,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

const getWorkspaceMentionExtensionId = (workspaceId: string) =>
  `workspace-chat:entity-mentions:${workspaceId}`;
const protectedRouteApi = getRouteApi("/_protected");

export const useWorkspaceChatMentionRegistration = (
  workspaceId: string,
  viewId?: string,
) => {
  const { registerExtension } = useChatEditorExtensions();
  const routeContext = protectedRouteApi.useRouteContext({
    select: (ctx) => ({
      authToken: ctx.authToken,
      organizationId: ctx.user.activeOrganizationId,
    }),
  });
  const { data: activeView } = useQuery({
    ...viewsOptions({
      key: { workspaceId },
      context: routeContext,
    }),
    select: (data) =>
      data.find((view) => view.id === viewId) ?? data.at(0) ?? null,
  });
  const { filters, sorts } = getMentionViewScope(activeView?.layout);
  const { data } = useQuery({
    ...entitiesOptions({
      workspaceId,
      filters,
      sorts,
      page: 1,
    }),
  });

  useEffect(() => {
    const mentionItems: ChatMentionOption[] = (data?.entities ?? []).map(
      (entity) => {
        const file = getFirstFile(entity);

        return {
          id: entity.entityId,
          label: getEntityName(entity),
          category: "entity",
          kind: entity.kind,
          mimeType: file?.mimeType ?? null,
        };
      },
    );

    const extensionId = getWorkspaceMentionExtensionId(workspaceId);
    const unregister = registerExtension(extensionId, {
      mentionSources: [
        {
          id: extensionId,
          getItems: () => mentionItems,
        },
      ],
    });

    return () => {
      unregister();
    };
  }, [data?.entities, registerExtension, workspaceId]);
};
