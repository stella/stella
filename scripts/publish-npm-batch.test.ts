import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
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

import {
  publishBatch,
  publishReport,
  publishTransaction,
  readPublishPackages,
} from "./publish-npm-batch";

const pkg = (name: string, dependencies: string[] = []) => ({
  status: "ready" as const,
  name,
  dependencies,
  manifest: `packages/${name}/package.json`,
  artifactDirectory: `release-artifacts/npm-tarball-${name}`,
});

describe("npm release batch", () => {
  test("orders any selected graph, continues independent failures and skips only blocked descendants", () => {
    const published: string[] = [];
    const outcomes = publishBatch({
      packages: [
        pkg("cli", ["adapter", "published-previously"]),
        pkg("adapter", ["input"]),
        pkg("independent-a"),
        pkg("input"),
        pkg("independent-b"),
      ],
      publish: ({ name }) => {
        published.push(name);
        return ["input", "independent-a"].includes(name)
          ? `${name}: npm authorization refused`
          : null;
      },
    });
    expect(published).toEqual(["independent-a", "input", "independent-b"]);
    expect(outcomes.map(({ name, status }) => [name, status])).toEqual([
      ["independent-a", "failed"],
      ["input", "failed"],
      ["independent-b", "published"],
      ["adapter", "skipped"],
      ["cli", "skipped"],
    ]);
    const report = publishReport(outcomes);
    for (const name of ["input", "independent-a", "adapter", "cli"]) {
      expect(report).toContain(`${name}: `);
    }
    expect(report).toContain("input: npm authorization refused");
    expect(report).toContain(
      "adapter (skipped): Dependency unavailable: input (failed)",
    );
  });

  test("publishes every dependency before its consumer regardless of input order", () => {
    const published = new Set<string>();
    const outcomes = publishBatch({
      packages: [
        pkg("consumer", ["shared"]),
        pkg("shared", ["base"]),
        pkg("base"),
      ],
      publish: ({ name, dependencies }) => {
        expect(
          dependencies.every((dependency) => published.has(dependency)),
        ).toBe(true);
        published.add(name);
        return null;
      },
    });
    expect(outcomes).toEqual([
      { name: "base", status: "published" },
      { name: "shared", status: "published" },
      { name: "consumer", status: "published" },
    ]);
  });

  test("refuses duplicate packages and reports cycles after independent packages complete", () => {
    const publish = () => null;
    expect(() =>
      publishBatch({ packages: [pkg("one"), pkg("one")], publish }),
    ).toThrow("Duplicate publish package");
    const outcomes = publishBatch({
      packages: [pkg("one", ["two"]), pkg("two", ["one"]), pkg("independent")],
      publish,
    });
    expect(outcomes.map(({ name, status }) => [name, status])).toEqual([
      ["independent", "published"],
      ["one", "failed"],
      ["two", "failed"],
    ]);
    expect(publishReport(outcomes)).toContain(
      "Dependency cycle prevents publication",
    );
  });

  test("attributes unreadable manifests and thrown transaction failures without stopping siblings", () => {
    const missing = readPublishPackages(
      ["packages/nonexistent-release-fixture/package.json"],
      "release-artifacts",
    );
    expect(missing).toEqual([
      {
        status: "invalid",
        name: "@stll/nonexistent-release-fixture",
        dependencies: [],
        error: expect.stringContaining("ENOENT"),
      },
    ]);
    const outcomes = publishBatch({
      packages: [
        ...missing,
        pkg("dependent", ["@stll/nonexistent-release-fixture"]),
        pkg("throws"),
        pkg("independent"),
      ],
      publish: ({ name }) => {
        if (name === "throws") {
          JSON.parse("malformed shared output");
        }
        return null;
      },
    });
    expect(outcomes.map(({ name, status }) => [name, status])).toEqual([
      ["@stll/nonexistent-release-fixture", "failed"],
      ["throws", "failed"],
      ["independent", "published"],
      ["dependent", "skipped"],
    ]);
  });

  test("isolates each shared transaction's artifacts and captures prepare, publish and finalize errors", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npm-batch-test-"));
    try {
      const tooling = path.join(root, "tooling");
      mkdirSync(tooling);
      writeFileSync(
        path.join(tooling, "prepare.mjs"),
        `
        import { appendFileSync, readdirSync } from "node:fs";
        const files = readdirSync(process.env.ARTIFACT_DIRECTORY);
        if (files.length !== 1) { console.error("expected one tarball"); process.exit(1); }
        if (process.env.PACKAGE_FILES.includes("prepare-failure")) {
          console.error("prepare: immutable asset mismatch"); process.exit(1);
        }
        const tarballs = process.env.PACKAGE_FILES.includes("publish-failure") ? "fixture.tgz" : "";
        appendFileSync(process.env.GITHUB_OUTPUT, "tarballs<<release_fixture\\n" + tarballs + "\\nrelease_fixture\\nchanged<<release_fixture\\nfalse\\nrelease_fixture\\n");
      `,
      );
      writeFileSync(
        path.join(tooling, "finalize.mjs"),
        `
        if (process.env.PACKAGE_FILES.includes("finalize-failure")) {
          console.error("finalize: version missing"); process.exit(1);
        }
      `,
      );
      writeFileSync(
        path.join(tooling, "publish.sh"),
        "echo 'publish: registry refused' >&2\nexit 1\n",
      );
      const packages = [
        "prepare-failure",
        "publish-failure",
        "finalize-failure",
        "resumed",
        "unselected",
      ].map((name) => {
        const result = {
          ...pkg(name),
          artifactDirectory: path.join(root, `npm-tarball-${name}`),
        };
        mkdirSync(result.artifactDirectory);
        writeFileSync(
          path.join(result.artifactDirectory, `${name}.tgz`),
          "fixture",
        );
        return result;
      });
      const outcomes = publishBatch({
        packages: packages.slice(0, 4),
        publish: (item) =>
          publishTransaction({
            pkg: item,
            sharedTooling: tooling,
            hardenedTooling: tooling,
            temporaryRoot: root,
            timeoutMilliseconds: 30_000,
            // Execute fixture tools portably while asserting the production
            // boundary always uses a process-group timeout, including bash.
            execute: ({ command, args, env }) => {
              expect(command).toBe("timeout");
              const [killAfter, signal, duration, executable, ...parameters] =
                args;
              expect(killAfter).toBe("--kill-after=5s");
              expect(signal).toBe("--signal=TERM");
              expect(Number(duration?.slice(0, -1))).toBeGreaterThan(0);
              assert.ok(executable, "Missing wrapped release executable");
              return spawnSync(executable, parameters, {
                encoding: "utf-8",
                env,
              });
            },
          }),
      });
      expect(outcomes.map(({ status }) => status)).toEqual([
        "failed",
        "failed",
        "failed",
        "published",
      ]);
      expect(publishReport(outcomes)).toContain(
        "prepare: immutable asset mismatch",
      );
      expect(publishReport(outcomes)).toContain("publish: registry refused");
      expect(publishReport(outcomes)).toContain("finalize: version missing");
      expect(publishReport(outcomes)).not.toContain("unselected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("single-package resumes download only the named artifact after provenance verification", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();
    expect(workflow).toContain(
      `pattern: \${{ github.event_name == 'workflow_dispatch' && inputs.package != 'all' && format('npm-tarball-{0}', inputs.package) || 'npm-tarball-*' }}`,
    );
    expect(workflow).toContain(
      `run-id: \${{ inputs.artifact_run_id || github.run_id }}`,
    );
    expect(
      workflow.indexOf("- name: Verify recovery artifact source"),
    ).toBeLessThan(
      workflow.indexOf("- name: Download selected packed packages"),
    );
    expect(workflow).toContain("environment: release-app");
  });
});

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
        { encoding: "utf-8" },
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
      { cwd: consumer, encoding: "utf-8" },
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
