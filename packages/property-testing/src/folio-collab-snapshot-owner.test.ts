import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { rejectionOf } from "./rejection";

const ROOT = path.join(import.meta.dir, "../../..");
const OWNER = "apps/api/src/lib/files/folio-collab-snapshot-loader.ts";

const git = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    return panic("Folio snapshot source inventory requires a Git checkout");
  }
  return new TextDecoder().decode(result.stdout);
};

const sourceFiles = (root: string): string[] =>
  [
    ...new Set(
      git(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "apps",
      ]).split("\0"),
    ),
  ]
    .filter(
      (file) =>
        !path.basename(file).includes(".test.") && /\.tsx?$/u.test(file),
    )
    .toSorted()
    .map((file) => path.join(root, file));

const expectSnapshotOwner = async (root: string) => {
  const rawLoadSites: string[] = [];
  for (const sourcePath of sourceFiles(root)) {
    const source = await Bun.file(sourcePath).text();
    if (source.includes("migrateFolioYjsSnapshot")) {
      rawLoadSites.push(repoRelativePath(root, sourcePath));
    }
  }
  expect(rawLoadSites).toEqual([OWNER]);
};

test("persisted Folio snapshots can only enter through the load owner", async () => {
  await expectSnapshotOwner(ROOT);

  const roomStore = await Bun.file(
    path.join(ROOT, "apps/api/src/lib/folio-collab-rooms.ts"),
  ).text();
  expect(roomStore).toContain("loadPersistedFolioSnapshot({");
});

test("the load-owner scan ignores temporary trees but rejects real extra owners and unreadable sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folio-source-inventory-"));
  try {
    git(root, ["init", "--quiet"]);
    await mkdir(path.dirname(path.join(root, OWNER)), { recursive: true });
    await Bun.write(
      path.join(root, OWNER),
      "migrateFolioYjsSnapshot(snapshot);\n",
    );
    git(root, ["add", "--", OWNER]);
    await Bun.write(
      path.join(root, ".gitignore"),
      "apps/landing/.base-check-*/\n",
    );
    const temporaryTree = path.join(root, "apps/landing/.base-check-fixture");
    await mkdir(path.join(temporaryTree, "src"), { recursive: true });
    await Bun.write(
      path.join(temporaryTree, "src/copied-owner.ts"),
      "migrateFolioYjsSnapshot(snapshot);\n",
    );

    // An ignored checkout may disappear while another package's tests run.
    expect(sourceFiles(root)).toEqual([path.join(root, OWNER)]);
    await rm(temporaryTree, { recursive: true });
    await expectSnapshotOwner(root);

    const extraOwner = "apps/new.test.client/src/extra-owner.tsx";
    await mkdir(path.dirname(path.join(root, extraOwner)), { recursive: true });
    await Bun.write(
      path.join(root, extraOwner),
      "migrateFolioYjsSnapshot(snapshot);\n",
    );
    expect(await rejectionOf(expectSnapshotOwner(root))).toMatchObject({
      message: expect.stringContaining(extraOwner),
    });
    git(root, ["add", "--", extraOwner]);
    await Bun.write(
      path.join(root, ".gitignore"),
      `apps/landing/.base-check-*/\n${extraOwner}\n`,
    );
    expect(await rejectionOf(expectSnapshotOwner(root))).toMatchObject({
      message: expect.stringContaining(extraOwner),
    });

    // A missing real source must still fail, rather than hiding an owner.
    await rm(path.join(root, extraOwner));
    expect(await rejectionOf(expectSnapshotOwner(root))).toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
