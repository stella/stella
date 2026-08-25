import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  matterFolderPath,
  resolveMatterTarget,
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

  test("surfaces a failed create as an error instead of writing to the parent", async () => {
    const resolved = await resolveMatterTarget(
      {
        type: "pending",
        workspaceId: WORKSPACE_ID,
        name: "Pleadings",
        parentId: null,
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
