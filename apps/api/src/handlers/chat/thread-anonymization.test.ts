import { describe, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import { shouldMarkThreadUsedAnonymization } from "./thread-anonymization";

describe("chat thread anonymization marker", () => {
  test("marks a thread as soon as an anonymized send is accepted", () => {
    expect(
      shouldMarkThreadUsedAnonymization({
        messages: [{}],
        sendMode: CHAT_SEND_MODE.anonymized,
      }),
    ).toBe(true);
  });

  test("marks restored assistant messages even without request send mode", () => {
    expect(
      shouldMarkThreadUsedAnonymization({
        messages: [{ metadata: { anonRestorations: { pairs: [] } } }],
        sendMode: null,
      }),
    ).toBe(true);
  });

  test("does not mark ordinary raw-mode messages", () => {
    expect(
      shouldMarkThreadUsedAnonymization({
        messages: [{}],
        sendMode: CHAT_SEND_MODE.rawOverride,
      }),
    ).toBe(false);
  });
});
