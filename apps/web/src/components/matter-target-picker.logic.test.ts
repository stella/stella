import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  canMoveMatterFolder,
  discardPendingMatterFolder,
  matterFolderPath,
  matterFolderMoveDestinations,
  reparentPendingMatterFolder,
  resolveMatterTarget,
  selectExistingMatterTarget,
  selectPendingMatterTarget,
  stageMatterFolder,
} from "@/components/matter-target-picker.logic";
import type { MatterTarget } from "@/components/matter-target-picker.logic";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FOLDER_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_ID = "33333333-3333-4333-8333-333333333333";

type CreateCall = {
  workspaceId: string;
  parentId: string | null;
  name: string;
};

const recordingCreate = (entityId: string) => {
  const calls: CreateCall[] = [];
  return {
    calls,
    createFolder: async (folder: CreateCall) => {
      calls.push(folder);
      return await Promise.resolve({ entityId });
    },
  };
};

describe("staging a folder in the matter picker", () => {
  test("hangs the new folder off whatever is selected now", () => {
    const target = {
      type: "existing",
      workspaceId: WORKSPACE_ID,
      parentId: FOLDER_ID,
    } as const satisfies MatterTarget;

    expect(stageMatterFolder(target, "Pleadings")).toEqual({
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: FOLDER_ID,
      selection: { type: "pending" },
    });
  });

  test("restages against the pending folder's parent, never inside it", () => {
    const staged = stageMatterFolder(
      { type: "existing", workspaceId: WORKSPACE_ID, parentId: FOLDER_ID },
      "Pleadings",
    );
    if (staged === null) {
      throw new Error("a non-blank name must stage a pending folder");
    }

    // Staging again must replace the pending folder, not nest under it.
    expect(stageMatterFolder(staged, "Exhibits")).toEqual({
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Exhibits",
      parentId: FOLDER_ID,
      selection: { type: "pending" },
    });
  });

  test("trims the name and rejects one that is blank once trimmed", () => {
    const root = {
      type: "existing",
      workspaceId: WORKSPACE_ID,
      parentId: null,
    } as const satisfies MatterTarget;

    expect(stageMatterFolder(root, "  Exhibits  ")).toMatchObject({
      name: "Exhibits",
      parentId: null,
    });
    expect(stageMatterFolder(root, "   ")).toBeNull();
    expect(stageMatterFolder(root, "")).toBeNull();
  });

  test("reparents a staged folder without resolving it", () => {
    const pending = {
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: FOLDER_ID,
      selection: { type: "pending" },
    } as const satisfies MatterTarget;

    expect(reparentPendingMatterFolder(pending, CREATED_ID)).toEqual({
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: CREATED_ID,
      selection: { type: "pending" },
    });
    expect(reparentPendingMatterFolder(pending, null)).toEqual({
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: null,
      selection: { type: "pending" },
    });
  });

  test("keeps the same staged target for a no-op move", () => {
    const pending = {
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: FOLDER_ID,
      selection: { type: "pending" },
    } as const satisfies MatterTarget;

    expect(reparentPendingMatterFolder(pending, FOLDER_ID)).toBe(pending);
  });

  test("keeps the staged folder when another destination is selected", () => {
    const pending = {
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: null,
      selection: { type: "pending" },
    } as const satisfies MatterTarget;

    const selectedElsewhere = selectExistingMatterTarget(pending, FOLDER_ID);
    expect(selectedElsewhere).toEqual({
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: null,
      selection: { type: "existing", parentId: FOLDER_ID },
    });
    if (selectedElsewhere.type !== "pending") {
      throw new Error("selecting elsewhere must preserve the staged folder");
    }
    expect(selectPendingMatterTarget(selectedElsewhere)).toEqual(pending);
  });

  test("discards the staged folder without losing the existing destination", () => {
    const pending = {
      type: "pending",
      workspaceId: WORKSPACE_ID,
      name: "Pleadings",
      parentId: FOLDER_ID,
      selection: { type: "existing", parentId: CREATED_ID },
    } as const satisfies MatterTarget;

    expect(discardPendingMatterFolder(pending)).toEqual({
      type: "existing",
      workspaceId: WORKSPACE_ID,
      parentId: CREATED_ID,
    });
    expect(
      discardPendingMatterFolder({
        type: "pending",
        workspaceId: WORKSPACE_ID,
        name: "Pleadings",
        parentId: FOLDER_ID,
        selection: { type: "pending" },
      }),
    ).toEqual({
      type: "existing",
      workspaceId: WORKSPACE_ID,
      parentId: FOLDER_ID,
    });
  });
});

describe("revealing a folder's path in the matter picker", () => {
  const TREE = [
    { entityId: "root", parentId: null },
    { entityId: "child", parentId: "root" },
    { entityId: "grandchild", parentId: "child" },
  ];

  test("returns the folder and every folder above it, root-first", () => {
    expect(matterFolderPath(TREE, "grandchild")).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
  });

  test("has no path for the matter root", () => {
    expect(matterFolderPath(TREE, null)).toEqual([]);
  });

  test("stops at a parent the tree does not contain", () => {
    expect(
      matterFolderPath([{ entityId: "orphan", parentId: "gone" }], "orphan"),
    ).toEqual(["orphan"]);
  });

  test("terminates on a cycle instead of hanging", () => {
    const cycle = [
      { entityId: "a", parentId: "b" },
      { entityId: "b", parentId: "a" },
    ];
    expect(matterFolderPath(cycle, "a")).toEqual(["b", "a"]);
  });
});

describe("moving folders in the matter picker", () => {
  const TREE = [
    { entityId: "root", parentId: null },
    { entityId: "sibling", parentId: null },
    { entityId: "child", parentId: "root" },
    { entityId: "grandchild", parentId: "child" },
  ];

  test("allows reparenting to another branch or the matter root", () => {
    expect(canMoveMatterFolder(TREE, "child", "sibling")).toBe(true);
    expect(canMoveMatterFolder(TREE, "child", null)).toBe(true);
  });

  test("rejects no-op, self, and descendant destinations", () => {
    expect(canMoveMatterFolder(TREE, "child", "root")).toBe(false);
    expect(canMoveMatterFolder(TREE, "child", "child")).toBe(false);
    expect(canMoveMatterFolder(TREE, "child", "grandchild")).toBe(false);
  });

  test("rejects folders and destinations outside the loaded tree", () => {
    expect(canMoveMatterFolder(TREE, "missing", null)).toBe(false);
    expect(canMoveMatterFolder(TREE, "child", "missing")).toBe(false);
  });
});

describe("choosing a folder move destination with the keyboard", () => {
  const TREE = [
    { entityId: "correspondence", parentId: null, name: "Correspondence" },
    { entityId: "client", parentId: "correspondence", name: "Client" },
    { entityId: "archive", parentId: "correspondence", name: "Archive" },
    { entityId: "other", parentId: null, name: "Other" },
    { entityId: "other-archive", parentId: "other", name: "Archive" },
  ];

  test("excludes no-op and cyclic parents from the menu", () => {
    expect(
      matterFolderMoveDestinations(
        TREE,
        {
          kind: "existing",
          folderId: "correspondence",
          parentId: null,
        },
        "(Root folder)",
      ),
    ).toEqual([
      { parentId: "other", name: "Other" },
      { parentId: "other-archive", name: "Other / Archive" },
    ]);
  });

  test("disambiguates duplicate names with their ancestor paths", () => {
    expect(
      matterFolderMoveDestinations(
        TREE,
        { kind: "existing", folderId: "client", parentId: "correspondence" },
        "(Root folder)",
      ),
    ).toContainEqual({
      parentId: "other-archive",
      name: "Other / Archive",
    });
  });

  test("numbers destinations deterministically when full paths are identical", () => {
    const duplicatePaths = [
      { entityId: "root-a", parentId: null, name: "Client" },
      { entityId: "root-b", parentId: null, name: "Client" },
      { entityId: "folder-a", parentId: "root-a", name: "Files" },
      { entityId: "folder-b", parentId: "root-b", name: "Files" },
    ];

    const destinations = matterFolderMoveDestinations(
      duplicatePaths,
      { kind: "pending", parentId: null },
      "(Root folder)",
    );

    expect(destinations).toContainEqual({
      parentId: "folder-a",
      name: "Client / Files (1)",
    });
    expect(destinations).toContainEqual({
      parentId: "folder-b",
      name: "Client / Files (2)",
    });
  });

  test("keeps every valid parent for a pending folder", () => {
    const destinations = matterFolderMoveDestinations(
      TREE,
      { kind: "pending", parentId: "other" },
      "(Root folder)",
    );

    expect(destinations).toContainEqual({
      parentId: "client",
      name: "Client",
    });
    expect(destinations.some(({ parentId }) => parentId === "other")).toBe(
      false,
    );
  });
});

describe("resolving a matter target before a write", () => {
  test("passes an existing target through without creating anything", async () => {
    const { calls, createFolder } = recordingCreate(CREATED_ID);

    const resolved = await resolveMatterTarget(
      { type: "existing", workspaceId: WORKSPACE_ID, parentId: FOLDER_ID },
      createFolder,
    );

    expect(calls).toEqual([]);
    expect(resolved).toEqual(
      Result.ok({ workspaceId: WORKSPACE_ID, parentId: FOLDER_ID }),
    );
  });

  test("creates the staged folder once and writes into it", async () => {
    const { calls, createFolder } = recordingCreate(CREATED_ID);

    const resolved = await resolveMatterTarget(
      {
        type: "pending",
        workspaceId: WORKSPACE_ID,
        name: "Pleadings",
        parentId: FOLDER_ID,
        selection: { type: "pending" },
      },
      createFolder,
    );

    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, parentId: FOLDER_ID, name: "Pleadings" },
    ]);
    expect(resolved).toEqual(
      Result.ok({ workspaceId: WORKSPACE_ID, parentId: CREATED_ID }),
    );
  });

  test("creates a staged folder but writes to a later selected destination", async () => {
    const { calls, createFolder } = recordingCreate(CREATED_ID);

    const resolved = await resolveMatterTarget(
      {
        type: "pending",
        workspaceId: WORKSPACE_ID,
        name: "Pleadings",
        parentId: null,
        selection: { type: "existing", parentId: FOLDER_ID },
      },
      createFolder,
    );

    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, parentId: null, name: "Pleadings" },
    ]);
    expect(resolved).toEqual(
      Result.ok({ workspaceId: WORKSPACE_ID, parentId: FOLDER_ID }),
    );
  });

  test("surfaces a failed create as an error instead of writing to the parent", async () => {
    const resolved = await resolveMatterTarget(
      {
        type: "pending",
        workspaceId: WORKSPACE_ID,
        name: "Pleadings",
        parentId: null,
        selection: { type: "pending" },
      },
      async () => {
        throw new Error("Entities limit reached");
      },
    );

    expect(Result.isError(resolved)).toBe(true);
    expect(Result.isError(resolved) && resolved.error.message).toContain(
      "Entities limit reached",
    );
  });
});
