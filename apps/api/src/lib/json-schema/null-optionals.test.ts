import { describe, expect, test } from "bun:test";

import {
  withModelPlaceholdersOmitted,
  withNullOptionalsOmitted,
} from "@/api/lib/json-schema/null-optionals";
import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";

const schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    note: { type: "string", minLength: 1 },
    label: { type: "string" },
    mode: { type: "string", enum: ["fast", "slow"] },
    code: { type: "string", pattern: "^[A-Z]+$" },
    either: { anyOf: [{ type: "string", minLength: 1 }, { type: "number" }] },
  },
  required: ["name"],
};

describe("a model's placeholder in an optional field", () => {
  test("null is omitted where the field refuses it", () => {
    expect(
      withModelPlaceholdersOmitted(schema, { name: "draft", note: null }),
    ).toEqual({ name: "draft" });
  });

  test('"" is omitted only where the field refuses it', () => {
    expect(
      withModelPlaceholdersOmitted(schema, {
        code: "",
        either: "",
        label: "",
        mode: "",
        name: "draft",
        note: "",
      }),
    ).toEqual({ label: "", name: "draft" });
  });

  test("a required field keeps its placeholder, so validation still refuses it", () => {
    const required = { ...schema, required: ["name", "note"] };
    expect(
      withModelPlaceholdersOmitted(required, { name: "draft", note: "" }),
    ).toEqual({ name: "draft", note: "" });
  });

  test('the string "null" is a value, not a placeholder', () => {
    expect(
      withModelPlaceholdersOmitted(schema, { name: "draft", note: "null" }),
    ).toEqual({ name: "draft", note: "null" });
  });

  test('"" is omitted where the field\'s format refuses it', () => {
    const formatted = {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        on: { type: "string", format: "date" },
        tag: { type: "string", format: "x-free-text" },
      },
    };
    expect(
      withModelPlaceholdersOmitted(formatted, { id: "", on: "", tag: "" }),
    ).toEqual({ tag: "" });
  });

  test("an OpenAPI nullable field keeps its null", () => {
    const projected = {
      type: "object",
      properties: {
        name: { type: "string" },
        note: { type: "string", nullable: true },
      },
      required: ["name"],
    };
    expect(
      withModelPlaceholdersOmitted(projected, { name: "draft", note: null }),
    ).toEqual({ name: "draft", note: null });
  });

  test("a pattern that does not compile leaves the value as sent", () => {
    const loose = {
      type: "object",
      properties: { slug: { type: "string", pattern: String.raw`^[a-z\_]+$` } },
      patternProperties: { [String.raw`^x\-`]: { type: "string" } },
    };
    expect(
      withModelPlaceholdersOmitted(loose, { slug: "", "x-tag": null }),
    ).toEqual({ slug: "", "x-tag": null });
  });

  test("a null one union branch takes stays, though a sibling branch refuses it", () => {
    const union = {
      anyOf: [
        { type: "object", properties: { d: { type: ["string", "null"] } } },
        { type: "object", properties: { d: { type: "string" } } },
      ],
    };
    expect(withModelPlaceholdersOmitted(union, { d: null })).toEqual({
      d: null,
    });
  });

  test("a null is omitted where an open sibling branch only tolerates the field", () => {
    // The sibling takes any extra field without declaring it, so its
    // tolerance does not make the null a value.
    const union = {
      anyOf: [
        {
          type: "object",
          properties: {
            a: { type: "array", items: { type: "string" } },
            d: { type: "array", items: { type: "integer" } },
          },
          required: ["a"],
          additionalProperties: false,
        },
        { type: "object", properties: { b: { type: ["string", "null"] } } },
      ],
    };
    expect(withModelPlaceholdersOmitted(union, { a: [], d: null })).toEqual({
      a: [],
    });
  });

  test("each null is kept by a branch declaring its own field", () => {
    const union = {
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "string" }, y: { type: "string" } },
        },
        {
          anyOf: [
            { type: "object", properties: { x: { type: ["string", "null"] } } },
            { type: "object", properties: { y: { type: ["string", "null"] } } },
          ],
        },
      ],
    };
    expect(withModelPlaceholdersOmitted(union, { x: null, y: null })).toEqual({
      x: null,
      y: null,
    });
  });

  test("a null is omitted though a sibling branch the value cannot fit declares it", () => {
    const union = {
      anyOf: [
        {
          type: "object",
          properties: {
            c: { type: "boolean" },
            d: { type: "string", minLength: 1 },
          },
          required: ["c"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            c: { type: "array", items: { type: "integer" } },
            d: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
      ],
    };
    const read = withModelPlaceholdersOmitted(union, { c: false, d: null });
    expect(
      violationsOf(
        CHAT_ORACLE.providerWireToolInput,
        Bun.deepEquals(read, { c: false }) ? [] : [{ read }],
      ),
    ).toEqual([]);
  });

  test("a null one array member's items declare stays, though a sibling member's refuse it", () => {
    const union = {
      anyOf: [
        {
          type: "array",
          items: { type: "object", properties: { b: { type: "integer" } } },
        },
        {
          type: "array",
          items: {
            type: "object",
            properties: { b: { type: ["string", "null"] } },
          },
        },
      ],
    };
    const sent = [{ b: null }];
    const read = withModelPlaceholdersOmitted(union, sent);
    expect(
      violationsOf(
        CHAT_ORACLE.providerWireToolInput,
        Bun.deepEquals(read, sent) ? [] : [{ read, sent }],
      ),
    ).toEqual([]);
  });

  test("an array under a union reads its items' placeholders", () => {
    const union = {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: "string" } },
            required: ["name"],
          },
        },
        { type: "string" },
      ],
    };
    expect(
      withModelPlaceholdersOmitted(union, [{ name: "draft", note: null }]),
    ).toEqual([{ name: "draft" }]);
  });

  test('the MCP null rule does not read "" as omitted', () => {
    expect(withNullOptionalsOmitted(schema, { name: "d", note: "" })).toEqual({
      name: "d",
      note: "",
    });
  });
});
