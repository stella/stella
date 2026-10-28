import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHILD_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

// timeout: actual offline npm installation exercises consumer dependency resolution.
test("a packed CLI installs offline with unpublished same-release tarballs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "packed-cli-test-"));
  try {
    const artifacts = path.join(root, "release-artifacts");
    const consumer = path.join(root, "consumer");
    mkdirSync(consumer);
    for (const name of ["input", "cli"]) {
      const source = path.join(root, name);
      const packageDirectory = path.join(source, "package");
      const destination = path.join(artifacts, name);
      mkdirSync(packageDirectory, { recursive: true });
      mkdirSync(destination, { recursive: true });
      writeFileSync(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({
          name: `@stella-release-fixture/${name}`,
          version: "1000.0.0-fixture",
          main: "index.js",
          ...(name === "cli"
            ? {
                dependencies: {
                  "@stella-release-fixture/input": "1000.0.0-fixture",
                },
              }
            : {}),
        }),
      );
      writeFileSync(
        path.join(packageDirectory, "index.js"),
        name === "cli"
          ? 'console.log(require("@stella-release-fixture/input"));'
          : 'module.exports = "same-release input";',
      );
      const packed = spawnSync(
        "tar",
        [
          "-czf",
          path.join(destination, `${name}.tgz`),
          "-C",
          source,
          "package",
        ],
        { encoding: "utf-8", maxBuffer: CHILD_OUTPUT_LIMIT_BYTES },
      );
      expect(packed.status, packed.stderr).toBe(0);
    }
    const installed = spawnSync(
      "bash",
      [
        path.resolve(import.meta.dirname, "install-packed-cli.sh"),
        artifacts,
        consumer,
        path.resolve(import.meta.dirname, "retry.sh"),
      ],
      {
        encoding: "utf-8",
        maxBuffer: CHILD_OUTPUT_LIMIT_BYTES,
        env: {
          ...process.env,
          npm_config_offline: "true",
          npm_config_cache: path.join(root, "cache"),
        },
        timeout: 30_000,
      },
    );
    expect(installed.status, installed.stderr).toBe(0);
    const cli = spawnSync(
      "node",
      ["node_modules/@stella-release-fixture/cli/index.js"],
      { cwd: consumer, encoding: "utf-8", maxBuffer: CHILD_OUTPUT_LIMIT_BYTES },
    );
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe("same-release input");
    const manifest = readFileSync(path.join(consumer, "package.json"), "utf-8");
    expect(manifest).toContain("release-artifacts/cli/cli.tgz");
    expect(manifest).toContain("release-artifacts/input/input.tgz");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
