import { describe, expect, test } from "bun:test";

import { generateResourceTree } from "./generate-resource-tree.js";
import { RouteGenerationError } from "./generate-route-map.js";
import type { ResourceListing, ResourceNode } from "./resource-types.js";

const snapshotUrl = new URL(
  "generated/resources-snapshot.json",
  import.meta.url,
);
const snapshotResources: readonly ResourceListing[] =
  await Bun.file(snapshotUrl).json();

const showLeaf = (node: ResourceNode, name: string) => {
  if (node.kind !== "route") {
    return undefined;
  }
  const show = node.children["show"];
  if (show === undefined || show.kind !== "route") {
    return undefined;
  }
  const leaf = show.children[name];
  return leaf?.kind === "leaf" ? leaf.spec : undefined;
};

describe("generateResourceTree (S5.4)", () => {
  test("emits a `list` enumerator and one `show <name>` leaf per resource", () => {
    const tree = generateResourceTree(snapshotResources);
    expect(tree.kind).toBe("route");
    if (tree.kind !== "route") {
      return;
    }
    expect(tree.children["list"]?.kind).toBe("leaf");
    const marker = showLeaf(tree, "template-markers");
    expect(marker?.kind).toBe("show");
    if (marker?.kind === "show") {
      expect(marker.uri).toBe("stella://reference/template-markers");
      expect(marker.commandPath).toEqual([
        "reference",
        "show",
        "template-markers",
      ]);
    }
  });

  test("kebab-cases resource names into command segments", () => {
    const tree = generateResourceTree([
      { uri: "stella://reference/foo_bar", name: "foo_bar" },
    ]);
    expect(showLeaf(tree, "foo-bar")?.kind).toBe("show");
  });

  test("a duplicate resource name fails hard", () => {
    const dupes: ResourceListing[] = [
      { uri: "stella://a", name: "dup" },
      { uri: "stella://b", name: "dup" },
    ];
    expect(() => generateResourceTree(dupes)).toThrow(RouteGenerationError);
  });

  test("build-time and a mocked resources/list produce the same tree (parity)", () => {
    const wire = snapshotResources.map((resource) => ({ ...resource }));
    const mock: readonly ResourceListing[] = structuredClone(wire);
    expect(generateResourceTree(mock)).toEqual(
      generateResourceTree(snapshotResources),
    );
  });
});
