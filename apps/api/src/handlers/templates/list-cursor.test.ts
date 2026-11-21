import { describe, expect, test } from "bun:test";

import {
  decodeTemplateListCursor,
  encodeTemplateListCursor,
} from "@/api/handlers/templates/list-cursor";
import { toSafeId } from "@/api/lib/branded-types";

describe("templates list cursor", () => {
  test("round-trips a full precision template boundary", () => {
    const id = toSafeId<"template">("018f4ad2-3a6d-7000-8b1d-44f76f5df001");
    const boundary = { id, cursorCreatedAt: "2026-10-30T12:34:56.123456Z" };
    const cursor = encodeTemplateListCursor(boundary);

    expect(decodeTemplateListCursor(cursor)).toEqual(boundary);
  });

  test("rejects malformed cursors", () => {
    expect(decodeTemplateListCursor("not-a-cursor")).toBeNull();
    expect(decodeTemplateListCursor("")).toBeNull();
  });

  test("rejects a decodable cursor that does not carry a uuid", () => {
    const cursor = Buffer.from(
      JSON.stringify(["2026-10-30T12:34:56.123456Z", "not-a-uuid"]),
    ).toBase64({
      alphabet: "base64url",
      omitPadding: true,
    });

    expect(decodeTemplateListCursor(cursor)).toBeNull();
  });
});
