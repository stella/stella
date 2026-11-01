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
      mkdirSync(path.join(root, "packages/reader/src"), { recursive: true });
      writeFileSync(
        path.join(root, "packages/reader/src/index.ts"),
        `export const owner = ${JSON.stringify(path.basename(root))};\n`,
      );
    }
    mkdirSync(path.join(source, "node_modules/@stll"), { recursive: true });
    mkdirSync(path.join(source, "node_modules/left-pad"));
    writeFileSync(path.join(source, "node_modules/left-pad/index.js"), "");
    symlinkSync(
      "../../packages/reader",
      path.join(source, "node_modules/@stll/reader"),
    );
    mkdirSync(path.join(source, "packages/reader/node_modules"));

    borrowDependencies(source, target);

    expect(
      realpathSync(path.join(target, "node_modules/@stll/reader/src/index.ts")),
    ).toBe(path.join(target, "packages/reader/src/index.ts"));
    expect(realpathSync(path.join(target, "node_modules/left-pad"))).toBe(
      path.join(source, "node_modules/left-pad"),
    );
    expect(
      realpathSync(path.join(target, "packages/reader/node_modules")),
    ).toBe(path.join(source, "packages/reader/node_modules"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
