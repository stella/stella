import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { workspaceSources } from "./workspace-source-files.ts";

test("workspace source inventory retains authored files without reading ignored build outputs", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "workspace-source-inventory-"),
  );
  try {
    execFileSync("git", ["init", "--quiet"], {
      cwd: directory,
      maxBuffer: 1024 * 1024,
    });
    mkdirSync(path.join(directory, "apps/api/generated"), { recursive: true });
    mkdirSync(path.join(directory, "packages/example"), { recursive: true });
    writeFileSync(path.join(directory, ".gitignore"), "apps/api/generated/\n");
    const tracked = "apps/api/generated/tracked.ts";
    const deleted = "packages/example/deleted.ts";
    const renamed = "packages/example/old name\nfile.ts";
    const renamedTo = "packages/example/renamed source\nfile.ts";
    for (const file of [tracked, deleted, renamed]) {
      writeFileSync(path.join(directory, file), "export {};\n");
    }
    execFileSync("git", ["add", "--force", "--", tracked, deleted, renamed], {
      cwd: directory,
      maxBuffer: 1024 * 1024,
    });
    rmSync(path.join(directory, deleted));
    renameSync(path.join(directory, renamed), path.join(directory, renamedTo));
    const local = "packages/example/new source\nfile.tsx";
    writeFileSync(path.join(directory, local), "export {};\n");
    const output = path.join(directory, "apps/api/generated/transient.ts");
    writeFileSync(output, "export {};\n");
    writeFileSync(path.join(directory, "packages/example/data.json"), "{}");

    const files = workspaceSources(directory).toSorted();
    expect(files).toEqual([tracked, local, renamedTo].toSorted());
    rmSync(output);
    expect(
      files.map((file) => readFileSync(path.join(directory, file), "utf-8")),
    ).toEqual(["export {};\n", "export {};\n", "export {};\n"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
