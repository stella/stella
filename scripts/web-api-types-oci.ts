import { panic } from "better-result";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";
import { sha256Hex } from "@stll/sha256/bun";

import {
  type CompilerInputStamp,
  compilerInputStampSchema,
  isCompilerInputStampCurrent,
  localizeStamp,
} from "../apps/api/scripts/lib/compiler-input-stamp";
import {
  generatedStoreDir,
  publishGeneratedOutput,
} from "../apps/api/scripts/lib/generated-output-store";

const FILES = ["output", "stamp.json"] as const;
const hashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
// A new compiler-stamp field requires an explicit payload decision here.
const fields = compilerInputStampSchema.entries;
const payloadInputs = v.strictObject({
  context: fields.context,
  contents: fields.contents,
  installed: fields.installed,
  files: fields.files,
  directories: fields.directories,
  realpaths: fields.realpaths,
  subdirectories: fields.subdirectories,
  listings: fields.listings,
}) satisfies v.GenericSchema<unknown, CompilerInputStamp>;
const stampSchema = v.strictObject({
  outputHash: hashSchema,
  inputs: payloadInputs,
});
const portablePath = /^(?:<(?:real-)?root>)(?:\/[^\\]*)?$/u;
const assertPortablePath = (value: string) => {
  if (!portablePath.test(value) || value.includes("\0")) {
    panic("OCI payload contains a nonportable path");
  }
  const relative = value.replace(/^<(?:real-)?root>\/?/u, "");
  const ancestorProbe = relative.replace(/^(?:\.\.(?:\/|$))+/u, "");
  if (
    relative.startsWith("..") &&
    ancestorProbe !== "" &&
    ancestorProbe !== "package.json" &&
    ancestorProbe !== "node_modules" &&
    !ancestorProbe.startsWith("node_modules/")
  ) {
    panic("OCI payload contains an unapproved ancestor path");
  }
  if (ancestorProbe.split("/").includes("..")) {
    panic("OCI payload contains an unapproved path traversal");
  }
};

// The compiler schema rejects unknown fields at every fixed object boundary.
// Dynamic records contain only portable paths and content hashes, never stats.
const auditStamp = (entry: v.InferOutput<typeof stampSchema>) => {
  const { inputs } = entry;
  if (!v.is(hashSchema, inputs.context)) {
    panic("OCI payload contains an unapproved context");
  }
  if (Object.keys(inputs.installed).length !== 0) {
    panic(
      "OCI payload contains installed fingerprints instead of content hashes",
    );
  }
  for (const [file, hash] of Object.entries(inputs.contents)) {
    assertPortablePath(file);
    if (hash !== null && !v.is(hashSchema, hash)) {
      panic("OCI payload contains an unapproved content hash");
    }
  }
  for (const probes of [inputs.files, inputs.directories]) {
    for (const file of [...probes.present, ...probes.absent]) {
      assertPortablePath(file);
    }
  }
  for (const [file, resolved] of Object.entries(inputs.realpaths)) {
    assertPortablePath(file);
    assertPortablePath(resolved);
  }
  for (const [directory, children] of Object.entries(inputs.subdirectories)) {
    assertPortablePath(directory);
    for (const child of children) {
      // TypeScript getDirectories returns child names rather than full paths.
      if (!/^[^/\\]+$/u.test(child) || child.includes("\0")) {
        panic("OCI payload contains an unapproved directory name");
      }
    }
  }
  for (const [
    [directory, extensions, excludes, includes],
    found,
  ] of inputs.listings) {
    assertPortablePath(directory);
    // Globs and extensions are compiler options, restricted to their syntax.
    for (const pattern of [
      ...(extensions ?? []),
      ...(excludes ?? []),
      ...(includes ?? []),
    ]) {
      if (!/^[\w.*?{}!/@<>:-]+$/u.test(pattern) || path.isAbsolute(pattern)) {
        panic("OCI payload contains an unapproved listing pattern");
      }
    }
    for (const file of found) {
      assertPortablePath(file);
    }
  }
};

export const auditPayload = async (
  directory: string,
  forbidden: readonly string[] = [],
) => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const found = entries
    .map((entry) => {
      if (!entry.isFile()) {
        panic("OCI payload contains an unapproved filesystem entry");
      }
      return repoRelativePath(
        directory,
        path.join(entry.parentPath, entry.name),
      );
    })
    .toSorted();
  if (found.join("\n") !== FILES.join("\n")) {
    panic("OCI payload file inventory differs");
  }
  const [stampBytes, output] = await Promise.all([
    readFile(path.join(directory, "stamp.json")),
    readFile(path.join(directory, "output")),
  ]);
  for (const bytes of [stampBytes, output]) {
    const text = bytes.toString("utf-8");
    if (
      /(?:["'](?:\/|[A-Za-z]:[\\/])|(?:^|\s)\/(?:Users|home|tmp|private|workspace|runner|root|opt)\/)/u.test(
        text,
      ) ||
      forbidden.some((value) => value !== "" && text.includes(value))
    ) {
      panic("OCI payload contains machine-specific data");
    }
  }
  const parsed = v.safeParse(
    stampSchema,
    JSON.parse(stampBytes.toString("utf-8")),
  );
  if (!parsed.success) {
    panic("OCI payload contains unapproved stamp fields or values");
  }
  const stamp = parsed.output;
  auditStamp(stamp);
  if (sha256Hex(output) !== stamp.outputHash) {
    panic("OCI payload output hash differs");
  }
  return found;
};

type BuildPayloadOptions = { root: string; destination: string };

export const buildPayload = async ({
  root,
  destination,
}: BuildPayloadOptions) => {
  const output = await readFile(
    path.join(root, "apps/web/src/generated/api-routes.gen.ts"),
  );
  const store = generatedStoreDir("web-api-types");
  const candidates = await readdir(store);
  // A publication must select a store entry validated against this checkout,
  // not merely the latest entry another process happened to publish.
  const matches = await Promise.all(
    candidates
      .filter((name) => /^[a-f0-9]{64}$/u.test(name))
      .map(async (name) => {
        const directory = path.join(store, name);
        const bytes = await readFile(path.join(directory, "stamp.json"));
        const entry = v.parse(stampSchema, JSON.parse(bytes.toString("utf-8")));
        const localized = localizeStamp(entry.inputs, root);
        return entry.outputHash === sha256Hex(output) &&
          localized !== undefined &&
          (await isCompilerInputStampCurrent(localized, entry.inputs.context))
          ? directory
          : undefined;
      }),
  );
  const source =
    matches.find((entry) => entry !== undefined) ??
    panic("No current portable web-api-types store entry to publish");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all(
    FILES.map(async (file) =>
      writeFile(
        path.join(destination, file),
        await readFile(path.join(source, file)),
      ),
    ),
  );
  return auditPayload(destination, [
    root,
    homedir(),
    ...Object.entries(process.env).flatMap(([key, value]) =>
      /(?:secret|token|password|credential|api_key)/iu.test(key) &&
      value !== undefined &&
      value !== ""
        ? [value]
        : [],
    ),
  ]);
};

export const resolveBaseCommit = (root: string) => {
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd: root,
  });
  if (branch.exitCode !== 0) {
    panic("Cannot identify cloud API types branch");
  }
  const args =
    branch.stdout.toString().trim() === "main"
      ? ["rev-parse", "HEAD"]
      : ["merge-base", "HEAD", "origin/main"];
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    panic(
      `Cannot resolve cloud API types base commit: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
};

export const restorePayload = async (directory: string) => {
  await auditPayload(directory);
  const [bytes, output] = await Promise.all([
    readFile(path.join(directory, "stamp.json"), "utf-8"),
    readFile(path.join(directory, "output"), "utf-8"),
  ]);
  const entry = v.parse(stampSchema, JSON.parse(bytes));
  publishGeneratedOutput({
    storeDir: generatedStoreDir("web-api-types"),
    stamp: entry.inputs,
    output,
  });
};

const layerSchema = v.object({
  digest: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/u)),
  annotations: v.object({
    "org.opencontainers.image.title": v.picklist(FILES),
  }),
});
const manifestSchema = v.object({ layers: v.array(layerSchema) });

type PullApiTypesOptions = { sha: string; destination: string };

export const pullApiTypes = async ({
  sha,
  destination,
}: PullApiTypesOptions) => {
  const base =
    process.env.STELLA_API_TYPES_REGISTRY ??
    "https://ghcr.io/v2/stella/stella-web-api-types";
  const authorization =
    process.env.STELLA_API_TYPES_REGISTRY === undefined
      ? `Bearer ${v.parse(v.object({ token: v.string() }), await (await fetch("https://ghcr.io/token?scope=repository%3Astella%2Fstella-web-api-types%3Apull")).json()).token}`
      : undefined;
  const headers = {
    Accept: "application/vnd.oci.image.manifest.v1+json",
    ...(authorization === undefined ? {} : { Authorization: authorization }),
  };
  const response = await fetch(`${base}/manifests/${sha}`, { headers });
  if (!response.ok) {
    panic(
      `cloud API types artifact unavailable for ${sha} (${response.status})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    response.headers.get("docker-content-digest") !==
    `sha256:${sha256Hex(bytes)}`
  ) {
    panic(`cloud API types manifest verification failed for ${sha}`);
  }
  const manifest = v.parse(
    manifestSchema,
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  const titles = manifest.layers
    .map((layer) => layer.annotations["org.opencontainers.image.title"])
    .toSorted();
  if (titles.join("\n") !== FILES.join("\n")) {
    panic(`cloud API types manifest file inventory differs for ${sha}`);
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await Promise.all(
    manifest.layers.map(async (layer) => {
      const blob = await fetch(`${base}/blobs/${layer.digest}`, { headers });
      const content = new Uint8Array(await blob.arrayBuffer());
      if (!blob.ok || `sha256:${sha256Hex(content)}` !== layer.digest) {
        panic(`cloud API types blob verification failed for ${sha}`);
      }
      await writeFile(
        path.join(
          destination,
          layer.annotations["org.opencontainers.image.title"],
        ),
        content,
      );
    }),
  );
  await restorePayload(destination);
};

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const [command, argument] = process.argv.slice(2);
  if (command === "build" && argument) {
    console.log(
      (await buildPayload({ root, destination: path.resolve(argument) })).join(
        "\n",
      ),
    );
  } else if (command === "restore" && argument) {
    await restorePayload(path.resolve(argument));
  } else if (command === "cloud") {
    const sha = resolveBaseCommit(root);
    await pullApiTypes({
      sha,
      destination: path.join(root, ".cache/web-api-types-oci"),
    });
    const generated = Bun.spawnSync(
      [
        "bun",
        "apps/api/scripts/generate-web-api-types.ts",
        "--require-cached",
        sha,
      ],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    if (generated.exitCode !== 0) {
      panic(`cloud API types stamp validation failed for ${sha}`);
    }
  } else {
    panic("Usage: web-api-types-oci.ts build <dir>|restore <dir>|cloud");
  }
}
