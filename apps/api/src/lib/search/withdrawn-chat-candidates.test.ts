import { expect, test } from "bun:test";

import { GLOBAL_SEARCH_RANK_WORK_LIMIT_CODE } from "@stll/api-contract/search";

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
  const rows = await readChatCandidateBatches({
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
  expect(rows.isOk()).toBe(true);
  if (rows.isOk()) {
    expect(rows.value).toEqual(source);
  }
  expect(calls).toBe(3);
});

test("candidate ranking reports the work limit instead of returning a truncated candidate prefix", async () => {
  let calls = 0;
  const result = await readChatCandidateBatches({
    readBatch: async () => {
      calls++;
      return Array.from(
        { length: LIMITS.searchChatCandidateThreadsMax + 1 },
        (_, index) => ({ id: String(index), tier: 1, score: 1 }),
      );
    },
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("search work limit");
  }
  expect(calls).toBe(LIMITS.searchChatCandidateBatchesMax);
});

test("candidate source bytes share the ranking work limit", async () => {
  const result = await readChatCandidateBatches({
    readBatch: async () => [
      {
        id: "one",
        tier: 1,
        score: 1,
        text: "x".repeat(LIMITS.searchChatCandidateBytesMax),
      },
    ],
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain("search work limit");
  }
});

test("source completeness is required before an admitted ranking can be returned", async () => {
  const result = await readChatCandidateBatches({
    readBatch: async () => [
      {
        id: "one",
        tier: 1,
        score: 1,
        source_messages: [{ overflow: true, content: null }],
      },
    ],
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.code).toBe(GLOBAL_SEARCH_RANK_WORK_LIMIT_CODE);
  }
});
