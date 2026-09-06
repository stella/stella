import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import type { Static } from "elysia";

import { ENTITY_FIND_SCOPE_TYPES } from "@stll/api-contract";
import type { EntityFindScopeType } from "@stll/api-contract";

import { tFind, tFindScope } from "@/api/lib/entities/find-schema";

// A subset would still typecheck, so bind both directions: the wire schema
// accepts exactly the contract's scope kinds, and no more.
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const wireTypeMatchesContract: AssertEqual<
  Static<typeof tFindScope>["type"],
  EntityFindScopeType
> = true;

describe("find schema", () => {
  test("a term cannot arrive without the scope it searches", () => {
    // The pairing is the point: a term with no scope would be a third
    // behaviour ("the name, and nothing else") no scope kind names.
    expect(Value.Check(tFind, { term: "lease" })).toBe(false);
    expect(
      Value.Check(tFind, {
        scope: { propertyIds: [], type: "all" },
        term: "lease",
      }),
    ).toBe(true);
  });
});

describe("find scope schema", () => {
  test("accepts exactly the contract's scope kinds", () => {
    expect(wireTypeMatchesContract).toBe(true);
    expect(tFindScope.properties.type.anyOf.map((member) => member.const)) //
      .toEqual([...ENTITY_FIND_SCOPE_TYPES]);
  });

  test("a scope that omits its kind is rejected, not defaulted to `all`", () => {
    // `t.UnionEnum` would advertise a default of the first member, and Elysia
    // fills defaults before validating. The scope would then widen to `all`,
    // reaching the row name the caller never asked for.
    const scope = Value.Default(tFindScope, { propertyIds: [] });

    expect(Value.Check(tFindScope, scope)).toBe(false);
  });
});
