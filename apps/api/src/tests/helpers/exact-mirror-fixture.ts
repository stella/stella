import { t } from "elysia";
import { Type } from "typebox";

// Verifies detection of recursive-schema serializer failures for a route body
// containing `Type.Cyclic`.
export const SELF_TEST_ROUTE = "/exact-mirror-self-test/recursive";

export const buildRecursiveFixtureApp = async () => {
  const { Elysia } = await import("elysia");
  const recursiveNode = Type.Cyclic(
    {
      node: t.Union([
        t.Object({ type: t.Literal("leaf"), value: t.String() }),
        t.Object({
          type: t.Literal("group"),
          children: t.Array(Type.Ref("node")),
        }),
      ]),
    },
    "node",
  );

  return new Elysia().post(
    SELF_TEST_ROUTE,
    {
      body: t.Object({ filters: t.Array(recursiveNode) }),
    },
    () => "ok",
  );
};
