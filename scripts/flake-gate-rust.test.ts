import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { selectRustTargets } from "./flake-gate-rust";

const withFixture = (run: (root: string) => void) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flake-gate-rust-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const write = (root: string, file: string, contents: string) => {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
};

test("changed Rust modules with unit tests select one crate/module target", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture-crate"\nversion = "0.1.0"\n',
    );
    write(
      root,
      "src/feature.rs",
      "pub fn feature() {}\n#[cfg(test)]\nmod tests { #[test] fn inline_works() {} }\n",
    );
    write(
      root,
      "src/feature/tests.rs",
      "#[tokio::test]\nasync fn works() {}\n",
    );

    expect(
      selectRustTargets(root, ["src/feature.rs", "src/feature/tests.rs"]),
    ).toEqual({
      targets: [
        {
          file: "src/feature.rs",
          cwd: root,
          crate: "fixture-crate",
          module: "feature",
        },
      ],
      unsupported: [],
    });
  });
});

test("changed files without a discoverable test are reported as unsupported", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(root, "src/lib.rs", "pub fn library() {}\n");
    write(root, "src/other.rs", "pub fn other() {}\n");

    expect(selectRustTargets(root, ["src/other.rs", "README.md"])).toEqual({
      targets: [],
      unsupported: [
        {
          file: "src/other.rs",
          reason: "changed file has no test in module other",
        },
      ],
    });
  });
});

test("a changed production module does not select an unchanged descendant test", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(root, "src/feature.rs", "pub fn feature() {}\n");
    write(root, "src/feature/tests.rs", "#[test]\nfn unchanged_test() {}\n");

    expect(selectRustTargets(root, ["src/feature.rs"])).toEqual({
      targets: [],
      unsupported: [
        {
          file: "src/feature.rs",
          reason: "changed file has no test in module feature",
        },
      ],
    });
  });
});

test("deleted and integration-test files remain explicit unsupported cases", () => {
  withFixture((root) => {
    write(
      root,
      "Cargo.toml",
      '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    );
    write(
      root,
      "src/lib.rs",
      "#[cfg(test)]\nmod tests { #[test] fn works() {} }\n",
    );
    write(root, "tests/integration.rs", "#[test]\nfn works() {}\n");

    expect(
      selectRustTargets(root, ["src/deleted.rs", "tests/integration.rs"]),
    ).toEqual({
      targets: [],
      unsupported: [
        { file: "src/deleted.rs", reason: "file is deleted or unavailable" },
        {
          file: "tests/integration.rs",
          reason: "non-src Rust targets need an explicit Cargo target selector",
        },
      ],
    });
  });
});

test("non-Rust changes avoid Cargo manifest discovery", () => {
  expect(selectRustTargets("/missing/repository", ["README.md"])).toEqual({
    targets: [],
    unsupported: [],
  });
});

test("workspace manifests resolve files to the nearest package", () => {
  withFixture((root) => {
    write(root, "Cargo.toml", '[workspace]\nmembers = ["crates/inner"]\n');
    write(
      root,
      "crates/inner/Cargo.toml",
      '[package]\nname = "inner"\nversion = "0.1.0"\n',
    );
    write(
      root,
      "crates/inner/src/lib.rs",
      "#[cfg(test)]\nmod tests { #[test] fn works() {} }\n",
    );

    expect(selectRustTargets(root, ["crates/inner/src/lib.rs"])).toEqual({
      targets: [
        {
          file: "crates/inner/src/lib.rs",
          cwd: path.join(root, "crates/inner"),
          crate: "inner",
          module: "",
        },
      ],
      unsupported: [],
    });
  });
});
