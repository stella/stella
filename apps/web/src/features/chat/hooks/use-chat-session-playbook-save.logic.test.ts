import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type { PlaybookSaveMessage } from "@/components/chat/chat-ui-tools";
import {
  playbookPaneReaction,
  reconcilePlaybookSaveToolCalls,
} from "@/features/chat/hooks/use-chat-session-playbook-save.logic";
import { knowledgeKeys } from "@/lib/knowledge/queries";

const ORGANIZATION_ID = "org-1";
const PLAYBOOK_ID = "playbook-1";
const USER_ID = "user-1";

const saveMessages = ({
  output,
  state = "complete",
  callNumber = 1,
}: {
  output: Record<string, unknown>;
  state?: string;
  callNumber?: number;
}): PlaybookSaveMessage[] => [
  {
    id: `message-${callNumber}`,
    parts: [
      {
        id: `tool-call-${callNumber}`,
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
  knowledgeKeys.playbooks.recent(ORGANIZATION_ID, USER_ID, { limit: 5 }),
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
}) =>
  await reconcilePlaybookSaveToolCalls({
    handledToolCallIds,
    messages,
    organizationId: ORGANIZATION_ID,
    playbookKeys: knowledgeKeys.playbooks,
    queryClient,
  });

describe("playbook save cache reconciliation", () => {
  test("a completed save invalidates this organization's lists and drops its unwatched details", async () => {
    const queryClient = seededQueryClient();

    const saved = await reconcile({
      messages: saveMessages({ output: { playbookId: PLAYBOOK_ID } }),
      queryClient,
    });

    expect(saved).toBe(PLAYBOOK_ID);
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

      expect(await reconcile({ messages, queryClient })).toBeNull();

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

    expect(
      await reconcile({ handledToolCallIds, messages, queryClient }),
    ).toBeNull();

    for (const queryKey of PLAYBOOK_QUERY_KEYS) {
      expect(isInvalidated(queryClient, queryKey)).toBe(false);
    }
  });

  test("the latest of several new saves names the playbook to show", async () => {
    const messages = [
      ...saveMessages({ output: { playbookId: "playbook-a" } }),
      ...saveMessages({ output: { playbookId: "playbook-b" }, callNumber: 2 }),
    ];

    expect(
      await reconcile({ messages, queryClient: seededQueryClient() }),
    ).toBe("playbook-b");
  });
});

describe("the playbook pane after a save", () => {
  const closed = {
    isMobile: false,
    openedThisSession: false,
    shownPlaybookId: null,
    savedPlaybookId: "playbook-a",
  };

  test("a main-area chat opens it once", () => {
    expect(playbookPaneReaction({ mode: "auto-open", ...closed })).toBe("open");
    // Closed by the user after it opened: it stays closed.
    expect(
      playbookPaneReaction({
        mode: "auto-open",
        ...closed,
        openedThisSession: true,
      }),
    ).toBe("none");
  });

  test("other surfaces and a phone screen never open it by themselves", () => {
    expect(playbookPaneReaction({ mode: "on-request", ...closed })).toBe(
      "none",
    );
    expect(
      playbookPaneReaction({ mode: "auto-open", ...closed, isMobile: true }),
    ).toBe("none");
  });

  test("an open pane moves only when the thread saves another playbook", () => {
    const open = { mode: "on-request", ...closed } as const;
    expect(
      playbookPaneReaction({ ...open, shownPlaybookId: "playbook-b" }),
    ).toBe("update");
    // Already showing the saved playbook: its tab label and payload stay.
    expect(
      playbookPaneReaction({ ...open, shownPlaybookId: "playbook-a" }),
    ).toBe("none");
  });
});
