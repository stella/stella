import { panic } from "better-result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { createSha256, sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { CI_GENERATED_FILES } from "./generated-files";
import {
  generatedInputGit,
  generatedInputTreeHash,
} from "./generated-input-identity";

const hashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const preparedManifestSchema = v.strictObject({
  sourceSha: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
  inputHash: hashSchema,
  bunVersion: v.string(),
  compilerVersion: v.string(),
  files: v.record(v.string(), hashSchema),
});

export const generatedFileHash = (bytes: Uint8Array | string) =>
  hashSha256Hex(bytes);

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
  return {
    sourceSha: generatedInputGit({
      root,
      args: ["rev-parse", "HEAD"],
      onFailure: panic,
    }).trim(),
    inputHash: generatedInputTreeHash({
      root,
      toolchain: { bun: Bun.version, compiler: compiler.version },
      generatedOutputs: "exclude",
      createHasher: createSha256,
      hashFile: generatedFileHash,
      onFailure: panic,
    }),
    bunVersion: Bun.version,
    compilerVersion: compiler.version,
  };
};

type TrackedInputHashOptions = {
  excluded: ReadonlySet<string>;
  context: unknown;
};

export const trackedInputHash = (
  root: string,
  { excluded, context }: TrackedInputHashOptions,
) =>
  generatedInputTreeHash({
    root,
    toolchain: context,
    generatedOutputs: "exclude",
    excluded,
    createHasher: createSha256,
    hashFile: generatedFileHash,
    onFailure: panic,
  });

const resultManifestSchema = v.strictObject({
  inputHash: hashSchema,
  runId: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/u)),
  event: v.literal("merge_group"),
  conclusion: v.literal("success"),
});

// Result receipts use the same content-addressed artifact manifests as prepared
// sources, but have no generated outputs to restore.
export const reusableResultRun = (
  raw: unknown,
  inputHash: string,
  event: string,
) => {
  if (event === "merge_group") {
    return undefined;
  }
  const parsed = v.safeParse(resultManifestSchema, raw);
  return parsed.success && parsed.output.inputHash === inputHash
    ? parsed.output.runId
    : undefined;
};

export const requireUnchangedGeneratedInputs = (
  root: string,
  before: ReturnType<typeof generatedInputIdentity>,
) => {
  const after = generatedInputIdentity(root);
  if (
    before.sourceSha !== after.sourceSha ||
    before.inputHash !== after.inputHash ||
    before.bunVersion !== after.bunVersion ||
    before.compilerVersion !== after.compilerVersion
  ) {
    panic(
      "Generation changed tracked source inputs; only canonical outputs may change during preparation",
    );
  }
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
