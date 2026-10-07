import { panic } from "better-result";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { CI_GENERATED_FILES } from "./generated-files";

const generated = new Set<string>(CI_GENERATED_FILES);
const hashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const preparedManifestSchema = v.strictObject({
  sourceSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
  inputHash: hashSchema,
  bunVersion: v.string(),
  compilerVersion: v.string(),
  files: v.record(v.string(), hashSchema),
});

export const generatedFileHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const git = (root: string, args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    panic(
      `Generated source input inventory failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

export const generatedInputIdentity = (root: string) => {
  const compiler = v.parse(
    v.object({ version: v.string() }),
    JSON.parse(
      readFileSync(
        path.join(root, "node_modules/typescript/package.json"),
        "utf-8",
      ),
    ),
  );
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ bun: Bun.version, compiler: compiler.version }));
  // The full tracked input tree is conservative: generated outputs never hash
  // themselves, and a new generator input is covered without another glob.
  for (const entry of git(root, ["ls-files", "--stage", "-z"]).split("\0")) {
    if (entry === "") {
      continue;
    }
    const separator = entry.indexOf("\t");
    if (separator === -1) {
      panic("Generated source input inventory has no path");
    }
    const file = entry.slice(separator + 1);
    if (generated.has(file)) {
      continue;
    }
    const absolute = path.join(root, file);
    const bytes = (() => {
      if (entry.startsWith("160000 ")) {
        return entry.slice(0, separator);
      }
      return lstatSync(absolute).isSymbolicLink()
        ? readlinkSync(absolute)
        : readFileSync(absolute);
    })();
    hash.update(
      JSON.stringify([entry.slice(0, 6), file, generatedFileHash(bytes)]),
    );
  }
  return {
    sourceSha: git(root, ["rev-parse", "HEAD"]).trim(),
    inputHash: hash.digest("hex"),
    bunVersion: Bun.version,
    compilerVersion: compiler.version,
  };
};

export const validatePreparedManifest = (root: string, raw: unknown) => {
  const manifest = v.parse(preparedManifestSchema, raw);
  const expected = generatedInputIdentity(root);
  if (
    manifest.sourceSha !== expected.sourceSha ||
    manifest.inputHash !== expected.inputHash ||
    manifest.bunVersion !== expected.bunVersion ||
    manifest.compilerVersion !== expected.compilerVersion
  ) {
    panic("Generated source artifact does not match this source and toolchain");
  }
  if (
    Object.keys(manifest.files).length !== CI_GENERATED_FILES.length ||
    CI_GENERATED_FILES.some((file) => !Object.hasOwn(manifest.files, file))
  ) {
    panic("Generated source artifact has an incomplete output inventory");
  }
  return manifest;
};

export const preparedManifestPath = (root: string) =>
  path.join(root, ".cache/ci-generated-sources/manifest.json");

export const verifyPreparedGeneratedFiles = (root: string, raw: unknown) => {
  const manifest = validatePreparedManifest(root, raw);
  for (const file of CI_GENERATED_FILES) {
    if (
      generatedFileHash(readFileSync(path.join(root, file))) !==
      manifest.files[file]
    ) {
      panic(`Prepared generated source differs: ${file}`);
    }
  }
  return manifest;
};

export const hasPreparedGeneratedSources = (root: string) => {
  const configured = process.env["CI_GENERATED_SOURCES_MANIFEST"];
  if (configured === undefined || configured === "") {
    return false;
  }
  if (configured !== preparedManifestPath(root)) {
    panic("Generated source manifest must belong to this checkout");
  }
  verifyPreparedGeneratedFiles(
    root,
    JSON.parse(readFileSync(configured, "utf-8")),
  );
  return true;
};

export const restorePreparedGeneratedSources = (
  root: string,
  source: string,
) => {
  const manifest = validatePreparedManifest(
    root,
    JSON.parse(readFileSync(path.join(source, "manifest.json"), "utf-8")),
  );
  // Validate every byte before writing any output; only the canonical inventory
  // can name a destination in the checkout.
  const files = CI_GENERATED_FILES.map((file) => {
    const bytes = readFileSync(path.join(source, "files", file));
    if (generatedFileHash(bytes) !== manifest.files[file]) {
      panic(`Generated source artifact differs: ${file}`);
    }
    return { file, bytes };
  });
  for (const { file, bytes } of files) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const destination = preparedManifestPath(root);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(manifest));
};
