import { describe, expect, test } from "bun:test";

import {
  decodeEntityListCursor,
  encodeEntityListCursor,
} from "@/api/handlers/entities/list-cursor";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

describe("entity list cursor", () => {
  test("round-trips microsecond timestamp precision", () => {
    const cursor = encodeEntityListCursor({
      createdAt: "2026-05-22T09:31:31.123456",
      id: "entity_1",
    });

    expect(decodeEntityListCursor(cursor)).toEqual({
      createdAt: "2026-05-22T09:31:31.123456",
      id: toSafeId<"entity">("entity_1"),
    });
  });

  test("rejects millisecond timestamps", () => {
    const cursor = encodeEntityListCursor({
      createdAt: "2026-05-22T09:31:31.123",
      id: "entity_1",
    });

    expect(() => decodeEntityListCursor(cursor)).toThrow(HandlerError);
  });
});
