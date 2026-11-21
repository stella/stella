import { describe, expect, expectTypeOf, test } from "bun:test";
import * as v from "valibot";

import {
  ENTITY_FIND_SCOPE_TYPES,
  ENTITY_FIND_TERM_MIN_LENGTH,
} from "@stll/api-contract";
import type { EntityFindScopeType } from "@stll/api-contract";

import { tFind, tFindScope } from "@/api/lib/entities/find-schema";

describe("find schema", () => {
  test("a term cannot arrive without the scope it searches", () => {
    // The pairing is the point: a term with no scope would be a third
    // behaviour ("the name, and nothing else") no scope kind names.
    expect(v.is(tFind, { term: "lease" })).toBe(false);
    expect(
      v.is(tFind, {
        scope: { propertyIds: [], type: "all" },
        term: "lease",
      }),
    ).toBe(true);
  });
});

describe("find term length", () => {
  const scope = { propertyIds: [], type: "all" };

  test("the floor is the contract's, not a copy of it", () => {
    const minLength = tFind.entries.term.pipe.find(
      (action) => action.type === "min_length",
    );
    expect(
      minLength !== undefined && "requirement" in minLength
        ? minLength.requirement
        : undefined,
    ).toBe(ENTITY_FIND_TERM_MIN_LENGTH);
  });

  test("a term one character short is rejected, one at the floor accepted", () => {
    const short = "a".repeat(ENTITY_FIND_TERM_MIN_LENGTH - 1);
    const enough = "a".repeat(ENTITY_FIND_TERM_MIN_LENGTH);

    expect(v.is(tFind, { scope, term: short })).toBe(false);
    expect(v.is(tFind, { scope, term: enough })).toBe(true);
  });

  // The floor the SQL enforces is over the trimmed term, so the wire has to
  // measure the same string: `minLength` alone counts the padding and lets a
  // two-character term through, which is the unindexed scan the floor exists
  // to prevent. Stated as the rule rather than as cases, so a new padding
  // shape cannot slip past a fixture list.
  test.each([
    "a".repeat(ENTITY_FIND_TERM_MIN_LENGTH - 1),
    `  ${"a".repeat(ENTITY_FIND_TERM_MIN_LENGTH - 1)}  `,
    `\t${"a".repeat(ENTITY_FIND_TERM_MIN_LENGTH - 1)}\n`,
    " ".repeat(ENTITY_FIND_TERM_MIN_LENGTH + 2),
    "",
    "a".repeat(ENTITY_FIND_TERM_MIN_LENGTH),
    `  ${"a".repeat(ENTITY_FIND_TERM_MIN_LENGTH)}  `,
    `a ${"b".repeat(ENTITY_FIND_TERM_MIN_LENGTH)}`,
  ])(
    "the schema accepts %j exactly when its trimmed length clears the floor",
    (term) => {
      expect(v.is(tFind, { scope, term })).toBe(
        term.trim().length >= ENTITY_FIND_TERM_MIN_LENGTH,
      );
    },
  );
});

describe("find scope schema", () => {
  test("accepts exactly the contract's scope kinds", () => {
    // A subset would still typecheck, so pin equality: the wire schema
    // accepts exactly the contract's scope kinds, and no more.
    expectTypeOf<
      v.InferOutput<typeof tFindScope>["type"]
    >().toEqualTypeOf<EntityFindScopeType>();
    expect(tFindScope.entries.type.options).toEqual([
      ...ENTITY_FIND_SCOPE_TYPES,
    ]);
  });

  test("a scope that omits its kind is rejected, not defaulted to `all`", () => {
    // A default on the kind would widen an omitted scope to `all`, reaching
    // the row name the caller never asked for.
    const decoded = v.safeParse(tFindScope, { propertyIds: [] });

    expect(decoded.success).toBe(false);
    expect(decoded.issues?.map((issue) => v.getDotPath(issue))).toEqual([
      "type",
    ]);
  });
});
