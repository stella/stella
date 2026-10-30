import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

const catalogBytes = async (root: string) => {
  const directory = path.join(root, "packages/cli/capabilities");
  const files = (await readdir(directory)).toSorted();
  return new Map(
    files.map((file) => [file, readFileSync(path.join(directory, file))]),
  );
};

// timeout: exercises two real CLI lifecycle builds and an npm dry-run pack.
test(
  "CLI consumers and npm prepack regenerate byte-identical capability shards",
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
          "--exclude=node_modules",
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
      run(
        ["bun", "run", "generate:capabilities"],
        path.join(checkout, "packages/cli"),
      );
      const expected = await catalogBytes(checkout);

      await rm(path.join(checkout, "packages/cli/capabilities"), {
        recursive: true,
        force: true,
      });
      run(
        ["bun", "run", "codegen:runtime"],
        path.join(checkout, "packages/cli"),
      );
      expect(await catalogBytes(checkout)).toEqual(expected);

      await rm(path.join(checkout, "packages/cli/capabilities"), {
        recursive: true,
        force: true,
      });
      run(
        ["npm", "pack", "--dry-run", "--json"],
        path.join(checkout, "packages/cli"),
      );
      expect(await catalogBytes(checkout)).toEqual(expected);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  TIMEOUT_MS,
);
