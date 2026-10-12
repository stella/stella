import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  scopedInstallStoreKey,
  sealInstallStore,
  verifyInstallStore,
} from "./ci-install-store";
import { lexShell } from "./install-free-ci";
import { MAIN_ONLY_BUN_CACHE_SAVE } from "./workflow-cache-policy";
import { workflowJobSteps } from "./workflow-steps";

test("complete stores reject partial restores, temporary assembly and mismatched keys", () => {
  const store = mkdtempSync(path.join(tmpdir(), "bun-complete-store-"));
  const key = "fixture-key";
  const options = { store, key };
  try {
    expect(() => sealInstallStore(options)).toThrow(
      "Empty isolated Bun install store",
    );
    mkdirSync(path.join(store, "package"));
    writeFileSync(
      path.join(store, "package/value.js"),
      "export const value = 1;\n",
    );
    mkdirSync(path.join(store, "links"));
    symlinkSync("../package", path.join(store, "links/package"));
    expect(() => verifyInstallStore(options)).toThrow(
      "Incomplete or mismatched",
    );
    sealInstallStore(options);
    verifyInstallStore(options);
    expect(() => verifyInstallStore({ store, key: "other-key" })).toThrow(
      "Incomplete or mismatched",
    );
    unlinkSync(path.join(store, "package/value.js"));
    expect(() => verifyInstallStore(options)).toThrow(
      "Incomplete or mismatched",
    );
    writeFileSync(
      path.join(store, "package/value.js"),
      "export const value = 1;\n",
    );
    verifyInstallStore(options);
    mkdirSync(path.join(store, "links/package.tmp-unfinished"));
    expect(() => verifyInstallStore(options)).toThrow(
      "Incomplete Bun install store",
    );
    expect(() => sealInstallStore(options)).toThrow(
      "Incomplete Bun install store",
    );
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("the scoped store key changes with the frozen lockfile and complete install flags", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-store-key-"));
  const lockfile = path.join(root, "bun.lock");
  const flags = [
    "--frozen-lockfile",
    "--ignore-scripts",
    "--filter",
    "@stll/api",
    "--filter",
    "@stll/cli",
  ];
  try {
    writeFileSync(lockfile, "first lockfile");
    const key = scopedInstallStoreKey(lockfile, flags);
    expect(key).toStartWith(
      `bun-complete-store-${process.platform}-${Bun.version}-`,
    );
    expect(scopedInstallStoreKey(lockfile, flags)).toBe(key);
    expect(
      scopedInstallStoreKey(lockfile, [...flags, "--production"]),
    ).not.toBe(key);
    expect(
      scopedInstallStoreKey(lockfile, [...flags, "--filter", "@stll/scripts"]),
    ).not.toBe(key);
    writeFileSync(lockfile, "second lockfile");
    expect(scopedInstallStoreKey(lockfile, flags)).not.toBe(key);
    writeFileSync(lockfile, "first lockfile");
    writeFileSync(
      path.join(root, "bunfig.toml"),
      '[install]\nlinker = "hoisted"\n',
    );
    expect(scopedInstallStoreKey(lockfile, flags)).not.toBe(key);
    expect(() => scopedInstallStoreKey(lockfile, [])).toThrow(
      "requires scoped filters",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Postgres restores only exact complete stores and saves successful installs before tests", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  );
  const steps = workflowJobSteps(workflow, "postgres-service-suites");
  const step = (name: string) => {
    const found = steps.find((entry) => entry["name"] === name);
    if (!found) {
      expect.unreachable(`Missing ${name}`);
    }
    return found;
  };
  const key = step("Derive scoped Postgres install-store key");
  const restore = step("Restore complete scoped Postgres install store");
  const verify = step("Verify complete scoped Postgres install store");
  const install = step("Install dependencies");
  const seal = step("Seal complete scoped Postgres install store");
  const save = step("Save complete scoped Postgres install store");
  const commands = (value: unknown) => {
    if (typeof value !== "string") {
      expect.unreachable("Expected an install command");
    }
    return (
      [...lexShell(value)].find((event) => event.type === "command")?.words ??
      []
    );
  };
  expect(commands(key["run"]).slice(3)).toEqual(
    commands(install["run"]).slice(3),
  );
  expect(restore["uses"]).toBe(
    "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  );
  expect(save["uses"]).toBe(
    "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  );
  expect(restore["with"]).toEqual({
    path: "~/.bun/install/cache",
    key: `\${{ steps.postgres-install-key.outputs.key }}`,
  });
  expect(save["with"]).toEqual(restore["with"]);
  expect(verify["if"]).toBe(
    "steps.postgres-install-cache.outputs.cache-hit == 'true'",
  );
  expect(seal["if"]).toBe(
    "steps.postgres-install-cache.outputs.cache-hit != 'true'",
  );
  expect(save["if"]).toBe(MAIN_ONLY_BUN_CACHE_SAVE);
  const order = [
    key,
    restore,
    verify,
    install,
    seal,
    save,
    step("Apply migrations to service Postgres"),
  ].map((entry) => steps.indexOf(entry));
  expect(order).toEqual(order.toSorted((left, right) => left - right));
});
