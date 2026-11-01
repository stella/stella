import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { borrowDependencies } from "./borrowed-dependencies";

test("a borrowing copy resolves workspace packages to its own sources and shares the rest", () => {
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "stella-borrowed-dependencies-")),
  );
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  try {
    for (const root of [source, target]) {
      for (const workspace of ["reader", "renderer"]) {
        mkdirSync(path.join(root, "packages", workspace, "src"), {
          recursive: true,
        });
        writeFileSync(
          path.join(root, "packages", workspace, "src/index.ts"),
          `export const owner = ${JSON.stringify(path.basename(root))};\n`,
        );
      }
      writeFileSync(
        path.join(root, "package.json"),
        '{"workspaces":["packages/*"]}\n',
      );
    }
    mkdirSync(path.join(source, "node_modules/@stll"), { recursive: true });
    mkdirSync(path.join(source, "node_modules/left-pad"));
    writeFileSync(path.join(source, "node_modules/left-pad/index.js"), "");
    symlinkSync(
      "../../packages/reader",
      path.join(source, "node_modules/@stll/reader"),
    );
    // A workspace's own install links sibling workspaces relative to itself.
    mkdirSync(path.join(source, "packages/reader/node_modules/@stll"), {
      recursive: true,
    });
    mkdirSync(path.join(source, "packages/reader/node_modules/pinned"));
    symlinkSync(
      "../../../renderer",
      path.join(source, "packages/reader/node_modules/@stll/renderer"),
    );

    borrowDependencies(source, target);

    const resolved = (relative: string) =>
      realpathSync(path.join(target, relative));
    expect(resolved("node_modules/@stll/reader/src/index.ts")).toBe(
      path.join(target, "packages/reader/src/index.ts"),
    );
    expect(
      resolved("packages/reader/node_modules/@stll/renderer/src/index.ts"),
    ).toBe(path.join(target, "packages/renderer/src/index.ts"));
    expect(resolved("node_modules/left-pad")).toBe(
      path.join(source, "node_modules/left-pad"),
    );
    expect(resolved("packages/reader/node_modules/pinned")).toBe(
      path.join(source, "packages/reader/node_modules/pinned"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
