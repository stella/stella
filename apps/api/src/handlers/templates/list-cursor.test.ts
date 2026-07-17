import { describe, expect, test } from "bun:test";

import {
  decodeTemplateListCursor,
  encodeTemplateListCursor,
} from "@/api/handlers/templates/list";
import { toSafeId } from "@/api/lib/branded-types";

describe("templates list cursor", () => {
  test("round-trips a template id", () => {
    const id = toSafeId<"template">("018f4ad2-3a6d-7000-8b1d-44f76f5df001");
    const cursor = encodeTemplateListCursor(id);

    expect(decodeTemplateListCursor(cursor)).toEqual(id);
  });

  test("rejects malformed cursors", () => {
    expect(decodeTemplateListCursor("not-a-cursor")).toBeNull();
    expect(decodeTemplateListCursor("")).toBeNull();
  });

  test("rejects a decodable cursor that does not carry a uuid", () => {
    const cursor = Buffer.from(JSON.stringify(["not-a-uuid"])).toString(
      "base64url",
    );

    expect(decodeTemplateListCursor(cursor)).toBeNull();
  });
});
