import { describe, expect, test } from "bun:test";

import {
  CHAT_REF_ENCODING,
  CHAT_REF_INPUT_STATE,
  isChatRefContext,
  isChatRefEncoding,
  resolveChatRefInputState,
} from "@/api/lib/chat/ref-token";

describe("chat ref encoding validation", () => {
  test("accepts every encoding declared by the source-of-truth map", () => {
    for (const encoding of Object.values(CHAT_REF_ENCODING)) {
      expect(isChatRefEncoding(encoding)).toBe(true);
    }
  });

  test("rejects unknown and non-string persisted values", () => {
    expect(isChatRefEncoding("future-ref-encoding")).toBe(false);
    expect(isChatRefEncoding(null)).toBe(false);
    expect(isChatRefEncoding(42)).toBe(false);
  });

  test("fails fast for an unknown persisted encoding", () => {
    expect(resolveChatRefInputState(undefined)).toBe(
      CHAT_REF_INPUT_STATE.LEGACY_UUID_IDS,
    );
    expect(
      resolveChatRefInputState(CHAT_REF_ENCODING.PERSISTED_RESOURCE_IDS_V1),
    ).toBe(CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_IDS_V1);
    expect(
      resolveChatRefInputState(CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2),
    ).toBe(CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2);
    expect(() => resolveChatRefInputState("future-ref-encoding")).toThrow(
      "Unknown persisted chat ref encoding",
    );
  });

  test("requires explicit unresolved-input state in v2 context", () => {
    expect(
      isChatRefContext({
        version: 1,
        entities: [],
        unresolvedInputs: [
          {
            kind: "matter",
            param: "matter_id",
            ref: "mat_999",
            toolCallId: "tool-1",
          },
        ],
      }),
    ).toBe(true);
    expect(isChatRefContext({ version: 1, entities: [] })).toBe(false);
  });
});
