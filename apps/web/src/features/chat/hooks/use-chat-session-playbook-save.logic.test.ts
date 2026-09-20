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

const PLAYBOOK_QUERY_KEYS = [
  knowledgeKeys.playbooks.list(ORGANIZATION_ID, { limit: 50 }),
  knowledgeKeys.playbooks.recent(ORGANIZATION_ID, { limit: 5 }),
  knowledgeKeys.playbooks.detail(ORGANIZATION_ID, PLAYBOOK_ID),
];
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
  test("a completed save invalidates this organization's list, recent, and detail queries", async () => {
    const queryClient = seededQueryClient();

    await reconcile({
      messages: saveMessages({ output: { playbookId: PLAYBOOK_ID } }),
      queryClient,
    });

    for (const queryKey of PLAYBOOK_QUERY_KEYS) {
      expect(isInvalidated(queryClient, queryKey)).toBe(true);
    }
    expect(isInvalidated(queryClient, OTHER_ORGANIZATION_KEY)).toBe(false);
  });

  test("a detail an open editor is watching is left alone, so its save still meets the conflict", async () => {
    const queryClient = seededQueryClient();
    const detailKey = knowledgeKeys.playbooks.detail(
      ORGANIZATION_ID,
      PLAYBOOK_ID,
    );
    // Invalidating a watched query refetches it at once, which clears its
    // invalidated flag again, so the flag cannot tell the two cases apart.
    // What the editor would see is the refetch itself.
    let refetches = 0;
    const unsubscribe = new QueryObserver(queryClient, {
      queryKey: detailKey,
      queryFn: () => {
        refetches += 1;
        return { seeded: true };
      },
      staleTime: Infinity,
    }).subscribe(() => undefined);

    await reconcile({
      messages: saveMessages({ output: { playbookId: PLAYBOOK_ID } }),
      queryClient,
    });
    unsubscribe();

    expect(refetches).toBe(0);
    expect(
      isInvalidated(
        queryClient,
        knowledgeKeys.playbooks.list(ORGANIZATION_ID, { limit: 50 }),
      ),
    ).toBe(true);
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
