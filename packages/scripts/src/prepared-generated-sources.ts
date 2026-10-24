import { panic, Result } from "better-result";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { createSha256, sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { ciGeneratedFiles } from "./generated-file-inventory";
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
        // The generators run on the TypeScript 6 compiler API.
        path.join(root, "node_modules/typescript6/package.json"),
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
    Object.keys(manifest.files).length !== ciGeneratedFiles(root).length ||
    ciGeneratedFiles(root).some((file) => !Object.hasOwn(manifest.files, file))
  ) {
    panic("Generated source artifact has an incomplete output inventory");
  }
  return manifest;
};

export const preparedManifestPath = (root: string) =>
  path.join(root, ".cache/ci-generated-sources/manifest.json");

export const verifyPreparedGeneratedFiles = (root: string, raw: unknown) => {
  const manifest = validatePreparedManifest(root, raw);
  for (const file of ciGeneratedFiles(root)) {
    if (
      generatedFileHash(readFileSync(path.join(root, file))) !==
      manifest.files[file]
    ) {
      panic(`Prepared generated source differs: ${file}`);
    }
  }
  return manifest;
};

/**
 * The producer's bytes of one generated file, when this checkout's prepared
 * manifest belongs to the current source and toolchain and the file on disk
 * still has the bytes the producer recorded; otherwise undefined, never an
 * error. Unlike hasPreparedGeneratedSources it ignores
 * CI_GENERATED_SOURCES_MANIFEST, which regeneration guards clear for the rest
 * of their job: it answers only whether an independent printout is on disk.
 */
export const preparedGeneratedFile = (
  root: string,
  file: string,
): Uint8Array | undefined => {
  const raw = Result.try((): unknown =>
    JSON.parse(readFileSync(preparedManifestPath(root), "utf-8")),
  );
  if (Result.isError(raw)) {
    return undefined;
  }
  const manifest = v.safeParse(preparedManifestSchema, raw.value);
  if (!manifest.success) {
    return undefined;
  }
  const expected = generatedInputIdentity(root);
  const recorded = manifest.output.files[file];
  if (
    recorded === undefined ||
    manifest.output.sourceSha !== expected.sourceSha ||
    manifest.output.inputHash !== expected.inputHash ||
    manifest.output.bunVersion !== expected.bunVersion ||
    manifest.output.compilerVersion !== expected.compilerVersion
  ) {
    return undefined;
  }
  const bytes = Result.try(() => readFileSync(path.join(root, file)));
  return Result.isOk(bytes) && generatedFileHash(bytes.value) === recorded
    ? bytes.value
    : undefined;
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
  const files = ciGeneratedFiles(root).map((file) => {
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
