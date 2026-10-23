import { panic, Result } from "better-result";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";
import { createSha256, sha256Hex } from "@stll/sha256/bun";

import { withGenerationLock } from "./generation-lock";

const cacheManifestSchema = v.record(
  v.string(),
  v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
);
const GENERATED_OUTPUT_CACHE_IDENTITY_LIMIT = 2;

type GeneratedOutputCacheOptions = {
  root: string;
  name: string;
  environment: string;
  inputs: readonly string[];
  outputs: readonly string[];
  generate: () => Promise<void>;
};

export const withGeneratedOutputCache = async ({
  root,
  name,
  environment,
  inputs,
  outputs,
  generate,
}: GeneratedOutputCacheOptions) => {
  const scan = (patterns: readonly string[]) =>
    [
      ...new Set(
        patterns.flatMap((pattern) => [
          ...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }),
        ]),
      ),
    ].toSorted();
  const generated = outputs.map((pattern) => new Bun.Glob(pattern));
  // A leading "!" excludes matches, as in Turbo inputs: files other tasks
  // write while this generator runs (package builds) are not its sources.
  const included = inputs.filter((pattern) => !pattern.startsWith("!"));
  const excluded = inputs
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => new Bun.Glob(pattern.slice(1)));
  const inputHash = () => {
    const hash = createSha256();
    hash.update(
      JSON.stringify([Bun.version, environment, name, inputs, outputs]),
    );
    for (const file of scan(included)) {
      if (
        generated.some((glob) => glob.match(file)) ||
        excluded.some((glob) => glob.match(file)) ||
        file.includes("/node_modules/") ||
        file.includes("/.cache/") ||
        file.includes("/.turbo/")
      ) {
        continue;
      }
      hash.update(
        JSON.stringify([file, sha256Hex(readFileSync(path.join(root, file)))]),
      );
    }
    return hash.digest("hex");
  };
  const cacheRoot = path.join(root, ".cache/generated-output", name);
  const prune = (currentIdentity: string) => {
    const entries = readdirSync(cacheRoot, { withFileTypes: true });
    const successful: { identity: string; completedAt: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
        continue;
      }
      const directory = path.join(cacheRoot, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      const inspection = Result.try(() => {
        if (!lstatSync(manifestPath).isFile()) {
          return undefined;
        }
        const parsed = v.safeParse(
          cacheManifestSchema,
          JSON.parse(readFileSync(manifestPath, "utf-8")),
        );
        if (!parsed.success) {
          return undefined;
        }
        const files = Object.keys(parsed.output);
        if (
          files.length === 0 ||
          !files.every(
            (file) =>
              generated.some((glob) => glob.match(file)) &&
              repoRelativePath(root, path.resolve(root, file)) === file &&
              lstatSync(path.join(directory, file)).isFile(),
          )
        ) {
          return undefined;
        }
        return statSync(manifestPath).mtimeMs;
      });
      if (inspection.isErr() || inspection.value === undefined) {
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      successful.push({ identity: entry.name, completedAt: inspection.value });
    }
    const keep = new Set([
      currentIdentity,
      ...successful
        .filter(({ identity }) => identity !== currentIdentity)
        .toSorted((left, right) => right.completedAt - left.completedAt)
        .slice(0, GENERATED_OUTPUT_CACHE_IDENTITY_LIMIT - 1)
        .map(({ identity }) => identity),
    ]);
    for (const { identity } of successful) {
      if (!keep.has(identity)) {
        rmSync(path.join(cacheRoot, identity), {
          recursive: true,
          force: true,
        });
      }
    }
  };
  const result = await withGenerationLock({
    lockPath: path.join(root, ".cache/generated-output", `${name}.sqlite`),
    run: async () => {
      // Hash under the lock: sources can change while another caller holds
      // it, and a hash taken before waiting would restore stale outputs.
      const identity = inputHash();
      const cache = path.join(cacheRoot, identity);
      const manifestPath = path.join(cache, "manifest.json");
      if (await Bun.file(manifestPath).exists()) {
        const manifest = v.parse(
          cacheManifestSchema,
          await Bun.file(manifestPath).json(),
        );
        const files = Object.keys(manifest);
        if (
          files.length === 0 ||
          !files.every(
            (file) =>
              generated.some((glob) => glob.match(file)) &&
              repoRelativePath(root, path.resolve(root, file)) === file,
          )
        ) {
          panic("Invalid generated output cache inventory");
        }
        const artifacts = files.map((file) => {
          const bytes = readFileSync(path.join(cache, file));
          if (sha256Hex(bytes) !== manifest[file]) {
            panic(`Generated cache output differs: ${file}`);
          }
          return { file, bytes };
        });
        for (const file of scan(outputs)) {
          if (!files.includes(file)) {
            rmSync(path.join(root, file));
          }
        }
        for (const { file, bytes } of artifacts) {
          const destination = path.join(root, file);
          if (
            (await Bun.file(destination).exists()) &&
            sha256Hex(readFileSync(destination)) === sha256Hex(bytes)
          ) {
            continue;
          }
          mkdirSync(path.dirname(destination), { recursive: true });
          writeFileSync(destination, bytes);
        }
        const now = new Date();
        utimesSync(manifestPath, now, now);
        prune(identity);
        console.error(`${name}: cached`);
        return;
      }
      const started = performance.now();
      rmSync(cache, { recursive: true, force: true });
      for (const file of scan(outputs)) {
        rmSync(path.join(root, file));
      }
      await generate();
      if (inputHash() !== identity) {
        panic(`Generator ${name} changed its source inputs`);
      }
      const files = scan(outputs);
      if (files.length === 0) {
        panic(`Generator ${name} wrote no outputs`);
      }
      for (const file of files) {
        const destination = path.join(cache, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(path.join(root, file)));
      }
      writeFileSync(
        manifestPath,
        JSON.stringify(
          Object.fromEntries(
            files.map((file) => [
              file,
              sha256Hex(readFileSync(path.join(root, file))),
            ]),
          ),
        ),
      );
      prune(identity);
      console.error(
        `${name}: generated in ${Math.round(performance.now() - started)} ms`,
      );
    },
  });
  if (result.isErr()) {
    panic(`Generation failed: ${name}`, result.error);
  }
};
