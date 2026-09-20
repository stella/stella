import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type { PlaybookSaveMessage } from "@/components/chat/chat-ui-tools";
import { reconcilePlaybookSaveToolCalls } from "@/features/chat/hooks/use-chat-session-playbook-save.logic";
import { knowledgeKeys } from "@/lib/knowledge/queries";

const ORGANIZATION_ID = "org-1";
const PLAYBOOK_ID = "playbook-1";

const saveMessages = ({
  output,
  state = "complete",
}: {
  output: Record<string, unknown>;
  state?: string;
}): PlaybookSaveMessage[] => [
  {
    id: "message-1",
    parts: [
      {
        id: "tool-call-1",
        input: { name: "NDA playbook" },
        name: "save_playbook",
        output,
        state,
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
];

const LIST_QUERY_KEYS = [
  knowledgeKeys.playbooks.list(ORGANIZATION_ID, { limit: 50 }),
  knowledgeKeys.playbooks.recent(ORGANIZATION_ID, { limit: 5 }),
];
const DETAIL_KEY = knowledgeKeys.playbooks.detail(ORGANIZATION_ID, PLAYBOOK_ID);
const PLAYBOOK_QUERY_KEYS = [...LIST_QUERY_KEYS, DETAIL_KEY];
const OTHER_ORGANIZATION_KEY = knowledgeKeys.playbooks.detail(
  "org-2",
  PLAYBOOK_ID,
);

const seededQueryClient = () => {
  const queryClient = new QueryClient();
  for (const queryKey of [...PLAYBOOK_QUERY_KEYS, OTHER_ORGANIZATION_KEY]) {
    queryClient.setQueryData(queryKey, { seeded: true });
  }
  return queryClient;
};

const isInvalidated = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) => queryClient.getQueryState(queryKey)?.isInvalidated ?? false;

const cachedData = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
): unknown => queryClient.getQueryData(queryKey);

const reconcile = async ({
  handledToolCallIds = new Set<string>(),
  messages,
  queryClient,
}: {
  handledToolCallIds?: Set<string>;
  messages: PlaybookSaveMessage[];
  queryClient: QueryClient;
}) => {
  await reconcilePlaybookSaveToolCalls({
    handledToolCallIds,
    messages,
    organizationId: ORGANIZATION_ID,
    playbookKeys: knowledgeKeys.playbooks,
    queryClient,
  });
};

describe("playbook save cache reconciliation", () => {
  test("a completed save invalidates this organization's lists and drops its unwatched details", async () => {
    const queryClient = seededQueryClient();

    await reconcile({
      messages: saveMessages({ output: { playbookId: PLAYBOOK_ID } }),
      queryClient,
    });

    for (const queryKey of LIST_QUERY_KEYS) {
      expect(isInvalidated(queryClient, queryKey)).toBe(true);
    }
    // Dropped, not invalidated: an invalidated detail would still seed the
    // editor's form with the positions from before the save.
    expect(cachedData(queryClient, DETAIL_KEY)).toBeUndefined();
    expect(cachedData(queryClient, OTHER_ORGANIZATION_KEY)).toEqual({
      seeded: true,
    });
    expect(isInvalidated(queryClient, OTHER_ORGANIZATION_KEY)).toBe(false);
  });

  test("a detail the editor or the inspector is watching is refetched", async () => {
    const queryClient = seededQueryClient();
    // Invalidating a watched query refetches it at once, which clears its
    // invalidated flag again, so the refetch itself is what is observable.
    let refetches = 0;
    const unsubscribe = new QueryObserver(queryClient, {
      queryKey: DETAIL_KEY,
      queryFn: () => {
        refetches += 1;
        return { refetched: true };
      },
      staleTime: Infinity,
    }).subscribe(() => undefined);

    await reconcile({
      messages: saveMessages({ output: { playbookId: PLAYBOOK_ID } }),
      queryClient,
    });
    unsubscribe();

    expect(refetches).toBe(1);
    expect(cachedData(queryClient, DETAIL_KEY)).toEqual({ refetched: true });
  });

  test("a refused or unfinished save invalidates nothing", async () => {
    for (const messages of [
      saveMessages({ output: { error: { code: "conflict" } } }),
      saveMessages({
        output: { playbookId: PLAYBOOK_ID },
        state: "input-streaming",
      }),
    ]) {
      const queryClient = seededQueryClient();

      await reconcile({ messages, queryClient });

      for (const queryKey of PLAYBOOK_QUERY_KEYS) {
        expect(isInvalidated(queryClient, queryKey)).toBe(false);
      }
    }
  });

  test("a save is handled once, however often the transcript re-renders", async () => {
    const handledToolCallIds = new Set<string>();
    const messages = saveMessages({ output: { playbookId: PLAYBOOK_ID } });
    await reconcile({
      handledToolCallIds,
      messages,
      queryClient: seededQueryClient(),
    });
    const queryClient = seededQueryClient();

    await reconcile({ handledToolCallIds, messages, queryClient });

    for (const queryKey of PLAYBOOK_QUERY_KEYS) {
      expect(isInvalidated(queryClient, queryKey)).toBe(false);
    }
  });
});
