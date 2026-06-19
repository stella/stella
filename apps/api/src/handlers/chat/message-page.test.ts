import { describe, expect, test } from "bun:test";

import {
  decodeMessagePageCursor,
  encodeMessagePageCursor,
} from "@/api/handlers/chat/message-page";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

const MESSAGE_ID = brandPersistedChatMessageId(
  "018f4ad2-3a6d-7000-8b1d-44f76f5df001",
);

describe("chat message page cursor", () => {
  test("roundtrips the createdAt timestamp and message id", () => {
    const createdAt = new Date("2026-05-16T08:30:00.123Z");
    const cursor = encodeMessagePageCursor({ createdAt, id: MESSAGE_ID });

    expect(decodeMessagePageCursor(cursor)).toEqual({
      createdAt,
      id: MESSAGE_ID,
    });
  });

  test("rejects a cursor that is not valid base64url JSON", () => {
    expect(decodeMessagePageCursor("not-a-cursor")).toBeNull();
  });

  test("rejects a cursor whose array shape is wrong", () => {
    expect(
      decodeMessagePageCursor(
        Buffer.from(JSON.stringify([MESSAGE_ID])).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeMessagePageCursor(
        Buffer.from(JSON.stringify({ id: MESSAGE_ID })).toString("base64url"),
      ),
    ).toBeNull();
  });

  test("rejects a cursor whose parts are not strings", () => {
    expect(
      decodeMessagePageCursor(
        Buffer.from(JSON.stringify([42, MESSAGE_ID])).toString("base64url"),
      ),
    ).toBeNull();
  });

  test("rejects a cursor with an unparseable timestamp", () => {
    expect(
      decodeMessagePageCursor(
        Buffer.from(JSON.stringify(["not-a-date", MESSAGE_ID])).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
  });
});
