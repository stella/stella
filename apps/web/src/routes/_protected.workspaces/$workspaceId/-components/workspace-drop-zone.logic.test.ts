import { expect, test } from "bun:test";

import {
  resolveWorkspaceDropUploadParentId,
  uploadWorkspaceDrop,
} from "./workspace-drop-zone.logic";

const views = [
  { id: "table", layout: { type: "table" as const } },
  { id: "files", layout: { type: "filesystem" as const } },
];

test("resolves a folder only for the active filesystem view", () => {
  expect(
    resolveWorkspaceDropUploadParentId({
      activeViewId: "files",
      currentFolderId: "folder-1",
      views,
    }),
  ).toBe("folder-1");
  expect(
    resolveWorkspaceDropUploadParentId({
      activeViewId: "table",
      currentFolderId: "folder-1",
      views,
    }),
  ).toBeNull();
});

test("a drop waits for loading views and is then uploaded", async () => {
  let finishLoading: ((loaded: typeof views) => void) | undefined;
  const loading = new Promise<typeof views>((resolve) => {
    finishLoading = resolve;
  });
  const uploaded: { files: File[]; parentId: string | null }[] = [];
  const files = [new File(["content"], "evidence.txt")];

  const drop = uploadWorkspaceDrop({
    activeViewId: "files",
    currentFolderId: "folder-1",
    input: { files },
    loadViews: async () => await loading,
    upload: (input) => {
      uploaded.push(input);
    },
  });

  expect(uploaded).toEqual([]);
  finishLoading?.(views);
  await drop;
  expect(uploaded).toEqual([{ files, parentId: "folder-1" }]);
});

test("a second drop is forwarded while the previous upload is pending", async () => {
  const uploaded: { files: File[]; parentId: string | null }[] = [];
  const loadViews = async () => views;
  const upload = (input: { files: File[]; parentId: string | null }) => {
    uploaded.push(input);
  };
  const firstFiles = [new File(["first"], "first.txt")];
  const secondFiles = [new File(["second"], "second.txt")];

  await Promise.all([
    uploadWorkspaceDrop({
      activeViewId: "files",
      currentFolderId: null,
      input: { files: firstFiles },
      loadViews,
      upload,
    }),
    uploadWorkspaceDrop({
      activeViewId: "files",
      currentFolderId: null,
      input: { files: secondFiles },
      loadViews,
      upload,
    }),
  ]);

  expect(uploaded).toEqual([
    { files: firstFiles, parentId: null },
    { files: secondFiles, parentId: null },
  ]);
});
