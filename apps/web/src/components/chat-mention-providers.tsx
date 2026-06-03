import { createContext, use, useMemo } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { buildWorkspaceMentionOptions } from "@/components/chat-mention-helpers";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

type MentionProviders = {
  getItems: (categories: MentionCategory[]) => ChatMentionOption[];
};

const MentionProvidersContext = createContext<MentionProviders>({
  getItems: () => [],
});

export const useMentionProviders = () => use(MentionProvidersContext);

/** Provides org-level mention sources to any ChatEditor below. */
export const ChatMentionProviders = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: workspacesData } = useQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );
  const workspaces = workspacesData?.workspaces;
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the query client is an app-scope dependency, not part of this query's cache identity.
  const { data: firstViewIdsByWorkspaceId } = useQuery({
    queryKey: [
      "chat-mention-workspace-views",
      (workspaces ?? []).map((workspace) => workspace.id),
    ],
    queryFn: async () => {
      const viewEntries = await Promise.all(
        (workspaces ?? []).map(async (workspace) => {
          const views = await queryClient.ensureQueryData(
            viewsOptions(workspace.id),
          );

          return [workspace.id, views.at(0)?.id ?? null] as const;
        }),
      );

      return Object.fromEntries(viewEntries);
    },
    enabled: workspaces !== undefined && workspaces.length > 0,
  });

  const value = useMemo<MentionProviders>(
    () => ({
      getItems: (categories) => {
        const items: ChatMentionOption[] = [];

        if (categories.includes("workspace") && workspaces) {
          items.push(
            ...buildWorkspaceMentionOptions({
              firstViewIdsByWorkspaceId,
              workspaces,
            }),
          );
        }

        return items;
      },
    }),
    [firstViewIdsByWorkspaceId, workspaces],
  );

  return (
    <MentionProvidersContext value={value}>{children}</MentionProvidersContext>
  );
};
