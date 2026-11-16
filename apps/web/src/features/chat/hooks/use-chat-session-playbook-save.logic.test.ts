import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  consumePlaybookSaveToolCalls,
  type PlaybookSaveMessage,
  type PlaybookSaveTarget,
} from "@/components/chat/chat-ui-tools";
import {
  followReconciledPlaybookSave,
  playbookPaneReaction,
  playbookPaneState,
  reconcilePlaybookSaveToolCalls,
} from "@/features/chat/hooks/use-chat-session-playbook-save.logic";
import type {
  PlaybookPaneMode,
  PlaybookPaneState,
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
}) => {
  const reconciliation = reconcilePlaybookSaveToolCalls({
    handledToolCallIds,
    messages,
    organizationId: ORGANIZATION_ID,
    playbookKeys: knowledgeKeys.playbooks,
    queryClient,
    source: "live",
  });
  if (reconciliation === null) {
    return null;
  }
  await reconciliation.refetched;
  return reconciliation.target?.playbookId ?? null;
};

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

  test("older history paged in behind a handled save is consumed, not followed", async () => {
    const handledToolCallIds = new Set<string>();
    const latest = saveMessages({
      output: { playbookId: "playbook-b" },
      callNumber: 2,
    });
    await reconcile({
      handledToolCallIds,
      messages: latest,
      queryClient: seededQueryClient(),
    });
    const queryClient = seededQueryClient();
    const withOlder = [
      ...saveMessages({ output: { playbookId: "playbook-a" } }),
      ...latest,
    ];

    expect(
      await reconcile({ handledToolCallIds, messages: withOlder, queryClient }),
    ).toBeNull();
    expect(handledToolCallIds.has("tool-call-1")).toBe(true);

    for (const queryKey of LIST_QUERY_KEYS) {
      expect(isInvalidated(queryClient, queryKey)).toBe(true);
    }
    expect(cachedData(queryClient, DETAIL_KEY)).toBeUndefined();
  });
});

const SOURCES: PlaybookSaveTarget["source"][] = ["live", "history"];

describe("the playbook pane after a save", () => {
  const MODES: PlaybookPaneMode[] = ["auto-open", "on-request"];
  const FLAGS = [false, true] as const;
  const PANES = [
    { type: "closed" },
    { type: "pending" },
    { type: "playbook", playbookId: "playbook-a" },
    { type: "playbook", playbookId: "playbook-b" },
  ] as const satisfies readonly PlaybookPaneState[];

  const cases = MODES.flatMap((mode) =>
    SOURCES.flatMap((source) =>
      FLAGS.flatMap((isMobile) =>
        FLAGS.flatMap((openedThisSession) =>
          PANES.map((pane) => ({
            mode,
            isMobile,
            openedThisSession,
            pane,
            saved: { playbookId: "playbook-a", source },
          })),
        ),
      ),
    ),
  );
  const reactionsWhere = (
    matches: (args: (typeof cases)[number]) => boolean,
  ) => {
    const matching = cases.filter(matches);
    expect(matching.length).toBeGreaterThan(0);
    return new Set(matching.map((args) => playbookPaneReaction(args)));
  };

  test("a pending pane becomes the saved playbook on every surface and from every save", () => {
    expect(reactionsWhere(({ pane }) => pane.type === "pending")).toEqual(
      new Set(["update"]),
    );
  });

  test("a historical save never opens a closed pane or moves one showing a playbook", () => {
    expect(
      reactionsWhere(
        ({ pane, saved }) =>
          pane.type !== "pending" && saved.source === "history",
      ),
    ).toEqual(new Set(["none"]));
  });

  test("an open pane moves only when the thread saves another playbook", () => {
    const live = (playbookId: string) =>
      reactionsWhere(
        ({ pane, saved }) =>
          saved.source === "live" &&
          pane.type === "playbook" &&
          pane.playbookId === playbookId,
      );
    expect(live("playbook-b")).toEqual(new Set(["update"]));
    // Already showing the saved playbook: its tab label and payload stay.
    expect(live("playbook-a")).toEqual(new Set(["none"]));
  });

  test("a closed pane opens once, only beside a main-area chat on a wide screen", () => {
    const closedLive = (args: (typeof cases)[number]) =>
      args.pane.type === "closed" && args.saved.source === "live";
    const opens = (args: (typeof cases)[number]) =>
      args.mode === "auto-open" && !args.isMobile && !args.openedThisSession;
    expect(reactionsWhere((args) => closedLive(args) && opens(args))).toEqual(
      new Set(["open"]),
    );
    expect(reactionsWhere((args) => closedLive(args) && !opens(args))).toEqual(
      new Set(["none"]),
    );
  });

  test("the pane state follows the tab's payload", () => {
    expect(playbookPaneState(null)).toEqual({ type: "closed" });
    expect(playbookPaneState({ type: "pending" })).toEqual({
      type: "pending",
    });
    expect(
      playbookPaneState({ type: "playbook", playbookId: "playbook-a" }),
    ).toEqual({ type: "playbook", playbookId: "playbook-a" });
  });
});

describe("following a reconciled playbook save", () => {
  test.each([
    { type: "closed" },
    { type: "playbook", playbookId: "already-open-playbook" },
  ] as const)(
    "loading an older save refreshes caches without changing pane %j, while a concurrent live save remains eligible",
    async (pane) => {
      const queryClient = seededQueryClient();
      const handledToolCallIds = new Set<string>();
      const historicalToolCallIds = new Set<string>();
      const initialPage: PlaybookSaveMessage[] = [
        { id: "current-message", role: "assistant", parts: [] },
      ];
      const reconcileMessages = (messages: PlaybookSaveMessage[]) =>
        reconcilePlaybookSaveToolCalls({
          handledToolCallIds,
          historicalToolCallIds,
          messages,
          organizationId: ORGANIZATION_ID,
          playbookKeys: knowledgeKeys.playbooks,
          queryClient,
          source: "live",
        });
      expect(reconcileMessages(initialPage)).toBeNull();
      let refetches = 0;
      const unsubscribe = new QueryObserver(queryClient, {
        queryKey: DETAIL_KEY,
        queryFn: async () => ({ revision: ++refetches }),
        staleTime: Infinity,
      }).subscribe(() => undefined);
      const olderPage = saveMessages({ output: { playbookId: PLAYBOOK_ID } });
      // The history loader marks the accepted prepend before publishing it.
      consumePlaybookSaveToolCalls({
        handledToolCallIds: historicalToolCallIds,
        messages: olderPage,
      });
      expect(historicalToolCallIds.has("tool-call-1")).toBe(true);
      const reactions: string[] = [];
      const follow = (saved: PlaybookSaveTarget) => {
        const reaction = playbookPaneReaction({
          mode: "auto-open",
          isMobile: false,
          openedThisSession: false,
          pane,
          saved,
        });
        if (reaction !== "none") {
          reactions.push(reaction);
        }
      };
      // Without provenance this exact saved playbook would open or retarget.
      expect(
        playbookPaneReaction({
          mode: "auto-open",
          isMobile: false,
          openedThisSession: false,
          pane,
          saved: { playbookId: PLAYBOOK_ID, source: "live" },
        }),
      ).toBe(pane.type === "closed" ? "open" : "update");
      const historical = reconcileMessages([...olderPage, ...initialPage]);
      if (historical === null) {
        throw new Error("Expected historical save cache reconciliation");
      }
      await followReconciledPlaybookSave({
        reconciliation: historical,
        isCurrent: () => true,
        follow,
      });
      expect(refetches).toBe(1);
      expect(reactions).toEqual([]);

      const livePage = saveMessages({
        output: { playbookId: "live-playbook" },
        callNumber: 2,
      });
      const anotherOlderPage = saveMessages({
        output: { playbookId: "another-historical-playbook" },
        callNumber: 3,
      });
      consumePlaybookSaveToolCalls({
        handledToolCallIds: historicalToolCallIds,
        messages: anotherOlderPage,
      });
      const live = reconcileMessages([
        ...anotherOlderPage,
        ...olderPage,
        ...initialPage,
        ...livePage,
      ]);
      if (live === null) {
        throw new Error("Expected live save cache reconciliation");
      }
      await followReconciledPlaybookSave({
        reconciliation: live,
        isCurrent: () => true,
        follow,
      });
      expect(historicalToolCallIds.has("tool-call-2")).toBe(false);
      expect(handledToolCallIds.has("tool-call-3")).toBe(true);
      expect(refetches).toBe(2);
      expect(reactions).toEqual([pane.type === "closed" ? "open" : "update"]);
      unsubscribe();
    },
  );

  test("reverse live completions refetch both writes while the pane stays on the newer call", async () => {
    const queryClient = seededQueryClient();
    const handledToolCallIds = new Set<string>();
    let refetches = 0;
    const unsubscribe = new QueryObserver(queryClient, {
      queryKey: DETAIL_KEY,
      queryFn: async () => ({ revision: ++refetches }),
      staleTime: Infinity,
    }).subscribe(() => undefined);
    const followed: string[] = [];
    const reconcileCompletion = async (olderState: string) => {
      const reconciliation = reconcilePlaybookSaveToolCalls({
        handledToolCallIds,
        messages: [
          ...saveMessages({
            output: { playbookId: PLAYBOOK_ID },
            state: olderState,
          }),
          ...saveMessages({
            output: { playbookId: "playbook-b" },
            callNumber: 2,
          }),
        ],
        organizationId: ORGANIZATION_ID,
        playbookKeys: knowledgeKeys.playbooks,
        queryClient,
        source: "live",
      });
      expect(reconciliation).not.toBeNull();
      if (reconciliation === null) {
        throw new Error("Expected a newly completed save reconciliation");
      }
      await followReconciledPlaybookSave({
        reconciliation,
        isCurrent: () => true,
        follow: ({ playbookId }) => {
          followed.push(playbookId);
        },
      });
    };
    await reconcileCompletion("input-complete");
    expect(refetches).toBe(1);
    expect(followed).toEqual(["playbook-b"]);
    await reconcileCompletion("complete");
    unsubscribe();
    expect(refetches).toBe(2);
    expect(cachedData(queryClient, DETAIL_KEY)).toEqual({ revision: 2 });
    expect(followed).toEqual(["playbook-b"]);
    expect(handledToolCallIds.has("tool-call-1")).toBe(true);
  });

  test.each(SOURCES)(
    "a save loaded as %s refreshes caches and fills only a pending pane",
    async (source) => {
      const queryClient = seededQueryClient();
      const historicalToolCallIds = new Set<string>();
      const messages = saveMessages({ output: { playbookId: PLAYBOOK_ID } });
      if (source === "live") {
        // Paged in behind a live transcript: marked before it is published.
        consumePlaybookSaveToolCalls({
          handledToolCallIds: historicalToolCallIds,
          messages,
        });
      }
      const reconciliation = reconcilePlaybookSaveToolCalls({
        handledToolCallIds: new Set(),
        historicalToolCallIds,
        messages,
        organizationId: ORGANIZATION_ID,
        playbookKeys: knowledgeKeys.playbooks,
        queryClient,
        source,
      });
      if (reconciliation === null) {
        throw new Error("Expected a completed save reconciliation");
      }
      expect(reconciliation.target).toEqual({
        playbookId: PLAYBOOK_ID,
        source: "history",
      });
      const reactionFor = async (pane: PlaybookPaneState) => {
        const reactions: string[] = [];
        await followReconciledPlaybookSave({
          reconciliation,
          isCurrent: () => true,
          follow: (saved) => {
            reactions.push(
              playbookPaneReaction({
                mode: "auto-open",
                isMobile: false,
                openedThisSession: false,
                pane,
                saved,
              }),
            );
          },
        });
        return reactions;
      };
      expect(await reactionFor({ type: "closed" })).toEqual(["none"]);
      expect(
        await reactionFor({ type: "playbook", playbookId: "playbook-b" }),
      ).toEqual(["none"]);
      expect(await reactionFor({ type: "pending" })).toEqual(["update"]);
      expect(
        isInvalidated(
          queryClient,
          knowledgeKeys.playbooks.list(ORGANIZATION_ID, { limit: 50 }),
        ),
      ).toBe(true);
    },
  );

  test.each(["thread switch", "newer save"])(
    "a deferred save refetch cannot move the pane after a %s",
    async (change) => {
      const queryClient = seededQueryClient();
      const refetch = Promise.withResolvers<{ refetched: boolean }>();
      const unsubscribe = new QueryObserver(queryClient, {
        queryKey: DETAIL_KEY,
        queryFn: async () => await refetch.promise,
        staleTime: Infinity,
      }).subscribe(() => undefined);
      const reconciliation = reconcilePlaybookSaveToolCalls({
        handledToolCallIds: new Set(),
        messages: saveMessages({ output: { playbookId: PLAYBOOK_ID } }),
        organizationId: ORGANIZATION_ID,
        playbookKeys: knowledgeKeys.playbooks,
        queryClient,
        source: "live",
      });
      expect(reconciliation).not.toBeNull();
      if (reconciliation === null) {
        throw new Error("Expected a completed save reconciliation");
      }
      const requestedRuntime = {};
      let currentRuntime = requestedRuntime;
      let currentSequence = 1;
      const followed: string[] = [];
      const finished = followReconciledPlaybookSave({
        reconciliation,
        isCurrent: () =>
          currentRuntime === requestedRuntime && currentSequence === 1,
        follow: ({ playbookId }) => {
          followed.push(playbookId);
        },
      });
      expect(queryClient.isFetching({ queryKey: DETAIL_KEY })).toBe(1);
      if (change === "thread switch") {
        currentRuntime = {};
      } else {
        currentSequence = 2;
      }
      refetch.resolve({ refetched: true });
      await finished;
      unsubscribe();
      expect(cachedData(queryClient, DETAIL_KEY)).toEqual({ refetched: true });
      expect(followed).toEqual([]);
    },
  );
});
