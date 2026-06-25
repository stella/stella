import { describe, expect, test } from "bun:test";

import {
  getCopyToMatterRootEntities,
  resolveAncestorIds,
  type CopyToMatterEntity,
} from "./copy-to-matter-dialog.logic";

const entity = ({
  ancestorIds = [],
  entityId,
  kind = "document",
}: {
  ancestorIds?: string[];
  entityId: string;
  kind?: CopyToMatterEntity["kind"];
}): CopyToMatterEntity => ({
  ancestorIds,
  entityId,
  entityName: entityId,
  kind,
});

describe("resolveAncestorIds", () => {
  test("walks the immediate-parent chain to the root", () => {
    const parentById = new Map<string, string | null>([
      ["root-folder", null],
      ["child-folder", "root-folder"],
      ["grandchild", "child-folder"],
    ]);

    expect(resolveAncestorIds("grandchild", parentById)).toEqual([
      "child-folder",
      "root-folder",
    ]);
  });

  test("crosses unselected intermediate folders absent from the selection", () => {
    // The lookup spans every entity, so the chain stays unbroken even though
    // "child-folder" is not part of the dragged selection.
    const parentById = new Map<string, string | null>([
      ["root-folder", null],
      ["child-folder", "root-folder"],
      ["grandchild", "child-folder"],
    ]);

    expect(resolveAncestorIds("grandchild", parentById)).toContain(
      "root-folder",
    );
  });

  test("stops on a cyclic parent link", () => {
    const parentById = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);

    expect(resolveAncestorIds("a", parentById)).toEqual(["b"]);
  });
});

describe("getCopyToMatterRootEntities", () => {
  test("drops a selected descendant whose selected folder already moves the subtree", () => {
    const rootFolder = entity({ entityId: "root-folder", kind: "folder" });
    const grandchild = entity({
      ancestorIds: ["child-folder", "root-folder"],
      entityId: "grandchild",
    });
    const sibling = entity({ entityId: "sibling" });

    expect(
      getCopyToMatterRootEntities([rootFolder, grandchild, sibling]).map(
        (item) => item.entityId,
      ),
    ).toEqual(["root-folder", "sibling"]);
  });

  test("drops a descendant nested below an unselected intermediate folder", () => {
    // The reported bug: folder + a nested descendant under an unselected
    // intermediate folder. Without the full ancestor chain the descendant
    // would be copied twice (once inside the subtree, once as a root).
    const rootFolder = entity({ entityId: "root-folder", kind: "folder" });
    const grandchild = entity({
      ancestorIds: ["unselected-child-folder", "root-folder"],
      entityId: "grandchild",
    });

    expect(
      getCopyToMatterRootEntities([rootFolder, grandchild]).map(
        (item) => item.entityId,
      ),
    ).toEqual(["root-folder"]);
  });

  test("keeps an entity whose ancestors are all unselected", () => {
    const grandchild = entity({
      ancestorIds: ["unselected-child-folder", "unselected-root-folder"],
      entityId: "grandchild",
    });
    const sibling = entity({ entityId: "sibling" });

    expect(
      getCopyToMatterRootEntities([grandchild, sibling]).map(
        (item) => item.entityId,
      ),
    ).toEqual(["grandchild", "sibling"]);
  });
});
