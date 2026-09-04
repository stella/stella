import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { CONTACT_CURSOR_MAX_LENGTH } from "@/api/handlers/contacts/list-query";
import { tPaginationCursor } from "@/api/lib/custom-schema";
import { encodePaginationCursor } from "@/api/lib/pagination";

describe("contact pagination cursor contract", () => {
  test("accepts the largest cursor the contact list can emit", () => {
    const cursor = encodePaginationCursor([
      "\u0001".repeat(512),
      "019c3f26-6d7a-73da-8408-9543d6ab48f0",
    ]);

    expect(cursor).toHaveLength(CONTACT_CURSOR_MAX_LENGTH);
    expect(
      Value.Check(
        tPaginationCursor({ maxChars: CONTACT_CURSOR_MAX_LENGTH }),
        cursor,
      ),
    ).toBe(true);
    expect(
      Value.Check(
        tPaginationCursor({ maxChars: CONTACT_CURSOR_MAX_LENGTH }),
        `${cursor}x`,
      ),
    ).toBe(false);
  });
});
