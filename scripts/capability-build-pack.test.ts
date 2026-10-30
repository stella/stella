import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

// timeout: exercises the release packer's two full CLI builds.
test(
  "the reproducible CLI release pack contains freshly generated capability shards",
  async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "stella-cli-build-"));
    const checkout = path.join(temporary, "checkout");
    try {
      run(
        [
          "rsync",
          "-a",
          `--link-dest=${ROOT}`,
          "--exclude=.git",
          "--exclude=/node_modules",
          "--exclude=packages/cli/dist",
          `${ROOT}/`,
          checkout,
        ],
        ROOT,
      );
      symlinkSync(
        path.join(ROOT, "node_modules"),
        path.join(checkout, "node_modules"),
        "dir",
      );
      await rm(path.join(checkout, "packages/cli/capabilities"), {
        recursive: true,
        force: true,
      });
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
