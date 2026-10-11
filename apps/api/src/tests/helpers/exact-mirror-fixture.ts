import { Type } from "@sinclair/typebox";
import { t } from "elysia";

// Verifies detection of recursive-schema serializer failures for a route body
// containing `t.Recursive` wrapped in `Type.Unsafe`.
export const SELF_TEST_ROUTE = "/exact-mirror-self-test/recursive";

export const buildRecursiveFixtureApp = async () => {
  const { Elysia } = await import("elysia");
  const recursiveNode = Type.Unsafe(
    t.Recursive((self) =>
      t.Union([
        t.Object({ type: t.Literal("leaf"), value: t.String() }),
        t.Object({ type: t.Literal("group"), children: t.Array(self) }),
      ]),
    ),
  );

  return new Elysia().post(SELF_TEST_ROUTE, () => "ok", {
    body: t.Object({ filters: t.Array(recursiveNode) }),
  });
};
