import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import type { ChatActiveRunState } from "@stll/api-contract/chat";

import { runsByThread } from "@/state/chat-runs";
import type { ActiveChatRun } from "@/state/chat-runs";

/**
 * Why a chat earns a banner: its run now waits on the reader, or it left the
 * list of unfinished runs. The list says nothing about how a run ended, so a
 * run that left it has finished, not succeeded.
 */
export const RUN_BANNER_TYPE = {
  needsYou: "needs-you",
  finished: "finished",
} as const;

/** One banner, for one chat. */
export type RunBanner = {
  readonly type: (typeof RUN_BANNER_TYPE)[keyof typeof RUN_BANNER_TYPE];
  readonly threadId: string;
  readonly threadTitle: string;
  readonly matterId: string | undefined;
};

const needsYou = (state: ChatActiveRunState | undefined) =>
  state === CHAT_ACTIVE_RUN_STATE.needsYou;

/**
 * The banners one read of the unfinished runs owes, against the read
 * before it: a chat whose run came to wait on the reader, and a chat that
 * left the list. The first read (`previous` undefined) is the baseline and
 * owes none, so opening the app does not replay what was already open.
 */
export const runBanners = ({
  next,
  previous,
}: {
  readonly next: readonly ActiveChatRun[];
  readonly previous: readonly ActiveChatRun[] | undefined;
}): RunBanner[] => {
  if (previous === undefined) {
    return [];
  }
  const before = runsByThread(previous);
  const after = runsByThread(next);
  const waiting = [...after.values()].flatMap(
    ({ matterId, state, threadId, threadTitle }) =>
      needsYou(state) && !needsYou(before.get(threadId)?.state)
        ? [{ type: RUN_BANNER_TYPE.needsYou, matterId, threadId, threadTitle }]
        : [],
  );
  const finished = [...before.values()].flatMap(
    ({ matterId, threadId, threadTitle }) =>
      after.has(threadId)
        ? []
        : [{ type: RUN_BANNER_TYPE.finished, matterId, threadId, threadTitle }],
  );
  return [...waiting, ...finished];
};

/**
 * The banners still to show once a read arrives: one per chat at most, the
 * newest news for a chat replacing older news, and a "waiting for you"
 * dropped once its chat no longer waits.
 */
export const queueRunBanners = ({
  next,
  previous,
  queue,
}: {
  readonly next: readonly ActiveChatRun[];
  readonly previous: readonly ActiveChatRun[] | undefined;
  readonly queue: readonly RunBanner[];
}): RunBanner[] => {
  const after = runsByThread(next);
  const arrived = runBanners({ next, previous });
  const replaced = new Set(arrived.map(({ threadId }) => threadId));
  const current = queue.filter(
    ({ threadId, type }) =>
      !replaced.has(threadId) &&
      (type !== RUN_BANNER_TYPE.needsYou ||
        needsYou(after.get(threadId)?.state)),
  );
  return [...current, ...arrived];
};
