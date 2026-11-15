import { describe, expect, test } from "bun:test";

import {
  CHAT_QUEUE_ERROR_CODE,
  CHAT_QUEUE_SEND_REFUSAL,
} from "@stll/api-contract/chat-queue";

import { queueDispositionOfRefusal } from "@/api/handlers/chat/queue/chat-queue-drain";
import { status } from "@/api/http/status";

describe("a refused queued send", () => {
  test("loses no message to a refusal that may pass on its own", () => {
    for (const code of [429, 503]) {
      expect(
        queueDispositionOfRefusal(status(code, { message: "busy" })),
      ).toEqual({ type: "retry-later" });
    }
  });

  test("waits for the member on the usage limit", () => {
    expect(
      queueDispositionOfRefusal(status(402, { message: "limit" })),
    ).toEqual({ type: "hold-usage" });
  });

  test("holds the queue with the send's own code", () => {
    expect(
      queueDispositionOfRefusal(
        status(403, { code: "local_run_unavailable", message: "no" }),
      ),
    ).toEqual({ type: "hold-refused", code: "local_run_unavailable" });
    expect(
      queueDispositionOfRefusal(status(400, { message: "invalid" })),
    ).toEqual({ type: "hold-refused", code: CHAT_QUEUE_SEND_REFUSAL.refused });
  });

  test("holds nothing when another sender or a turn got there first", () => {
    expect(
      queueDispositionOfRefusal(
        status(409, { code: CHAT_QUEUE_ERROR_CODE.notDue, message: "later" }),
      ),
    ).toEqual({ type: "not-due" });
  });
});
