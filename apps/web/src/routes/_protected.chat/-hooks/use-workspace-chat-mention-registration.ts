import { useRef } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";

import { useChatEditorExtensions } from "@/components/chat-editor-provider";
import type { ChatMentionOption } from "@/components/chat-mention-extension";
import {
  buildEntityMentionOption,
  CHAT_MENTION_ENTITY_RESULT_LIMIT,
  CHAT_MENTION_SEARCH_DEBOUNCE_MS,
  getMentionViewScope,
} from "@/components/chat-mention-helpers";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { WorkspaceEntity } from "@/lib/types";
import { entitiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

const getWorkspaceMentionExtensionId = (workspaceId: string) =>
  `workspace-chat:entity-mentions:${workspaceId}`;

type EntityMentionPage = {
  entities: WorkspaceEntity[];
};

const toEntityMentionOptions = ({
  data,
  workspaceId,
}: {
  data: EntityMentionPage;
  workspaceId: string;
}) =>
  data.entities.map((entity) =>
    buildEntityMentionOption({ entity, sourceWorkspaceId: workspaceId }),
  );

export const useWorkspaceChatMentionRegistration = (
  workspaceId: string,
  viewId?: string,
) => {
  const { registerExtension } = useChatEditorExtensions();
  const queryClient = useQueryClient();
  const pendingSearchRef = useRef<{
    queryKey: QueryKey | null;
    resolve: (items: ChatMentionOption[]) => void;
  } | null>(null);
  const { data: activeView } = useQuery({
    ...viewsOptions(workspaceId),
    select: (data) =>
      data.find((view) => view.id === viewId) ?? data.at(0) ?? null,
  });
  const { filters, sorts } = getMentionViewScope(activeView?.layout);
  const createSearchOptions = (query: string) => {
    const search = query.trim();
    return entitiesOptions({
      workspaceId,
      filters,
      sorts,
      ...(search && { search }),
      page: 1,
      pageSize: CHAT_MENTION_ENTITY_RESULT_LIMIT,
    });
  };
  const searchEntities = async (query: string) => {
    const options = createSearchOptions(query);
    if (pendingSearchRef.current) {
      pendingSearchRef.current.queryKey = options.queryKey;
    }
    const data = await queryClient.fetchQuery(options);

    return toEntityMentionOptions({ data, workspaceId });
  };
  const debouncedSearchEntities = useDebouncedCallback(
    async ({
      query,
      resolve,
    }: {
      query: string;
      resolve: (items: ChatMentionOption[]) => void;
    }) => {
      try {
        const items = await searchEntities(query);
        if (pendingSearchRef.current?.resolve !== resolve) {
          return;
        }

        pendingSearchRef.current = null;
        resolve(items);
      } catch {
        if (pendingSearchRef.current?.resolve !== resolve) {
          return;
        }

        pendingSearchRef.current = null;
        resolve([]);
      }
    },
    CHAT_MENTION_SEARCH_DEBOUNCE_MS,
  );
  const searchMentionItems = async (query: string) => {
    const previous = pendingSearchRef.current;
    if (previous) {
      debouncedSearchEntities.cancel();
      pendingSearchRef.current = null;
      if (previous.queryKey) {
        await queryClient.cancelQueries({
          exact: true,
          queryKey: previous.queryKey,
        });
      }
    }

    const options = createSearchOptions(query);
    const cachedData = queryClient.getQueryData<EntityMentionPage>(
      options.queryKey,
    );
    if (cachedData) {
      return toEntityMentionOptions({ data: cachedData, workspaceId });
    }

    return await new Promise<ChatMentionOption[]>((resolve) => {
      pendingSearchRef.current = { queryKey: null, resolve };
      void debouncedSearchEntities({ query, resolve });
    });
  };

  // Tear down the in-flight debounced search whenever its identity changes
  // or the hook unmounts: cancel the pending timer and settle the dangling
  // promise so awaiters don't hang. This is lifecycle management of the
  // debounce timer (an external system), keyed on the debounced callback.
  useExternalSyncEffect(
    () => () => {
      debouncedSearchEntities.cancel();
      pendingSearchRef.current?.resolve([]);
      pendingSearchRef.current = null;
    },
    [debouncedSearchEntities],
  );

  useExternalSyncEffect(() => {
    const extensionId = getWorkspaceMentionExtensionId(workspaceId);
    const unregister = registerExtension(extensionId, {
      mentionSources: [
        {
          id: extensionId,
          getItems: () => [],
          searchItems: searchMentionItems,
        },
      ],
    });

    return () => {
      unregister();
    };
  }, [registerExtension, searchMentionItems, workspaceId]);
};
