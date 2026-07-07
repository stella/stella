import { createContext, use, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { buildWorkspaceMentionOptions } from "@/components/chat-mention-helpers";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

type MentionProviders = {
  getItems: (
    categories: MentionCategory[],
  ) => ChatMentionOption[] | Promise<ChatMentionOption[]>;
};

const MentionProvidersContext = createContext<MentionProviders>({
  getItems: () => [],
});

export const useMentionProviders = () => use(MentionProvidersContext);

type MentionWorkspace = {
  id: string;
  name: string;
};

const firstViewIdsByWorkspaceIdOptions = ({
  queryClient,
  workspaces,
}: {
  queryClient: QueryClient;
  workspaces: MentionWorkspace[];
}) => ({
  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- the query client is an app-scope dependency, not part of this query's cache identity.
  queryKey: [
    "chat-mention-workspace-views",
    workspaces.map((workspace) => workspace.id),
  ],
  queryFn: async () => {
    const viewEntries = await Promise.all(
      workspaces.map(async (workspace) => {
        const views = await queryClient.ensureQueryData(
          viewsOptions(workspace.id),
        );

        return [workspace.id, views.at(0)?.id ?? null] as const;
      }),
    );

    return Object.fromEntries(viewEntries);
  },
});

/** Provides org-level mention sources to any ChatEditor below. */
export const ChatMentionProviders = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  // Defer the per-workspace first-view-id prefetch (one GET /views per
  // workspace) until a workspace @-mention is actually requested, so it
  // doesn't storm the network on initial page load.
  const [workspaceMentionsRequested, setWorkspaceMentionsRequested] =
    useState(false);
  const { data: workspacesData } = useChromeQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );
  const workspaces = workspacesData?.workspaces;
  const { data: firstViewIdsByWorkspaceId } = useChromeQuery({
    ...firstViewIdsByWorkspaceIdOptions({
      queryClient,
      workspaces: workspaces ?? [],
    }),
    enabled:
      workspaceMentionsRequested &&
      workspaces !== undefined &&
      workspaces.length > 0,
  });

  const value: MentionProviders = {
    getItems: async (categories) => {
      const items: ChatMentionOption[] = [];

      if (categories.includes("workspace")) {
        if (!workspaceMentionsRequested) {
          setWorkspaceMentionsRequested(true);
        }
        if (workspaces) {
          const viewIdsByWorkspaceId =
            firstViewIdsByWorkspaceId ??
            (await queryClient.ensureQueryData(
              firstViewIdsByWorkspaceIdOptions({ queryClient, workspaces }),
            ));
          items.push(
            ...buildWorkspaceMentionOptions({
              firstViewIdsByWorkspaceId: viewIdsByWorkspaceId,
              workspaces,
            }),
          );
        }
      }

      return items;
    },
  };

  return (
    <MentionProvidersContext value={value}>{children}</MentionProvidersContext>
  );
};
