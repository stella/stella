import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { parseStrippingUndeclaredKeys } from "@/api/lib/chat/tool-output-degrade";

const parse = (schema: v.GenericSchema, value: unknown) =>
  parseStrippingUndeclaredKeys(schema, value);

describe("parseStrippingUndeclaredKeys", () => {
  test("a contract-clean value parses with nothing stripped", () => {
    const schema = v.strictObject({ id: v.string() });

    expect(parse(schema, { id: "a" }).unwrap()).toEqual({
      output: { id: "a" },
      undeclaredPaths: [],
    });
  });

  test("strips undeclared keys at the top level, in nested objects and in array items", () => {
    const schema = v.strictObject({
      items: v.array(v.strictObject({ label: v.string() })),
      meta: v.strictObject({ total: v.number() }),
    });
    const input = {
      extra: 1,
      items: [{ label: "a", x: 1 }, { label: "b" }, { label: "c", x: 2 }],
      meta: { total: 3, debug: "trace" },
    };
    const snapshot = structuredClone(input);

    expect(parse(schema, input).unwrap()).toEqual({
      output: {
        items: [{ label: "a" }, { label: "b" }, { label: "c" }],
        meta: { total: 3 },
      },
      undeclaredPaths: ["extra", "items[].x", "meta.debug"],
    });
    // The handler's value is never mutated.
    expect(input).toEqual(snapshot);
  });

  test("strips through optional, nullable and record wrappers", () => {
    const schema = v.strictObject({
      byId: v.record(v.string(), v.strictObject({ n: v.number() })),
      maybe: v.optional(v.nullable(v.strictObject({ n: v.number() }))),
    });

    expect(
      parse(schema, {
        byId: { a: { n: 1, extra: true } },
        maybe: { n: 2, extra: true },
      }).unwrap(),
    ).toEqual({
      output: { byId: { a: { n: 1 } }, maybe: { n: 2 } },
      undeclaredPaths: ["byId.a.extra", "maybe.extra"],
    });
    expect(parse(schema, { byId: {}, maybe: null }).unwrap()).toEqual({
      output: { byId: {}, maybe: null },
      undeclaredPaths: [],
    });
  });

  test("strips inside the matching union and variant branch only", () => {
    const schema = v.strictObject({
      result: v.variant("type", [
        v.strictObject({ type: v.literal("a"), a: v.string() }),
        v.strictObject({ type: v.literal("b"), b: v.number() }),
      ]),
      value: v.union([v.string(), v.strictObject({ n: v.number() })]),
    });

    expect(
      parse(schema, {
        result: { b: 1, type: "b", extra: "x" },
        value: { n: 1, extra: "y" },
      }).unwrap(),
    ).toEqual({
      output: { result: { b: 1, type: "b" }, value: { n: 1 } },
      undeclaredPaths: ["result.extra", "value.extra"],
    });
  });

  test("prefers the union option that needs the fewest removals", () => {
    // `{ a, b, c }` satisfies the wide option after removing only `c`; the
    // narrow option would also accept it after removing `b` and `c`, which
    // would discard a declared field.
    const schema = v.union([
      v.strictObject({ a: v.string() }),
      v.strictObject({ a: v.string(), b: v.string() }),
    ]);

    expect(parse(schema, { a: "1", b: "2", c: "3" }).unwrap()).toEqual({
      output: { a: "1", b: "2" },
      undeclaredPaths: ["c"],
    });
    // An option that already accepts the value wins outright: nothing is
    // stripped from a union member that is itself valid.
    expect(parse(schema, { a: "1", b: "2" }).unwrap()).toEqual({
      output: { a: "1", b: "2" },
      undeclaredPaths: [],
    });
  });

  test("a missing, invalid, or mixed violation fails with the original issues", () => {
    const schema = v.strictObject({
      items: v.array(v.strictObject({ label: v.string() })),
      total: v.number(),
    });

    for (const value of [
      { items: [] },
      { items: [], total: "1" },
      { items: [{ label: 1 }], total: 1 },
      { extra: true, items: [], total: "1" },
      { items: [{ label: "a", x: 1 }, { label: 2 }], total: 1 },
    ]) {
      const parsed = parse(schema, value);

      expect(Result.isError(parsed)).toBe(true);
      if (Result.isError(parsed)) {
        expect(parsed.error.issues).toEqual(
          v.safeParse(schema, value).issues ?? [],
        );
      }
    }
  });

  test("a union whose branches all fail beyond undeclared keys still fails", () => {
    const schema = v.variant("type", [
      v.strictObject({ type: v.literal("a"), a: v.string() }),
      v.strictObject({ type: v.literal("b"), b: v.number() }),
    ]);

    expect(Result.isError(parse(schema, { type: "b", b: "x", extra: 1 }))).toBe(
      true,
    );
  });

  test("never returns more than the contract allows", () => {
    const schema = v.strictObject({
      nested: v.array(v.strictObject({ k: v.string() })),
    });
    const parsed = parse(schema, {
      leak: "secret",
      nested: [{ k: "a", leak: "secret" }],
    }).unwrap();

    expect(JSON.stringify(parsed.output)).not.toContain("secret");
    expect(v.safeParse(schema, parsed.output).success).toBe(true);
  });
});
