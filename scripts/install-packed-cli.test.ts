import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHILD_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const FIXTURE_VERSION = "0.2.1";

// timeout: actual offline npm installation exercises consumer dependency resolution.
test.each([
  "declared",
  "undeclared",
  "incompatible",
  "incompatible-transitive",
] as const)(
  "a packed CLI resolves only its %s runtime dependency closure",
  (declaration) => {
    const root = mkdtempSync(path.join(tmpdir(), "packed-cli-test-"));
    try {
      const artifacts = path.join(root, "release-artifacts");
      const consumer = path.join(root, "consumer");
      mkdirSync(consumer);
      const runtimeDependencies = {
        "@stll/agent-input":
          declaration === "incompatible" ? "^0.2.2" : FIXTURE_VERSION,
        ...(declaration === "incompatible-transitive"
          ? { "@stll/stable-stringify": FIXTURE_VERSION }
          : {}),
      };
      const packages = [
        {
          name: "cli",
          dependencies: declaration === "undeclared" ? {} : runtimeDependencies,
          code: 'console.log(require("@stll/agent-input"));',
        },
        {
          name: "agent-input",
          dependencies: {
            "@stll/stable-stringify":
              declaration === "incompatible-transitive"
                ? "^0.2.2"
                : FIXTURE_VERSION,
          },
          code: 'module.exports = require("@stll/stable-stringify");',
        },
        {
          name: "stable-stringify",
          dependencies: {},
          code: 'module.exports = "same-release transitive input";',
        },
        { name: "unrelated", dependencies: {}, code: "" },
      ];
      for (const { name, dependencies, code } of packages) {
        const source = path.join(root, name);
        const packageDirectory = path.join(source, "package");
        const destination = path.join(artifacts, name);
        mkdirSync(packageDirectory, { recursive: true });
        mkdirSync(destination, { recursive: true });
        writeFileSync(
          path.join(packageDirectory, "package.json"),
          JSON.stringify({
            name: `@stll/${name}`,
            version: FIXTURE_VERSION,
            main: "index.js",
            dependencies,
            // Development dependencies must not make a runtime import pass.
            devDependencies: { "@stll/agent-input": FIXTURE_VERSION },
          }),
        );
        writeFileSync(path.join(packageDirectory, "index.js"), code);
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
      expect(
        existsSync(path.join(artifacts, "agent-input", "agent-input.tgz")),
      ).toBe(true);
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
      if (
        declaration === "incompatible" ||
        declaration === "incompatible-transitive"
      ) {
        expect(installed.status).not.toBe(0);
        const dependency =
          declaration === "incompatible" ? "agent-input" : "stable-stringify";
        expect(installed.stderr).toContain(`@stll/${dependency}@0.2.1`);
        expect(installed.stderr).toContain("does not satisfy");
        expect(installed.stderr).toContain("^0.2.2");
        expect(existsSync(path.join(consumer, "node_modules"))).toBe(false);
        return;
      }
      expect(installed.status, installed.stderr).toBe(0);
      const cli = spawnSync("node", ["node_modules/@stll/cli/index.js"], {
        cwd: consumer,
        encoding: "utf-8",
        maxBuffer: CHILD_OUTPUT_LIMIT_BYTES,
      });
      if (declaration === "undeclared") {
        expect(cli.status).not.toBe(0);
        expect(cli.stderr).toContain("Cannot find module '@stll/agent-input'");
      } else {
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stdout.trim()).toBe("same-release transitive input");
      }
      const tarball = (name: string) =>
        `file:${path.join(artifacts, name, `${name}.tgz`)}`;
      expect(
        JSON.parse(readFileSync(path.join(consumer, "package.json"), "utf-8")),
      ).toEqual({
        private: true,
        dependencies: { "@stll/cli": tarball("cli") },
        overrides:
          declaration === "declared"
            ? {
                "@stll/agent-input": tarball("agent-input"),
                "@stll/stable-stringify": tarball("stable-stringify"),
              }
            : {},
      });
      expect(
        existsSync(path.join(consumer, "node_modules/@stll/unrelated")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  40_000,
);
