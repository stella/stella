import { panic } from "better-result";

export const REPLAY_PRIORITY = {
  REPORTED: "reported",
  PARSER_BUMP: "parser-bump",
  REMAINING: "remaining",
} as const;
export type ReplayPriority =
  (typeof REPLAY_PRIORITY)[keyof typeof REPLAY_PRIORITY];

const PRIORITY_RANK = {
  [REPLAY_PRIORITY.REPORTED]: 0,
  [REPLAY_PRIORITY.PARSER_BUMP]: 1,
  [REPLAY_PRIORITY.REMAINING]: 2,
} as const satisfies Record<ReplayPriority, number>;

type ReplayPriorityOptions = {
  reportedDecisionPending: boolean;
  currentParserVersion: number;
  lastFullReplayParserVersion: number | null;
};

/** A never-replayed parser is a pending wave, including the first parser version. */
export const replayPriority = ({
  reportedDecisionPending,
  currentParserVersion,
  lastFullReplayParserVersion,
}: ReplayPriorityOptions): ReplayPriority => {
  if (reportedDecisionPending) {
    return REPLAY_PRIORITY.REPORTED;
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
    case REPLAY_PRIORITY.PARSER_BUMP:
    case REPLAY_PRIORITY.REMAINING:
      return PRIORITY_RANK[priority];
    default:
      priority satisfies never;
      return panic("Unknown replay priority");
  }
};
