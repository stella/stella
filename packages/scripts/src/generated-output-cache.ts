import { panic } from "better-result";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";
import { createSha256, sha256Hex } from "@stll/sha256/bun";

import { withGenerationLock } from "./generation-lock";

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
  const inputHash = () => {
    const hash = createSha256();
    hash.update(
      JSON.stringify([Bun.version, environment, name, inputs, outputs]),
    );
    for (const file of scan(inputs)) {
      if (
        generated.some((glob) => glob.match(file)) ||
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
  const identity = inputHash();
  const cache = path.join(root, ".cache/generated-output", name, identity);
  const result = await withGenerationLock({
    lockPath: path.join(root, ".cache/generated-output", `${name}.sqlite`),
    run: async () => {
      const manifestPath = path.join(cache, "manifest.json");
      if (await Bun.file(manifestPath).exists()) {
        const manifest = v.parse(
          v.record(v.string(), v.string()),
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
        console.log(`${name}: cached`);
        return;
      }
      const started = performance.now();
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
      console.log(
        `${name}: generated in ${Math.round(performance.now() - started)} ms`,
      );
    },
  });
  result.unwrap(`Generation failed: ${name}`);
};
