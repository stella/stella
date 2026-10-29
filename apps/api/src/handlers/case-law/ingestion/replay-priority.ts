import { panic } from "better-result";

import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

export const REPLAY_PRIORITY = {
  REPORTED: "reported",
  VISITED: "visited",
  PARSER_BUMP: "parser-bump",
  REMAINING: "remaining",
} as const;
export type ReplayPriority =
  (typeof REPLAY_PRIORITY)[keyof typeof REPLAY_PRIORITY];

const PRIORITY_RANK = {
  [REPLAY_PRIORITY.REPORTED]: 0,
  [REPLAY_PRIORITY.VISITED]: 1,
  [REPLAY_PRIORITY.PARSER_BUMP]: 2,
  [REPLAY_PRIORITY.REMAINING]: 3,
} as const satisfies Record<ReplayPriority, number>;

export const REPLAY_HINT_TIERS = [
  REPLAY_PRIORITY.REPORTED,
  REPLAY_PRIORITY.VISITED,
] as const;
export type ReplayHintTier = (typeof REPLAY_HINT_TIERS)[number];
export const VISITED_REPLAY_ADMISSION_LIMITS = {
  batchRows: 64,
  rowsPerSourceMinute: 60,
  minuteMs: 60_000,
} as const;

type ReplayPriorityOptions = {
  pendingHint: ReplayHintTier | null;
  currentParserVersion: number;
  lastFullReplayParserVersion: number | null;
};

/** A never-replayed parser is a pending wave, including the first parser version. */
export const replayPriority = ({
  pendingHint,
  currentParserVersion,
  lastFullReplayParserVersion,
}: ReplayPriorityOptions): ReplayPriority => {
  if (pendingHint !== null) {
    return pendingHint;
  }
  if (
    lastFullReplayParserVersion === null ||
    currentParserVersion > lastFullReplayParserVersion
  ) {
    return REPLAY_PRIORITY.PARSER_BUMP;
  }
  return REPLAY_PRIORITY.REMAINING;
};

export const replayPriorityRank = (priority: ReplayPriority) => {
  switch (priority) {
    case REPLAY_PRIORITY.REPORTED:
    case REPLAY_PRIORITY.VISITED:
    case REPLAY_PRIORITY.PARSER_BUMP:
    case REPLAY_PRIORITY.REMAINING:
      return PRIORITY_RANK[priority];
    default:
      priority satisfies never;
      return panic("Unknown replay priority");
  }
};

type ReplaySourcePrioritySnapshot = {
  id: string;
  adapterKey: string;
  lastFullReplayParserVersion: number | null;
};
type ReplaySourcePriorityOrderOptions = {
  adapterOrder: readonly AdapterKey[];
  sources: readonly ReplaySourcePrioritySnapshot[];
  parserVersions: Readonly<Record<AdapterKey, number>>;
  pendingHints: ReadonlyMap<string, ReplayHintTier>;
};

/** Preserve round-robin order within each exhaustive priority class. */
export const replaySourcePriorityOrder = ({
  adapterOrder,
  sources,
  parserVersions,
  pendingHints,
}: ReplaySourcePriorityOrderOptions) => {
  const sourceByAdapter = new Map(
    sources.map((source) => [source.adapterKey, source]),
  );
  const rankOf = (adapterKey: AdapterKey) => {
    const source = sourceByAdapter.get(adapterKey);
    return replayPriorityRank(
      replayPriority({
        pendingHint:
          source === undefined ? null : (pendingHints.get(source.id) ?? null),
        currentParserVersion: parserVersions[adapterKey],
        lastFullReplayParserVersion:
          source?.lastFullReplayParserVersion ?? null,
      }),
    );
  };
  return adapterOrder.toSorted((left, right) => rankOf(left) - rankOf(right));
};
