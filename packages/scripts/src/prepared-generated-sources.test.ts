import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CI_GENERATED_FILES } from "../../../scripts/generated-files";
import {
  generatedFileHash,
  generatedInputIdentity,
  validatePreparedManifest,
  verifyPreparedGeneratedFiles,
  restorePreparedGeneratedSources,
  preparedManifestPath,
  hasPreparedGeneratedSources,
} from "./prepared-generated-sources";

const fixture = () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prepared-sources-")),
  );
  const write = (file: string, bytes: string) => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  };
  write(
    "node_modules/typescript/package.json",
    JSON.stringify({ version: "test-compiler" }),
  );
  write("input.ts", "export const input = 1;\n");
  for (const file of CI_GENERATED_FILES) {
    write(file, `prepared:${file}\n`);
  }
  for (const args of [
    ["init", "-q"],
    ["add", "input.ts", ...CI_GENERATED_FILES],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
  }
  const manifest = {
    ...generatedInputIdentity(root),
    files: Object.fromEntries(
      CI_GENERATED_FILES.map((file) => [
        file,
        generatedFileHash(readFileSync(path.join(root, file))),
      ]),
    ),
  };
  return { root, write, manifest };
};

test("every prepared output has required identity and byte coverage", () => {
  const { root, manifest, write } = fixture();
  try {
    expect(verifyPreparedGeneratedFiles(root, manifest)).toEqual(manifest);
    for (const file of CI_GENERATED_FILES) {
      const missing = {
        ...manifest,
        files: Object.fromEntries(
          Object.entries(manifest.files).filter(([output]) => output !== file),
        ),
      };
      expect(() => validatePreparedManifest(root, missing)).toThrow(
        "incomplete output inventory",
      );
      const original = readFileSync(path.join(root, file), "utf-8");
      write(file, `${original}changed`);
      expect(generatedInputIdentity(root).inputHash).toBe(manifest.inputHash);
      expect(() => verifyPreparedGeneratedFiles(root, manifest)).toThrow(
        `Prepared generated source differs: ${file}`,
      );
      write(file, original);
    }
    expect(() =>
      validatePreparedManifest(root, {
        ...manifest,
        files: { ...manifest.files, extra: generatedFileHash("extra") },
      }),
    ).toThrow("incomplete output inventory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI runtime preparation consumes a verified artifact without invoking generation", () => {
  const { root, manifest, write } = fixture();
  try {
    write(
      "scripts/generated-files.ts",
      readFileSync(
        new URL("../../../scripts/generated-files.ts", import.meta.url),
        "utf-8",
      ),
    );
    for (const file of [
      "prepare-cli-runtime.ts",
      "prepared-generated-sources.ts",
      "child-exit-status.ts",
    ]) {
      write(
        `packages/scripts/src/${file}`,
        readFileSync(new URL(file, import.meta.url), "utf-8"),
      );
    }
    for (const dependency of ["better-result", "valibot"]) {
      const entry = import.meta.resolve(dependency);
      let directory = path.dirname(new URL(entry).pathname);
      while (path.basename(directory) !== dependency) {
        const parent = path.dirname(directory);
        if (parent === directory) {
          panic(`Fixture dependency directory not found: ${dependency}`);
        }
        directory = parent;
      }
      symlinkSync(directory, path.join(root, "node_modules", dependency));
    }
    write(
      "packages/cli/src/codegen.ts",
      'process.stderr.write("fixture generator invoked"); process.exit(81);',
    );
    write(
      ".cache/ci-generated-sources/manifest.json",
      JSON.stringify(manifest),
    );
    const env = {
      ...process.env,
      CI_GENERATED_SOURCES_MANIFEST: preparedManifestPath(root),
    };
    const prepared = Bun.spawnSync(
      [process.execPath, "packages/scripts/src/prepare-cli-runtime.ts"],
      { cwd: root, env },
    );
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0);
    expect(prepared.stderr.toString()).not.toContain(
      "fixture generator invoked",
    );
    const ordinaryEnv = { ...process.env };
    delete ordinaryEnv["CI_GENERATED_SOURCES_MANIFEST"];
    const ordinary = Bun.spawnSync(
      [process.execPath, "packages/scripts/src/prepare-cli-runtime.ts"],
      { cwd: root, env: ordinaryEnv },
    );
    expect(ordinary.exitCode).toBe(81);
    expect(ordinary.stderr.toString()).toContain("fixture generator invoked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source and toolchain changes invalidate prepared sources while output writes do not", () => {
  const { root, manifest, write } = fixture();
  try {
    for (const [field, value] of Object.entries({
      sourceSha: "0".repeat(40),
      inputHash: "0".repeat(64),
      bunVersion: "different",
      compilerVersion: "different",
    })) {
      const mutation = { ...manifest, [field]: value };
      expect(() => validatePreparedManifest(root, mutation)).toThrow(
        "does not match this source and toolchain",
      );
    }
    write("input.ts", "export const input = 2;\n");
    expect(generatedInputIdentity(root).inputHash).not.toBe(manifest.inputHash);
    expect(() => validatePreparedManifest(root, manifest)).toThrow(
      "does not match this source and toolchain",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore validates the whole artifact before any writes and restores every output", () => {
  const { root, manifest, write } = fixture();
  const source = path.join(root, "artifact");
  try {
    mkdirSync(source);
    writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    for (const file of CI_GENERATED_FILES) {
      write(
        `artifact/files/${file}`,
        readFileSync(path.join(root, file), "utf-8"),
      );
      write(file, "before restore");
    }
    for (const file of CI_GENERATED_FILES) {
      const original = readFileSync(path.join(source, "files", file), "utf-8");
      write(`artifact/files/${file}`, "incomplete artifact");
      expect(() => restorePreparedGeneratedSources(root, source)).toThrow(
        `Generated source artifact differs: ${file}`,
      );
      for (const output of CI_GENERATED_FILES) {
        expect(readFileSync(path.join(root, output), "utf-8")).toBe(
          "before restore",
        );
      }
      write(`artifact/files/${file}`, original);
    }
    restorePreparedGeneratedSources(root, source);
    expect(
      verifyPreparedGeneratedFiles(
        root,
        JSON.parse(readFileSync(preparedManifestPath(root), "utf-8")),
      ),
    ).toEqual(manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured preparation fails closed and an ordinary checkout generates locally", () => {
  const { root, manifest, write } = fixture();
  const previous = process.env["CI_GENERATED_SOURCES_MANIFEST"];
  try {
    delete process.env["CI_GENERATED_SOURCES_MANIFEST"];
    expect(hasPreparedGeneratedSources(root)).toBe(false);
    process.env["CI_GENERATED_SOURCES_MANIFEST"] = path.join(
      root,
      "other.json",
    );
    expect(() => hasPreparedGeneratedSources(root)).toThrow(
      "must belong to this checkout",
    );
    process.env["CI_GENERATED_SOURCES_MANIFEST"] = preparedManifestPath(root);
    expect(() => hasPreparedGeneratedSources(root)).toThrow("ENOENT");
    write(
      ".cache/ci-generated-sources/manifest.json",
      JSON.stringify(manifest),
    );
    expect(hasPreparedGeneratedSources(root)).toBe(true);
    const output =
      CI_GENERATED_FILES.at(0) ?? panic("Generated output inventory is empty");
    write(output, "changed output");
    expect(() => hasPreparedGeneratedSources(root)).toThrow(
      "Prepared generated source differs",
    );
  } finally {
    if (previous === undefined) {
      delete process.env["CI_GENERATED_SOURCES_MANIFEST"];
    } else {
      process.env["CI_GENERATED_SOURCES_MANIFEST"] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
