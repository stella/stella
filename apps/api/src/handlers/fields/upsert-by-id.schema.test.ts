import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { upsertFieldContentSchema } from "./upsert-by-id";

describe("upsert field content schema", () => {
  test("accepts exactly the empty person sentinel used to clear a cell", () => {
    expect(
      Value.Check(upsertFieldContentSchema, {
        version: 1,
        type: "person",
        userId: null,
        name: "",
        image: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(upsertFieldContentSchema, {
        version: 1,
        type: "person",
        userId: "user-1",
        name: "",
        image: null,
      }),
    ).toBe(false);
  });

  test("keeps non-empty person assignments valid", () => {
    expect(
      Value.Check(upsertFieldContentSchema, {
        version: 1,
        type: "person",
        userId: "user-1",
        name: "Anna Nováková",
        image: "https://example.test/anna.jpg",
      }),
    ).toBe(true);
  });
});
