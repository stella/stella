import { Temporal } from "@stll/time";

import type { Workspace } from "@/lib/workspaces/types";

export const RECENT_CLIENT_SUGGESTIONS_MAX = 6;

type ClientMatter = Pick<Workspace, "client" | "lastActivityAt">;

type MatterClient = NonNullable<Workspace["client"]>;

export type RecentClient = Pick<MatterClient, "id" | "displayName" | "type"> & {
  matterCount: number;
};

type ClientTally = RecentClient & { lastActivityAt: Temporal.Instant };

/**
 * The clients of the given matters, most recently active first: a client's
 * recency is the latest `lastActivityAt` across its matters. Ties fall back to
 * the larger matter count, then the client id, so the order is deterministic.
 */
export const rankRecentClients = (
  matters: readonly ClientMatter[],
): RecentClient[] => {
  const tallies = new Map<string, ClientTally>();
  for (const { client, lastActivityAt } of matters) {
    if (client === null) {
      continue;
    }
    const activity = Temporal.Instant.from(lastActivityAt);
    const tally = tallies.get(client.id);
    if (tally === undefined) {
      tallies.set(client.id, {
        id: client.id,
        displayName: client.displayName,
        type: client.type,
        matterCount: 1,
        lastActivityAt: activity,
      });
      continue;
    }
    tally.matterCount += 1;
    if (Temporal.Instant.compare(activity, tally.lastActivityAt) > 0) {
      tally.lastActivityAt = activity;
    }
  }

  return Array.from(tallies.values())
    .toSorted(
      (a, b) =>
        Temporal.Instant.compare(b.lastActivityAt, a.lastActivityAt) ||
        b.matterCount - a.matterCount ||
        // Map keys are unique, so two tallies never share an id.
        (a.id < b.id ? -1 : 1),
    )
    .slice(0, RECENT_CLIENT_SUGGESTIONS_MAX)
    .map(({ id, displayName, type, matterCount }) => ({
      id,
      displayName,
      type,
      matterCount,
    }));
};
