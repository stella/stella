import { expect, test } from "bun:test";

import {
  checkTauriPackageAlignment,
  requiresTauriAlignment,
} from "./check-tauri-package-alignment";

const npmFixture = (packages: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 1,
    packages: Object.fromEntries(
      Object.entries(packages).map(([key, resolution]) => [
        key,
        [resolution, "", {}, "sha512-fixture"],
      ]),
    ),
  }).replace(/\}\}$/u, "},}");

const cargoFixture = (packages: readonly [string, string][]) =>
  `version = 4\n${packages
    .map(
      ([name, version]) =>
        `[[package]]\nname = "${name}"\nversion = "${version}"\n`,
    )
    .join("\n")}`;

test("rejects npm 2.11 against the 2.12 crate and accepts aligned releases", () => {
  const cargo = cargoFixture([["tauri", "2.12.0"]]);
  const drifted = npmFixture({
    "@tauri-apps/api": "@tauri-apps/api@2.11.1",
    "@tauri-apps/cli": "@tauri-apps/cli@2.11.5",
  });
  expect(checkTauriPackageAlignment(drifted, cargo)).toEqual([
    "@tauri-apps/api@2.11.1 differs from tauri@2.12.0 (major.minor)",
    "@tauri-apps/cli@2.11.5 differs from tauri@2.12.0 (major.minor)",
  ]);
  const aligned = npmFixture({
    "@tauri-apps/api": "@tauri-apps/api@2.12.0",
    "@tauri-apps/cli": "@tauri-apps/cli@2.12.0",
  });
  expect(checkTauriPackageAlignment(aligned, cargo)).toEqual([]);
});

test("derives any plugin name and checks CLI platform bindings", () => {
  for (const name of ["updater", "future-plugin", "clipboard-manager"]) {
    for (const [npmVersion, cargoVersion, aligned] of [
      ["2.12.0", "2.12.99", true],
      ["2.12.99", "2.12.0", true],
      ["2.11.0", "2.12.0", false],
      ["3.12.0", "2.12.0", false],
    ] as const) {
      const npm = npmFixture({
        "@tauri-apps/cli-linux-riscv64-gnu": `@tauri-apps/cli-linux-riscv64-gnu@${npmVersion}`,
        [`@tauri-apps/plugin-${name}`]: `@tauri-apps/plugin-${name}@${npmVersion}`,
      });
      const cargo = cargoFixture([
        ["tauri", cargoVersion],
        [`tauri-plugin-${name}`, cargoVersion],
      ]);
      expect(checkTauriPackageAlignment(npm, cargo)).toHaveLength(
        aligned ? 0 : 2,
      );
    }
  }
});

test("unknown Tauri packages force a pair-rule decision", () => {
  for (const name of ["new-package", "cli-helper"]) {
    expect(
      checkTauriPackageAlignment(
        npmFixture({
          [`@tauri-apps/${name}`]: `@tauri-apps/${name}@2.12.0`,
        }),
        cargoFixture([["tauri", "2.12.0"]]),
      ),
    ).toEqual([
      `@tauri-apps/${name}@2.12.0: no Tauri pair rule (add one to TAURI_PAIR_RULES)`,
    ]);
  }
});

test("checks nested duplicate resolutions and aliases by resolved name", () => {
  expect(
    checkTauriPackageAlignment(
      npmFixture({
        "@tauri-apps/api": "@tauri-apps/api@2.12.0",
        "other/@tauri-apps/api": "@tauri-apps/api@2.11.1",
        alias: "@tauri-apps/plugin-opener@2.5.0",
      }),
      cargoFixture([
        ["tauri", "2.12.0"],
        ["tauri-plugin-opener", "2.6.0"],
      ]),
    ),
  ).toEqual([
    "@tauri-apps/api@2.11.1 differs from tauri@2.12.0 (major.minor)",
    "@tauri-apps/plugin-opener@2.5.0 differs from tauri-plugin-opener@2.6.0 (major.minor)",
  ]);
});

test("checks every crate resolution and fails on missing counterparts", () => {
  const npm = npmFixture({ "@tauri-apps/api": "@tauri-apps/api@2.12.0" });
  expect(
    checkTauriPackageAlignment(
      npm,
      cargoFixture([
        ["tauri", "2.12.0"],
        ["tauri", "2.11.0"],
      ]),
    ),
  ).toEqual(["@tauri-apps/api@2.12.0 differs from tauri@2.11.0 (major.minor)"]);
  expect(checkTauriPackageAlignment(npm, cargoFixture([]))).toEqual([
    "Cargo.lock must contain a package array",
  ]);
  expect(
    checkTauriPackageAlignment(npm, cargoFixture([["unrelated", "1.0.0"]])),
  ).toEqual(["@tauri-apps/api@2.12.0: missing tauri in Cargo.lock"]);
});

test("absent pair rules are fine and unrelated crates need no npm counterpart", () => {
  expect(
    checkTauriPackageAlignment(
      npmFixture({ unrelated: "unrelated@1.0.0" }),
      cargoFixture([["tauri-plugin-updater", "2.13.0"]]),
    ),
  ).toEqual([]);
});

test("malformed lockfile structures and versions fail closed", () => {
  const cargo = cargoFixture([["tauri", "2.12.0"]]);
  expect(checkTauriPackageAlignment("{}", cargo)).toEqual([
    "bun.lock must contain a packages object",
  ]);
  expect(
    checkTauriPackageAlignment('{"packages":{"@tauri-apps/api":[]}}', cargo),
  ).toEqual(["bun.lock package @tauri-apps/api has no resolution"]);
  expect(
    checkTauriPackageAlignment(
      npmFixture({ "@tauri-apps/api": "@tauri-apps/api@invalid" }),
      cargo,
    ),
  ).toEqual(["@tauri-apps/api@invalid: invalid npm version"]);
  expect(
    checkTauriPackageAlignment(
      npmFixture({ "@tauri-apps/api": "@tauri-apps/api@2.12.0" }),
      cargoFixture([["tauri", "invalid"]]),
    ),
  ).toEqual(["tauri@invalid: invalid crate version"]);
  expect(
    checkTauriPackageAlignment(npmFixture({}), '[[package]]\nname = "tauri"'),
  ).toEqual(["Cargo.lock contains a package without a name/version"]);
  expect(() => checkTauriPackageAlignment("{", cargo)).toThrow(SyntaxError);
});

test("selects lockfile, desktop and guard changes without unrelated paths", () => {
  for (const file of [
    "bun.lock",
    "apps/desktop/src-tauri/Cargo.lock",
    "apps/desktop/package.json",
    "apps/desktop/src/main.tsx",
    "scripts/check-tauri-package-alignment.ts",
    "scripts/check-tauri-package-alignment.test.ts",
    "scripts/bun-lock-text.ts",
    ".github/workflows/ci.yml",
    "scripts/verify.sh",
  ]) {
    expect(requiresTauriAlignment([file])).toBe(true);
  }
  expect(requiresTauriAlignment([])).toBe(false);
  expect(requiresTauriAlignment(["apps/web/package.json", "README.md"])).toBe(
    false,
  );
});
