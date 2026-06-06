import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import { shouldMarkThreadUsedAnonymization } from "./thread-anonymization";

const messageWithParts = (parts: readonly { type: string }[]) => ({ parts });

describe("chat thread anonymization marker", () => {
  test("marks a thread as soon as an anonymized send is accepted", () => {
    expect(
      shouldMarkThreadUsedAnonymization({
        messages: [messageWithParts([{ type: "text" }])],
        sendMode: CHAT_SEND_MODE.anonymized,
      }),
    ).toBe(true);
  });

  test("marks restored assistant messages even without request send mode", () => {
    expect(
      shouldMarkThreadUsedAnonymization({
        messages: [
          messageWithParts([{ type: "data-stella-anon-restorations" }]),
        ],
        sendMode: null,
      }),
    ).toBe(true);
  });

  test("does not mark ordinary raw-mode messages", () => {
    expect(
      shouldMarkThreadUsedAnonymization({
        messages: [messageWithParts([{ type: "text" }])],
        sendMode: CHAT_SEND_MODE.rawOverride,
      }),
    ).toBe(false);
  });
});
