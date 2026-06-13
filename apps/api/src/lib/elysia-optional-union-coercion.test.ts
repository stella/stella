import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

// Canary pinning Elysia's coercion of ABSENT optional union fields.
//
// `no-coerced-optional-union-enum` (custom oxlint plugin) bans
// `t.Optional(t.UnionEnum([...]))` because an absent field is coerced
// to its FIRST member instead of `undefined`, and the migration target
// `t.Optional(t.Union([t.Literal(...)]))` does NOT coerce. Both facts
// are load-bearing. If an Elysia upgrade flips either behavior, this
// test fails — a signal to revisit the plugin and the migrated sites.

const absentField = async (schema: ReturnType<typeof t.Object>) => {
  let received: unknown = Symbol("unset");
  const app = new Elysia().get(
    "/p",
    ({ query }) => {
      received = (query as { field?: unknown }).field;
      return "ok";
    },
    { query: schema },
  );
  const res = await app.handle(new Request("http://localhost/p"));
  expect(res.status).toBe(200);
  return received;
};

describe("Elysia optional union coercion (canary)", () => {
  test("t.Optional(t.UnionEnum([...])) coerces an absent field to the FIRST member", async () => {
    const received = await absentField(
      // eslint-disable-next-line no-coerced-optional-union-enum/no-coerced-optional-union-enum -- canary deliberately pins the UnionEnum coercion behaviour
      t.Object({ field: t.Optional(t.UnionEnum(["a", "b"])) }),
    );
    expect(received).toBe("a");
  });

  test("t.Optional(t.Union([t.Literal(...)])) leaves an absent field undefined", async () => {
    const received = await absentField(
      t.Object({
        field: t.Optional(t.Union([t.Literal("a"), t.Literal("b")])),
      }),
    );
    expect(received).toBeUndefined();
  });
});
