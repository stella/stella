import { readFileSync } from "node:fs";

import { parseBunLockText } from "./bun-lock-text";

const NPM_SCOPE = "@tauri-apps/";
const BUN_LOCK = "bun.lock";
const CARGO_LOCK = "apps/desktop/src-tauri/Cargo.lock";

// Platform bindings ship with the CLI and follow its version line.
export const TAURI_PAIR_RULES = [
  { npm: /^@tauri-apps\/api$/u, crate: () => "tauri" },
  { npm: /^@tauri-apps\/cli$/u, crate: () => "tauri" },
  {
    npm: /^@tauri-apps\/cli-(?:darwin|linux|win32)-[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    crate: () => "tauri",
  },
  {
    npm: /^@tauri-apps\/plugin-.+$/u,
    crate: (name: string) => name.replace(NPM_SCOPE, "tauri-"),
  },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const tauriVersionLine = (version: string) =>
  /^(\d+\.\d+)\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.exec(version)?.at(1);

export const requiresTauriAlignment = (files: readonly string[]) =>
  files.some(
    (file) =>
      file === BUN_LOCK ||
      file.startsWith("apps/desktop/") ||
      file.startsWith("scripts/check-tauri-package-alignment") ||
      file.startsWith("scripts/fix-tauri-package-alignment") ||
      file === "scripts/bun-lock-text.ts" ||
      file === ".github/workflows/ci.yml" ||
      file === ".github/workflows/autofix.yml" ||
      file === "scripts/verify.sh",
  );

type TauriPair = {
  npm: string;
  npmVersion: string;
  crate: string;
  crateVersions: string[];
};

export const readTauriPairs = (bunLockText: string, cargoLockText: string) => {
  const pairs: TauriPair[] = [];
  const bunLock = parseBunLockText(bunLockText);
  const cargoLock: unknown = Bun.TOML.parse(cargoLockText);
  if (!isRecord(bunLock) || !isRecord(bunLock["packages"])) {
    return { pairs, errors: ["bun.lock must contain a packages object"] };
  }
  if (!isRecord(cargoLock) || !Array.isArray(cargoLock["package"])) {
    return { pairs, errors: ["Cargo.lock must contain a package array"] };
  }

  const errors: string[] = [];
  const crates = new Map<string, string[]>();
  for (const entry of cargoLock["package"]) {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["version"] !== "string"
    ) {
      errors.push("Cargo.lock contains a package without a name/version");
      continue;
    }
    const versions = crates.get(entry["name"]) ?? [];
    versions.push(entry["version"]);
    crates.set(entry["name"], versions);
  }

  for (const [key, entry] of Object.entries(bunLock["packages"])) {
    const resolution = Array.isArray(entry) ? entry.at(0) : undefined;
    if (typeof resolution !== "string") {
      errors.push(`bun.lock package ${key} has no resolution`);
      continue;
    }
    // Read the resolved name, not the key: Bun nests duplicate resolutions
    // under dependency paths, and an npm alias can have a different key.
    if (!resolution.startsWith(NPM_SCOPE)) {
      continue;
    }
    const separator = resolution.lastIndexOf("@");
    const name = resolution.slice(0, separator);
    const version = resolution.slice(separator + 1);
    const rule = TAURI_PAIR_RULES.find(({ npm }) => npm.test(name));
    if (rule === undefined) {
      errors.push(
        `${resolution}: no Tauri pair rule (add one to TAURI_PAIR_RULES)`,
      );
      continue;
    }
    const crate = rule.crate(name);
    const versions = crates.get(crate);
    if (versions === undefined) {
      errors.push(`${resolution}: missing ${crate} in Cargo.lock`);
      continue;
    }
    const npmLine = tauriVersionLine(version);
    if (npmLine === undefined) {
      errors.push(`${resolution}: invalid npm version`);
      continue;
    }
    for (const crateVersion of versions) {
      const crateLine = tauriVersionLine(crateVersion);
      if (crateLine === undefined) {
        errors.push(`${crate}@${crateVersion}: invalid crate version`);
        continue;
      }
    }
    pairs.push({
      npm: name,
      npmVersion: version,
      crate,
      crateVersions: versions,
    });
  }
  return { pairs, errors };
};

export const checkTauriPackageAlignment = (
  bunLockText: string,
  cargoLockText: string,
) => {
  const { pairs, errors } = readTauriPairs(bunLockText, cargoLockText);
  for (const pair of pairs) {
    for (const crateVersion of pair.crateVersions) {
      const crateLine = tauriVersionLine(crateVersion);
      if (
        crateLine !== undefined &&
        tauriVersionLine(pair.npmVersion) !== crateLine
      ) {
        errors.push(
          `${pair.npm}@${pair.npmVersion} differs from ${pair.crate}@${crateVersion} (major.minor)`,
        );
      }
    }
  }
  return errors;
};

if (import.meta.main) {
  if (Bun.argv.at(2) === "--requires-check") {
    console.log(requiresTauriAlignment(Bun.argv.slice(3)));
  } else {
    const errors = checkTauriPackageAlignment(
      readFileSync(new URL(`../${BUN_LOCK}`, import.meta.url), "utf-8"),
      readFileSync(new URL(`../${CARGO_LOCK}`, import.meta.url), "utf-8"),
    );
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = errors.length === 0 ? 0 : 1;
  }
}
