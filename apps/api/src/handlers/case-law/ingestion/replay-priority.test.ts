import { expect, test } from "bun:test";

import {
  REPLAY_PRIORITY,
  replayPriority,
  replayPriorityRank,
} from "./replay-priority";

test("reported rows outrank every parser wave and parser waves outrank remaining work", () => {
  for (const currentParserVersion of [1, 2, 20]) {
    for (const lastFullReplayParserVersion of [null, 1, currentParserVersion]) {
      expect(
        replayPriority({
          reportedDecisionPending: true,
          currentParserVersion,
          lastFullReplayParserVersion,
        }),
      ).toBe(REPLAY_PRIORITY.REPORTED);
      const other = replayPriority({
        reportedDecisionPending: false,
        currentParserVersion,
        lastFullReplayParserVersion,
      });
      expect(replayPriorityRank(REPLAY_PRIORITY.REPORTED)).toBeLessThan(
        replayPriorityRank(other),
      );
      expect(other).toBe(
        lastFullReplayParserVersion === null ||
          currentParserVersion > lastFullReplayParserVersion
          ? REPLAY_PRIORITY.PARSER_BUMP
          : REPLAY_PRIORITY.REMAINING,
      );
    }
  }
  expect(replayPriorityRank(REPLAY_PRIORITY.PARSER_BUMP)).toBeLessThan(
    replayPriorityRank(REPLAY_PRIORITY.REMAINING),
  );
});
