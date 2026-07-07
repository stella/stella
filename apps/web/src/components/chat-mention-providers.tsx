import { createContext, use } from "react";

import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { buildWorkspaceMentionOptions } from "@/components/chat-mention-helpers";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { getAnalytics } from "@/lib/analytics/provider";
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

const loadFirstViewIdsByWorkspaceId = async ({
  queryClient,
  workspaces,
}: {
  queryClient: QueryClient;
  workspaces: MentionWorkspace[];
}) => {
  const viewEntries = await Promise.all(
    workspaces.map(async (workspace) => {
      const viewsResult = await Result.tryPromise(
        async () =>
          await queryClient.ensureQueryData(viewsOptions(workspace.id)),
      );

      if (Result.isError(viewsResult)) {
        getAnalytics().captureError(viewsResult.error);
        return [workspace.id, null] as const;
      }

      return [workspace.id, viewsResult.value.at(0)?.id ?? null] as const;
    }),
  );

  return Object.fromEntries(viewEntries);
};

/** Provides org-level mention sources to any ChatEditor below. */
export const ChatMentionProviders = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: workspacesData } = useChromeQuery(
    workspacesNavigationOptions(activeOrganizationId),
  );
  const workspaces = workspacesData?.workspaces;

  const value: MentionProviders = {
    getItems: async (categories) => {
      const items: ChatMentionOption[] = [];

      if (categories.includes("workspace")) {
        if (workspaces) {
          const viewIdsByWorkspaceId = await loadFirstViewIdsByWorkspaceId({
            queryClient,
            workspaces,
          });
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
