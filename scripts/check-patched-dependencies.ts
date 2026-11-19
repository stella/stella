/**
 * Guard the root `patchedDependencies` against patches that silently stop
 * applying.
 *
 * Bun keys each patch to an exact `name@version`. When that package moves to
 * another version, `bun install` drops the patch from bun.lock and installs the
 * new version unpatched; a frozen install at most prints a warning. A second
 * copy of a patched package at another version installs unpatched the same
 * way. This check fails when:
 *
 * - a package.json patch key names a version bun.lock does not resolve, or
 *   bun.lock's own `patchedDependencies` differs from package.json's;
 * - a patch file is missing;
 * - bun.lock resolves a patched package at a version no patch covers, unless
 *   `scripts/unpatched-dependency-copies.json` declares that version, nested
 *   under the package that depends on it, with a reason. A declaration that
 *   no longer matches bun.lock fails too.
 *
 * Anything that does not parse fails closed.
 *
 * Needs no dependency install: node builtins and Bun APIs only.
 *
 * Run: `bun scripts/check-patched-dependencies.ts`
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseBunLockText } from "./bun-lock-text";

export const UNPATCHED_COPIES_FILE = "scripts/unpatched-dependency-copies.json";

const NO_LONGER_APPLIES =
  "the patch no longer applies to the installed version: re-key it to the new version (bun patch) or hold the package";

type PatchKey = { name: string; version: string };

type UnpatchedCopy = {
  package: string;
  /** Packages whose nested copy may stay unpatched. */
  parents: readonly string[];
  reason: string;
};

export type PatchedDependencyInputs = {
  manifestText: string;
  lockText: string;
  unpatchedCopiesText: string;
  patchFileExists: (file: string) => boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Splits `name@version`; a scoped name keeps its leading `@`. */
const splitIdent = (ident: string): PatchKey | undefined => {
  const separator = ident.indexOf("@", 1);
  if (separator <= 0 || separator === ident.length - 1) {
    return undefined;
  }
  return {
    name: ident.slice(0, separator),
    version: ident.slice(separator + 1),
  };
};

/**
 * The package a bun.lock entry is nested under: `a/@scope/parent/name` is
 * `@scope/parent`. A hoisted entry has none. Hoisting moves the prefix, never
 * the direct parent.
 */
const nestingParent = (key: string, name: string): string | undefined => {
  if (!key.endsWith(`/${name}`)) {
    return undefined;
  }
  const segments = key.slice(0, -(name.length + 1)).split("/");
  const last = segments.at(-1);
  const scope = segments.at(-2);
  return scope?.startsWith("@") ? `${scope}/${last}` : last;
};

const readPatchMap = (
  value: unknown,
  label: string,
  errors: string[],
): Map<string, string> | undefined => {
  if (value === undefined) {
    return new Map();
  }
  if (!isRecord(value)) {
    errors.push(`${label} patchedDependencies must be an object`);
    return undefined;
  }
  const patches = new Map<string, string>();
  for (const [key, file] of Object.entries(value)) {
    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label} patchedDependencies "${key}" must name a file`);
      continue;
    }
    patches.set(key, file);
  }
  return patches;
};

const parseJson = (
  text: string,
  label: string,
  parse: (text: string) => unknown,
  errors: string[],
): unknown => {
  try {
    return parse(text);
  } catch (error) {
    errors.push(`${label} does not parse: ${String(error)}`);
    return undefined;
  }
};

const readUnpatchedCopies = (
  text: string,
  errors: string[],
): UnpatchedCopy[] | undefined => {
  const parsed = parseJson(text, UNPATCHED_COPIES_FILE, JSON.parse, errors);
  if (parsed === undefined) {
    return undefined;
  }
  const copies = isRecord(parsed) ? parsed["copies"] : undefined;
  if (!Array.isArray(copies)) {
    errors.push(`${UNPATCHED_COPIES_FILE} must hold a "copies" array`);
    return undefined;
  }
  const result: UnpatchedCopy[] = [];
  for (const [index, copy] of copies.entries()) {
    const parents = isRecord(copy) ? copy["parents"] : undefined;
    if (
      !isRecord(copy) ||
      typeof copy["package"] !== "string" ||
      splitIdent(copy["package"]) === undefined ||
      typeof copy["reason"] !== "string" ||
      copy["reason"].trim().length === 0 ||
      !Array.isArray(parents) ||
      parents.length === 0 ||
      !parents.every(
        (parent) => typeof parent === "string" && parent.length > 0,
      )
    ) {
      errors.push(
        `${UNPATCHED_COPIES_FILE} copies[${index}] needs "package" (name@version), a non-empty "parents" list and a "reason"`,
      );
      return undefined;
    }
    result.push({
      package: copy["package"],
      parents: parents.filter(
        (parent): parent is string => typeof parent === "string",
      ),
      reason: copy["reason"],
    });
  }
  return result;
};

type ResolvedCopy = { key: string; version: string };

/** Patched versions per package name, from package.json. */
const groupPatchedVersions = (
  manifestPatches: ReadonlyMap<string, string>,
  errors: string[],
) => {
  const patchedVersions = new Map<string, Set<string>>();
  for (const key of manifestPatches.keys()) {
    const patch = splitIdent(key);
    if (patch === undefined) {
      errors.push(
        `package.json patchedDependencies "${key}" must be keyed name@version`,
      );
      continue;
    }
    const versions = patchedVersions.get(patch.name) ?? new Set<string>();
    versions.add(patch.version);
    patchedVersions.set(patch.name, versions);
  }
  return patchedVersions;
};

/** Every bun.lock entry of a patched package, with its resolved version. */
const resolvedCopies = (
  packages: Record<string, unknown>,
  patchedVersions: ReadonlyMap<string, ReadonlySet<string>>,
  errors: string[],
) => {
  const resolved = new Map<string, ResolvedCopy[]>();
  for (const [key, entry] of Object.entries(packages)) {
    const ident = Array.isArray(entry) ? entry.at(0) : undefined;
    const parsed = typeof ident === "string" ? splitIdent(ident) : undefined;
    if (parsed === undefined) {
      errors.push(`bun.lock package "${key}" has no name@version ident`);
      continue;
    }
    if (!patchedVersions.has(parsed.name)) {
      continue;
    }
    const entries = resolved.get(parsed.name) ?? [];
    entries.push({ key, version: parsed.version });
    resolved.set(parsed.name, entries);
  }
  return resolved;
};

/** Each package.json patch key resolves, and bun.lock records the same patches. */
const checkPatchKeys = ({
  manifestPatches,
  lockPatches,
  resolved,
  patchFileExists,
  errors,
}: {
  manifestPatches: ReadonlyMap<string, string>;
  lockPatches: ReadonlyMap<string, string>;
  resolved: ReadonlyMap<string, readonly ResolvedCopy[]>;
  patchFileExists: (file: string) => boolean;
  errors: string[];
}) => {
  for (const [key, file] of manifestPatches) {
    const patch = splitIdent(key);
    if (patch === undefined) {
      continue;
    }
    const versions = (resolved.get(patch.name) ?? []).map(
      (entry) => entry.version,
    );
    if (!versions.includes(patch.version)) {
      const found =
        versions.length > 0
          ? `bun.lock resolves ${patch.name} only at ${[...new Set(versions)].toSorted().join(", ")}`
          : `bun.lock does not resolve ${patch.name} at all`;
      errors.push(
        `${patch.name}: package.json patches ${key}, but ${found}; ${NO_LONGER_APPLIES}.`,
      );
      continue;
    }
    const lockFile = lockPatches.get(key);
    if (lockFile === undefined) {
      errors.push(
        `${patch.name}: package.json patches ${key}, but bun.lock does not record the patch; ${NO_LONGER_APPLIES}.`,
      );
    } else if (lockFile !== file) {
      errors.push(
        `${patch.name}: package.json patches ${key} with ${file}, but bun.lock records ${lockFile}; run bun install to refresh bun.lock.`,
      );
    }
    if (!patchFileExists(file)) {
      errors.push(`${patch.name}: patch file ${file} for ${key} is missing.`);
    }
  }
  for (const key of lockPatches.keys()) {
    if (!manifestPatches.has(key)) {
      errors.push(
        `bun.lock patchedDependencies lists ${key}, which package.json does not patch; run bun install to refresh bun.lock.`,
      );
    }
  }
};

/** A copy at a version no patch covers installs unpatched. */
const checkUnpatchedCopies = ({
  patchedVersions,
  resolved,
  copies,
  errors,
}: {
  patchedVersions: ReadonlyMap<string, ReadonlySet<string>>;
  resolved: ReadonlyMap<string, readonly ResolvedCopy[]>;
  copies: readonly UnpatchedCopy[];
  errors: string[];
}) => {
  const declared = new Set(
    copies.flatMap((copy) =>
      copy.parents.map((parent) => `${parent} > ${copy.package}`),
    ),
  );
  const usedDeclarations = new Set<string>();
  for (const [name, entries] of resolved) {
    const versions = patchedVersions.get(name) ?? new Set<string>();
    for (const entry of entries) {
      if (versions.has(entry.version)) {
        continue;
      }
      const parent = nestingParent(entry.key, name);
      const declaration = `${parent} > ${name}@${entry.version}`;
      if (parent !== undefined && declared.has(declaration)) {
        usedDeclarations.add(declaration);
        continue;
      }
      errors.push(
        `${name}: bun.lock resolves "${entry.key}" at ${entry.version}, which no patch covers (patched: ${[...versions].toSorted().join(", ")}); ${NO_LONGER_APPLIES}.`,
      );
    }
  }
  for (const declaration of declared) {
    if (!usedDeclarations.has(declaration)) {
      errors.push(
        `${UNPATCHED_COPIES_FILE} declares ${declaration} unpatched, but bun.lock has no such unpatched copy; remove or update the declaration.`,
      );
    }
  }
};

/** Every error the patched dependencies have; empty when they all apply. */
export const checkPatchedDependencies = (
  inputs: PatchedDependencyInputs,
): string[] => {
  const errors: string[] = [];

  const manifest = parseJson(
    inputs.manifestText,
    "package.json",
    JSON.parse,
    errors,
  );
  const lock = parseJson(inputs.lockText, "bun.lock", parseBunLockText, errors);
  const copies = readUnpatchedCopies(inputs.unpatchedCopiesText, errors);
  if (errors.length > 0) {
    return errors;
  }
  if (!isRecord(manifest)) {
    return ["package.json must be an object"];
  }
  if (!isRecord(lock) || !isRecord(lock["packages"])) {
    return ["bun.lock has no packages map"];
  }

  const manifestPatches = readPatchMap(
    manifest["patchedDependencies"],
    "package.json",
    errors,
  );
  const lockPatches = readPatchMap(
    lock["patchedDependencies"],
    "bun.lock",
    errors,
  );
  if (manifestPatches === undefined || lockPatches === undefined || !copies) {
    return errors;
  }

  const patchedVersions = groupPatchedVersions(manifestPatches, errors);
  const resolved = resolvedCopies(lock["packages"], patchedVersions, errors);
  checkPatchKeys({
    manifestPatches,
    lockPatches,
    resolved,
    patchFileExists: inputs.patchFileExists,
    errors,
  });
  checkUnpatchedCopies({ patchedVersions, resolved, copies, errors });

  return errors;
};

const main = () => {
  const root = path.resolve(import.meta.dir, "..");
  const read = (file: string) => {
    try {
      return readFileSync(path.join(root, file), "utf-8");
    } catch (error) {
      console.error(`${file} cannot be read: ${String(error)}`);
      process.exit(1);
    }
  };
  const errors = checkPatchedDependencies({
    manifestText: read("package.json"),
    lockText: read("bun.lock"),
    unpatchedCopiesText: read(UNPATCHED_COPIES_FILE),
    patchFileExists: (file) => existsSync(path.join(root, file)),
  });
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(
    "Patched dependencies: every patch applies to every resolved copy.",
  );
};

if (import.meta.main) {
  main();
}
