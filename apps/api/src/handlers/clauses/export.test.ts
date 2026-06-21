import { describe, expect, test } from "bun:test";

import { buildClauseCategoryPath } from "@/api/handlers/clauses/category-path";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";

const cat = (id: string): SafeId<"clauseCategory"> =>
  toSafeId<"clauseCategory">(id);

type Node = {
  id: SafeId<"clauseCategory">;
  name: string;
  parentId: SafeId<"clauseCategory"> | null;
};

const mapOf = (nodes: Node[]) => new Map(nodes.map((node) => [node.id, node]));

describe("buildClauseCategoryPath", () => {
  test("returns null when there is no category", () => {
    expect(buildClauseCategoryPath(mapOf([]), null)).toBeNull();
  });

  test("returns a single-element path for a root category", () => {
    const map = mapOf([{ id: cat("a"), name: "Contracts", parentId: null }]);

    expect(buildClauseCategoryPath(map, cat("a"))).toEqual(["Contracts"]);
  });

  test("orders the path root-first", () => {
    const map = mapOf([
      { id: cat("root"), name: "Legal", parentId: null },
      { id: cat("mid"), name: "Contracts", parentId: cat("root") },
      { id: cat("leaf"), name: "NDAs", parentId: cat("mid") },
    ]);

    expect(buildClauseCategoryPath(map, cat("leaf"))).toEqual([
      "Legal",
      "Contracts",
      "NDAs",
    ]);
  });

  // Cycle safety is the whole point of the `visited` set: a corrupted
  // parent chain must terminate instead of looping forever.
  test("terminates on a direct self-reference cycle", () => {
    const map = mapOf([{ id: cat("a"), name: "Loop", parentId: cat("a") }]);

    expect(buildClauseCategoryPath(map, cat("a"))).toEqual(["Loop"]);
  });

  test("terminates on a multi-node cycle, collecting each name once", () => {
    const map = mapOf([
      { id: cat("a"), name: "A", parentId: cat("b") },
      { id: cat("b"), name: "B", parentId: cat("c") },
      { id: cat("c"), name: "C", parentId: cat("a") },
    ]);

    // Starting at "a": visits a -> b -> c, then c.parentId points back
    // to the already-visited "a" and the loop breaks. unshift ordering
    // yields C, B, A (root-first relative to the walk).
    expect(buildClauseCategoryPath(map, cat("a"))).toEqual(["C", "B", "A"]);
  });

  // A missing link breaks the chain: only names collected before the
  // gap survive (the partial path is still returned, not discarded).
  test("stops at the first missing ancestor and returns the partial path", () => {
    const map = mapOf([
      { id: cat("leaf"), name: "NDAs", parentId: cat("missing") },
    ]);

    expect(buildClauseCategoryPath(map, cat("leaf"))).toEqual(["NDAs"]);
  });

  test("returns null when the starting category itself is missing", () => {
    const map = mapOf([{ id: cat("other"), name: "Other", parentId: null }]);

    expect(buildClauseCategoryPath(map, cat("ghost"))).toBeNull();
  });
});
