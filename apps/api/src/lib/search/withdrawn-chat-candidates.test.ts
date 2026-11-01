import { expect, test } from "bun:test";

import { GLOBAL_SEARCH_CHAT_COVERAGE } from "@stll/api-contract/search";

import { LIMITS } from "@/api/lib/limits";

import { isAfterGlobalSearchCursor } from "./pagination";
import type { ChatSearchCandidateRow } from "./withdrawn-chat-candidates";
import { readChatCandidateBatches } from "./withdrawn-chat-candidates";

test("candidate batches advance their SQL keyset through the entire bounded input", async () => {
  const source = Array.from(
    { length: 251 },
    (_, index) =>
      ({
        id: String(index),
        tier: index < 100 ? 4 : 1,
        score: (index < 100 ? 1000 : 2000) - index,
      }) satisfies ChatSearchCandidateRow,
  );
  let calls = 0;
  const read = await readChatCandidateBatches({
    readBatch: async (cursor) => {
      calls++;
      return source
        .filter(
          ({ id, tier, score }) =>
            cursor === null ||
            isAfterGlobalSearchCursor(
              { id: `chat:${id}`, tier, score },
              cursor,
            ),
        )
        .slice(0, LIMITS.searchChatCandidateThreadsMax + 1);
    },
  });
  expect(read).toEqual({
    rows: source,
    coverage: GLOBAL_SEARCH_CHAT_COVERAGE.COMPLETE,
  });
  expect(calls).toBe(3);
});

test("a window past the batch limit keeps the threads it read and reports partial coverage", async () => {
  let calls = 0;
  const read = await readChatCandidateBatches({
    readBatch: async () => {
      calls++;
      return Array.from(
        { length: LIMITS.searchChatCandidateThreadsMax + 1 },
        (_, index) => ({ id: `${calls}-${index}`, tier: 1, score: 1 }),
      );
    },
  });
  expect(read.coverage).toBe(GLOBAL_SEARCH_CHAT_COVERAGE.PARTIAL);
  expect(read.rows).toHaveLength(
    LIMITS.searchChatCandidateBatchesMax * LIMITS.searchChatCandidateThreadsMax,
  );
  expect(calls).toBe(LIMITS.searchChatCandidateBatchesMax);
});

test("the byte budget keeps earlier threads of the same batch", async () => {
  const read = await readChatCandidateBatches({
    readBatch: async () => [
      { id: "first", tier: 1, score: 2 },
      {
        id: "oversized",
        tier: 1,
        score: 1,
        text: "x".repeat(LIMITS.searchChatCandidateBytesMax),
      },
      { id: "after", tier: 1, score: 0 },
    ],
  });
  expect(read.rows.map(({ id }) => id)).toEqual(["first"]);
  expect(read.coverage).toBe(GLOBAL_SEARCH_CHAT_COVERAGE.PARTIAL);
});

test("a thread past the source limit stays a candidate beside the threads after it", async () => {
  const read = await readChatCandidateBatches({
    readBatch: async () => [
      {
        id: "long",
        tier: 1,
        score: 2,
        source_messages: [
          { role: "user", content: "admitted", overflow: false },
          { role: "user", content: null, overflow: true },
        ],
      },
      {
        id: "short",
        tier: 1,
        score: 1,
        source_messages: [
          { role: "user", content: "admitted", overflow: false },
        ],
      },
    ],
  });
  expect(read.rows.map(({ id }) => id)).toEqual(["long", "short"]);
  expect(read.coverage).toBe(GLOBAL_SEARCH_CHAT_COVERAGE.PARTIAL);
});
