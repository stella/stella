import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectRustTargets } from "./flake-gate-rust";

const root = path.resolve(import.meta.dir, "..");
const attributeHeader = /#\s*\[\s*([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)(\s*)/gu;
const compareText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

type AttributeShape = { path: string; hasArgs: boolean };

const trackedRustFiles = () => {
  const result = Bun.spawnSync(["git", "ls-files", "--", "*.rs"], {
    cwd: root,
  });
  if (!result.success) {
    throw new TypeError("Cannot enumerate tracked Rust files");
  }
  return result.stdout.toString().trim().split("\n").filter(Boolean);
};

const rustTestAttributeShapes = (): AttributeShape[] => {
  const shapes = new Map<string, AttributeShape>();
  for (const file of trackedRustFiles()) {
    const contents = readFileSync(path.join(root, file), "utf-8");
    for (const match of contents.matchAll(attributeHeader)) {
      const testAttributePath = match[1];
      if (
        testAttributePath === undefined ||
        !["test", "test_case"].includes(
          testAttributePath.split("::").at(-1) ?? "",
        )
      ) {
        continue;
      }
      const hasArgs = contents[match.index + match[0].length] === "(";
      const key = `${testAttributePath}:${hasArgs}`;
      shapes.set(key, {
        path: testAttributePath,
        hasArgs,
      });
    }
  }
  return [...shapes.values()].toSorted(
    (left, right) =>
      compareText(left.path, right.path) ||
      Number(left.hasArgs) - Number(right.hasArgs),
  );
};

const withFixture = (run: (fixtureRoot: string) => void) => {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "flake-gate-rust-census-"),
  );
  try {
    writeFileSync(
      path.join(fixtureRoot, "Cargo.toml"),
      '[package]\nname = "attribute-census"\nversion = "0.1.0"\n',
    );
    mkdirSync(path.join(fixtureRoot, "src"));
    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};

test("tracked Rust test attributes remain within the supported detector census", () => {
  const shapes = rustTestAttributeShapes();
  expect(shapes).toMatchInlineSnapshot(`
    [
      {
        "hasArgs": false,
        "path": "test",
      },
      {
        "hasArgs": false,
        "path": "tokio::test",
      },
      {
        "hasArgs": true,
        "path": "tokio::test",
      },
    ]
  `);

  for (const { path: attributePath, hasArgs } of shapes) {
    withFixture((fixtureRoot) => {
      const argumentsText = hasArgs ? "(fixture)" : "";
      writeFileSync(
        path.join(fixtureRoot, "src/lib.rs"),
        `#[${attributePath}${argumentsText}]\nfn selected_by_detector() {}\n`,
      );
      expect(selectRustTargets(fixtureRoot, ["src/lib.rs"]).targets).toEqual([
        {
          file: "src/lib.rs",
          cwd: fixtureRoot,
          crate: "attribute-census",
          module: "",
        },
      ]);
    });
  }
});
