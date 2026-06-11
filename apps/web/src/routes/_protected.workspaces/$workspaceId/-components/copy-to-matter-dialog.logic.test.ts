import { describe, expect, test } from "bun:test";

import {
  getCopyToMatterRootEntities,
  type CopyToMatterEntity,
} from "./copy-to-matter-dialog.logic";

const entity = ({
  children = [],
  entityId,
  kind = "document",
  parentId = null,
}: {
  children?: CopyToMatterEntity[];
  entityId: string;
  kind?: CopyToMatterEntity["kind"];
  parentId?: string | null;
}): CopyToMatterEntity => ({
  children,
  entityId,
  entityName: entityId,
  kind,
  parentId,
});

describe("getCopyToMatterRootEntities", () => {
  test("drops selected descendants when their selected folder already moves the subtree", () => {
    const grandchild = entity({
      entityId: "grandchild",
      parentId: "child-folder",
    });
    const childFolder = entity({
      children: [grandchild],
      entityId: "child-folder",
      kind: "folder",
      parentId: "root-folder",
    });
    const rootFolder = entity({
      children: [childFolder],
      entityId: "root-folder",
      kind: "folder",
    });
    const sibling = entity({ entityId: "sibling" });

    expect(
      getCopyToMatterRootEntities([rootFolder, grandchild, sibling]).map(
        (item) => item.entityId,
      ),
    ).toEqual(["root-folder", "sibling"]);
  });

  test("drops flat selected descendants when their selected parent already moves the subtree", () => {
    const grandchild = entity({
      entityId: "grandchild",
      parentId: "child-folder",
    });
    const childFolder = entity({
      entityId: "child-folder",
      kind: "folder",
      parentId: "root-folder",
    });
    const rootFolder = entity({
      entityId: "root-folder",
      kind: "folder",
    });
    const sibling = entity({ entityId: "sibling" });

    expect(
      getCopyToMatterRootEntities([
        rootFolder,
        childFolder,
        grandchild,
        sibling,
      ]).map((item) => item.entityId),
    ).toEqual(["root-folder", "sibling"]);
  });
});
