import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { transitiveDependents } from "@/api/lib/properties/dependents";

const id = (name: string) => toSafeId<"property">(name);
const edge = (propertyId: string, dependsOnPropertyId: string) => ({
  propertyId: id(propertyId),
  dependsOnPropertyId: id(dependsOnPropertyId),
});

describe("transitiveDependents", () => {
  test("walks readers of readers and leaves unrelated columns out", () => {
    const edges = [
      edge("price", "file"),
      edge("rank", "price"),
      edge("verdict", "rank"),
      edge("other", "notes"),
    ];
    expect(transitiveDependents([id("file")], edges)).toEqual(
      new Set([id("price"), id("rank"), id("verdict")]),
    );
  });

  test("excludes the roots even inside a diamond", () => {
    const edges = [
      edge("a", "file"),
      edge("b", "file"),
      edge("c", "a"),
      edge("c", "b"),
      edge("b", "a"),
    ];
    expect(transitiveDependents([id("file"), id("a")], edges)).toEqual(
      new Set([id("b"), id("c")]),
    );
  });
});
