import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TIMEOUT_MS = 600_000;

const run = (args: string[], cwd: string): void => {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI_GENERATED_SOURCES_MANIFEST: undefined },
  });
  expect(
    result.exitCode,
    `${args.join(" ")}\n${result.stderr.toString()}`,
  ).toBe(0);
};

const catalogBytes = async (directory: string) => {
  const files = (await readdir(directory)).toSorted();
  return new Map(
    files.map((file) => [file, readFileSync(path.join(directory, file))]),
  );
};

// timeout: installs with lifecycle scripts, prepares sources and builds the API,
// then exercises the release packer's two full CLI builds.
test(
  "a clean checkout installs, prepares and builds without capability shards and packs a fresh catalog",
  async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "stella-cli-build-"));
    const checkout = path.join(temporary, "checkout");
    try {
      const sourceFiles = Bun.spawnSync(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      );
      expect(sourceFiles.exitCode, sourceFiles.stderr.toString()).toBe(0);
      // Copy source bytes, including pending edits, without sharing inodes or
      // dependencies: install and generators must own all their writes.
      const copy = Bun.spawnSync(
        [
          "rsync",
          "-a",
          "--from0",
          "--files-from=-",
          "--exclude=node_modules",
          "--exclude=.cache",
          "--exclude=.turbo",
          "--exclude=/packages/cli/capabilities",
          `${ROOT}/`,
          checkout,
        ],
        {
          cwd: ROOT,
          stdin: sourceFiles.stdout,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(copy.exitCode, copy.stderr.toString()).toBe(0);
      const catalog = path.join(checkout, "packages/cli/capabilities");
      expect(existsSync(catalog)).toBe(false);
      for (const command of [
        ["bun", "install"],
        ["bun", "scripts/ci-generated-sources.ts", "prepare"],
        ["bun", "--cwd=apps/api", "run", "build"],
      ]) {
        run(command, checkout);
        expect(existsSync(catalog), command.join(" ")).toBe(false);
      }
      const destination = path.join(temporary, "packed");
      run(
        ["bash", "scripts/pack-reproducibly.sh", "cli", destination],
        checkout,
      );

      const tarballs = (await readdir(destination)).filter((file) =>
        file.endsWith(".tgz"),
      );
      expect(tarballs).toHaveLength(1);
      const extracted = path.join(temporary, "extracted");
      mkdirSync(extracted);
      run(
        ["tar", "-xzf", path.join(destination, tarballs[0]!), "-C", extracted],
        checkout,
      );
      await rm(path.join(checkout, "packages/cli/capabilities"), {
        recursive: true,
        force: true,
      });
      run(
        ["bun", "run", "generate:capabilities"],
        path.join(checkout, "packages/cli"),
      );
      expect(
        await catalogBytes(path.join(extracted, "package/capabilities")),
      ).toEqual(
        await catalogBytes(path.join(checkout, "packages/cli/capabilities")),
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  TIMEOUT_MS,
);
