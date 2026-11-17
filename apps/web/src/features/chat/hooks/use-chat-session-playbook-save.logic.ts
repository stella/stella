import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import {
  consumePlaybookSaveToolCalls,
  type PlaybookSaveMessage,
  type PlaybookSaveTarget,
} from "@/components/chat/chat-ui-tools";
import type { PlaybookDraftViewPayload } from "@/lib/knowledge/playbook-draft-view";

type ReconcilePlaybookSaveToolCallsOptions = {
  handledToolCallIds: Set<string>;
  historicalToolCallIds?: ReadonlySet<string>;
  messages: readonly PlaybookSaveMessage[];
  organizationId: string;
  playbookKeys: {
    all: (organizationId: string) => readonly unknown[];
    isDetail: (queryKey: readonly unknown[]) => boolean;
  };
  queryClient: QueryClient;
  source: "history" | "live";
};

type PlaybookSaveReconciliation = {
  /** Null when no newly handled save is the thread's latest. */
  target: PlaybookSaveTarget | null;
  /** Settles when the playbook queries have refetched. */
  refetched: Promise<void>;
};

/**
 * Refetches for every newly handled save, including an older call that
 * completes after a newer one. Only a new latest save names a pane target.
 * The caller follows that target once `refetched` settles,
 * so the pane's label can read the fresh name.
 *
 * A chat save runs outside the playbooks page's own mutations, so every
 * playbook query is refetched: an open list, and a detail the editor or the
 * inspector is watching. The editor keeps its concurrency token with its
 * draft, so a refetch under an open form costs it a version conflict on the
 * next save, never a silent overwrite of what the chat wrote.
 *
 * A detail nobody is watching is dropped, not invalidated: the editor seeds
 * its form from whatever the cache holds at mount, and an invalidated entry
 * is still served while it refetches.
 */
export const reconcilePlaybookSaveToolCalls = ({
  handledToolCallIds,
  historicalToolCallIds,
  messages,
  organizationId,
  playbookKeys,
  queryClient,
  source,
}: ReconcilePlaybookSaveToolCallsOptions): PlaybookSaveReconciliation | null => {
  const consumed = consumePlaybookSaveToolCalls({
    handledToolCallIds,
    ...(historicalToolCallIds === undefined ? {} : { historicalToolCallIds }),
    messages,
  });
  if (consumed === null) {
    return null;
  }
  queryClient.removeQueries({
    queryKey: playbookKeys.all(organizationId),
    predicate: (query) =>
      playbookKeys.isDetail(query.queryKey) && !query.isActive(),
  });
  return {
    // Every save in a transcript loaded as history is historical.
    target:
      consumed.target === null
        ? null
        : {
            playbookId: consumed.target.playbookId,
            source: source === "history" ? "history" : consumed.target.source,
          },
    refetched: queryClient.invalidateQueries({
      queryKey: playbookKeys.all(organizationId),
    }),
  };
};

/**
 * Whether a chat surface opens the playbook pane by itself. Only a main-area
 * chat does: there the pane opens beside the conversation. In an inspector
 * chat tab or beside a file, the pane would cover the interview the user is
 * answering, so it opens only from the row's "Open playbook".
 */
export type PlaybookPaneMode = "auto-open" | "on-request";

/** What the thread's pane shows when a save arrives. */
export type PlaybookPaneState =
  | { type: "closed" }
  | { type: "pending" }
  | { type: "playbook"; playbookId: string };

/** The pane state behind a thread tab's payload; null when no pane is open. */
export const playbookPaneState = (
  payload: PlaybookDraftViewPayload | null,
): PlaybookPaneState => {
  if (payload === null) {
    return { type: "closed" };
  }
  switch (payload.type) {
    case "pending":
      return { type: "pending" };
    case "playbook":
      return { type: "playbook", playbookId: payload.playbookId };
    default:
      payload satisfies never;
      return panic("Unhandled playbook pane payload");
  }
};

type PlaybookPaneReactionArgs = {
  mode: PlaybookPaneMode;
  /** Below `md` the inspector is a sheet over the whole chat. */
  isMobile: boolean;
  /** This thread's pane was already shown once while the session was mounted. */
  openedThisSession: boolean;
  pane: PlaybookPaneState;
  saved: PlaybookSaveTarget;
};

/**
 * What a newly saved playbook does to the thread's pane. A pending pane
 * always becomes the saved playbook, on any surface and from any save, so it
 * cannot stay pending beside a thread that has a playbook. Otherwise a
 * historical save reconciles caches without moving or opening the pane. An
 * open pane on another playbook moves to the saved one without taking focus;
 * one already showing it is left as it is. A closed pane opens once per
 * thread while the session is mounted, and never again after the user closed
 * it.
 */
export const playbookPaneReaction = ({
  mode,
  isMobile,
  openedThisSession,
  pane,
  saved,
}: PlaybookPaneReactionArgs): "update" | "open" | "none" => {
  if (pane.type === "pending") {
    return "update";
  }
  if (saved.source === "history") {
    return "none";
  }
  switch (pane.type) {
    case "playbook":
      return pane.playbookId === saved.playbookId ? "none" : "update";
    case "closed":
      return mode === "auto-open" && !isMobile && !openedThisSession
        ? "open"
        : "none";
    default:
      pane satisfies never;
      return panic("Unhandled playbook pane state");
  }
};

type FollowReconciledPlaybookSaveOptions = {
  reconciliation: PlaybookSaveReconciliation;
  isCurrent: () => boolean;
  follow: (saved: PlaybookSaveTarget) => void;
};

/** Refetch completion cannot move a pane after its runtime or save changed. */
export const followReconciledPlaybookSave = async ({
  reconciliation,
  isCurrent,
  follow,
}: FollowReconciledPlaybookSaveOptions): Promise<void> => {
  await reconciliation.refetched;
  if (reconciliation.target === null || !isCurrent()) {
    return;
  }
  follow(reconciliation.target);
};
