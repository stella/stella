import { describe, expect, test } from "bun:test";
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
  decideCliContractChange,
  generatedContractPaths,
  parseCliContractArgs,
} from "./check-cli-contract-changeset";
import { CLI_CONTRACT_SURFACE_PATHS } from "./check-cli-release-coupling";

const runCliContractGuard = ({ root, base }: { root: string; base: string }) =>
  Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dirname, "check-cli-contract-changeset.ts"),
      "--root",
      root,
      "--base",
      base,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

const CATALOG_SHARD = "capabilities/matters.list.json";
const CONTRACT_PATHS = CLI_CONTRACT_SURFACE_PATHS.map((part) =>
  part === "capability-catalog.json" ? CATALOG_SHARD : part,
);

const input = (
  changedFiles: readonly string[],
  cliChangesets: readonly string[] = [],
) =>
  decideCliContractChange({
    changedFiles,
    cliChangesets,
    baseCliVersion: "1.2.13",
    headCliVersion: "1.2.13",
  });

const runGit = (root: string, args: readonly string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
};

const withGitFixture = (
  callback: (root: string) => void,
  options: { readonly baseChangeset?: string } = {},
): void => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-cli-contract-"));
  try {
    mkdirSync(path.join(root, "packages/cli"), { recursive: true });
    mkdirSync(path.join(root, ".changeset"));
    writeFileSync(
      path.join(root, "packages/cli/package.json"),
      '{"name":"@stll/cli","version":"1.2.13"}\n',
    );
    for (const part of CONTRACT_PATHS) {
      const file = path.join(root, "packages/cli", part);
      mkdirSync(path.dirname(file), { recursive: true });
      const generatedContent = part.endsWith(".json")
        ? "{}\n"
        : "export const contract = {};\n";
      writeFileSync(
        file,
        part === CATALOG_SHARD
          ? '{"id":"matters.list","inputSchema":{}}\n'
          : generatedContent,
      );
    }
    writeFileSync(
      path.join(root, "packages/cli/src/generated/resources-snapshot.json"),
      "[]\n",
    );
    writeFileSync(
      path.join(
        root,
        "packages/cli/src/generated/document-version-upload-transport.ts",
      ),
      "export const transport = {};\n",
    );
    writeFileSync(path.join(root, ".changeset/README.md"), "# Changesets\n");
    runGit(root, ["init", "-b", "main"]);
    runGit(root, ["config", "user.email", "test@example.com"]);
    runGit(root, ["config", "user.name", "Test"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
    if (options.baseChangeset !== undefined) {
      writeFileSync(
        path.join(root, ".changeset/base.md"),
        options.baseChangeset,
      );
      runGit(root, ["add", ".changeset/base.md"]);
      runGit(root, ["commit", "-m", "base changeset"]);
    }
    runGit(root, ["checkout", "-b", "feature"]);
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const changeCatalogAndCommit = (root: string, version?: string): void => {
  writeFileSync(
    path.join(root, "packages/cli", CATALOG_SHARD),
    '{"id":"matters.list","inputSchema":{"changed":true}}\n',
  );
  if (version !== undefined) {
    const packagePath = path.join(root, "packages/cli/package.json");
    const packageJson = readFileSync(packagePath, "utf-8");
    writeFileSync(
      packagePath,
      packageJson.replace('"version":"1.2.13"', () => `"version":"${version}"`),
    );
  }
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "contract change"]);
};

const changeCatalogFormattingOnly = (root: string): void => {
  writeFileSync(
    path.join(root, "packages/cli", CATALOG_SHARD),
    '{ "inputSchema": {}, "id": "matters.list" }\n',
  );
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "format catalog"]);
};

describe("CLI contract changeset guard", () => {
  test.each(CONTRACT_PATHS)("requires release metadata for %s", (part) => {
    const partName = part;
    expect(input([`packages/cli/${partName}`])).toEqual({
      status: "missing",
      changedParts: [partName],
    });
  });

  test("ignores unrelated files", () => {
    expect(input(["packages/cli/src/cli.ts", "apps/api/src/index.ts"])).toEqual(
      {
        status: "not-required",
      },
    );
  });

  test("accepts a non-empty CLI changeset", () => {
    expect(
      input([`packages/cli/${CATALOG_SHARD}`], [".changeset/bright-cats.md"]),
    ).toEqual({
      status: "satisfied-changeset",
      changesets: [".changeset/bright-cats.md"],
    });
  });

  test("accepts a CLI changeset already present on the base branch", () => {
    expect(
      input(
        ["packages/cli/src/generated/mcp-contract.ts"],
        [".changeset/base-entry.md"],
      ),
    ).toMatchObject({
      status: "satisfied-changeset",
    });
  });

  test("does not accept an empty or unrelated changeset", () => {
    expect(input(["packages/cli/src/generated/api-contract.ts"], [])).toEqual({
      status: "missing",
      changedParts: ["src/generated/api-contract.ts"],
    });
  });

  test("accepts a real CLI version advance without a changeset", () => {
    expect(
      decideCliContractChange({
        changedFiles: [`packages/cli/${CATALOG_SHARD}`],
        cliChangesets: [],
        baseCliVersion: "1.2.13",
        headCliVersion: "1.2.14",
      }),
    ).toEqual({
      status: "satisfied-version",
      baseVersion: "1.2.13",
      headVersion: "1.2.14",
    });
  });

  test("does not accept an unchanged or downgraded version", () => {
    expect(
      decideCliContractChange({
        changedFiles: [`packages/cli/${CATALOG_SHARD}`],
        cliChangesets: [],
        baseCliVersion: "1.2.13",
        headCliVersion: "1.2.12",
      }).status,
    ).toBe("missing");
  });

  test("requires explicit base flag syntax", () => {
    expect(parseCliContractArgs(["--base", "main"])).toEqual({
      root: expect.any(String),
      base: "main",
    });
    expect(() => parseCliContractArgs(["main"])).toThrow("usage:");
    expect(() => parseCliContractArgs(["--base"])).toThrow("usage:");
    expect(() => parseCliContractArgs(["--unknown", "main"])).toThrow("usage:");
  });
});

describe("CLI contract changeset guard integration", () => {
  test("a failing CLI emits an error annotation only in its captured output", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root);
      const missing = runCliContractGuard({ root, base: "main" });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain(
        "::error::cli-contract-changeset:",
      );
      expect(missing.stderr.toString()).toContain("bun run changeset");

      writeFileSync(
        path.join(root, ".changeset/cli.md"),
        '---\n"@stll/cli": patch\n---\n\nContract change.\n',
      );
      runGit(root, ["add", ".changeset/cli.md"]);
      runGit(root, ["commit", "-m", "qualify CLI change"]);
      const satisfied = runCliContractGuard({ root, base: "main" });
      expect(satisfied.exitCode).toBe(0);
      expect(satisfied.stderr.toString()).toBe("");
      expect(satisfied.stdout.toString()).not.toContain("::error::");
    });
  });

  test("covers every committed generated CLI output except the version file", () => {
    withGitFixture((root) => {
      writeFileSync(
        path.join(root, "packages/cli/src/generated/cli-version.ts"),
        'export const CLI_VERSION = "1.2.13";\n',
      );
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "generated version"]);
      expect(generatedContractPaths(root, "HEAD").toSorted()).toEqual(
        [
          ...CONTRACT_PATHS.map((part) => `packages/cli/${part}`),
          "packages/cli/src/generated/resources-snapshot.json",
          "packages/cli/src/generated/document-version-upload-transport.ts",
        ].toSorted(),
      );
    });
  });

  test("rejects an empty changeset", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root);
      writeFileSync(
        path.join(root, ".changeset/empty.md"),
        "---\n---\n\nNo release.\n",
      );
      runGit(root, ["add", ".changeset/empty.md"]);
      runGit(root, ["commit", "-m", "empty changeset"]);
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
      writeFileSync(
        path.join(root, ".changeset/cli.md"),
        '---\n"@stll/cli": patch\n---\n\nContract change.\n',
      );
      runGit(root, ["add", ".changeset/cli.md"]);
      runGit(root, ["commit", "-m", "qualify CLI change"]);
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(0);
    });
  });

  test("rejects an unrelated package changeset", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root);
      writeFileSync(
        path.join(root, ".changeset/unrelated.md"),
        '---\n"@stll/ui": patch\n---\n\nUI change.\n',
      );
      runGit(root, ["add", ".changeset/unrelated.md"]);
      runGit(root, ["commit", "-m", "unrelated changeset"]);
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
    });
  });

  test("accepts a CLI changeset already pending on the base branch", () => {
    withGitFixture(
      (root) => {
        changeCatalogAndCommit(root);
        expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(0);
      },
      { baseChangeset: '---\n"@stll/cli": patch\n---\n\nContract change.\n' },
    );
  });

  test("accepts a CLI version bump without a changeset", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root, "1.2.14");
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(0);
    });
  });

  test("ignores formatting-only contract changes", () => {
    withGitFixture((root) => {
      changeCatalogFormattingOnly(root);
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(0);
    });
  });

  test("fails closed when the base ref is missing", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root);
      const result = runCliContractGuard({ root, base: "missing-base" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "git merge-base missing-base HEAD failed",
      );
    });
  });

  test("ignores an uncommitted CLI changeset and version bump", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root);
      writeFileSync(
        path.join(root, ".changeset/uncommitted.md"),
        '---\n"@stll/cli": patch\n---\n\nNot committed.\n',
      );
      writeFileSync(
        path.join(root, "packages/cli/package.json"),
        '{"name":"@stll/cli","version":"1.2.14"}\n',
      );
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
    });
  });

  test("does not let an uncommitted contract revert hide committed drift", () => {
    withGitFixture((root) => {
      changeCatalogAndCommit(root);
      writeFileSync(
        path.join(root, "packages/cli", CATALOG_SHARD),
        '{"id":"matters.list","inputSchema":{}}\n',
      );
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
    });
  });

  test.each([
    "packages/cli/src/generated/resources-snapshot.json",
    "packages/cli/src/generated/document-version-upload-transport.ts",
  ])("requires release metadata for %s", (relativePath) => {
    withGitFixture((root) => {
      writeFileSync(
        path.join(root, relativePath),
        relativePath.endsWith(".json") ? '[{"changed":true}]\n' : "changed\n",
      );
      runGit(root, ["add", relativePath]);
      runGit(root, ["commit", "-m", "generated contract change"]);
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
    });
  });

  test.each(["added", "deleted"])(
    "requires release metadata when a capability shard is %s",
    (operation) => {
      withGitFixture((root) => {
        if (operation === "added") {
          writeFileSync(
            path.join(root, "packages/cli/capabilities/matters.get.json"),
            '{"id":"matters.get","inputSchema":{}}\n',
          );
        } else {
          rmSync(path.join(root, "packages/cli", CATALOG_SHARD));
        }
        runGit(root, ["add", "."]);
        runGit(root, ["commit", "-m", "change shard membership"]);
        expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
      });
    },
  );

  test("treats a renamed generated contract as a contract change", () => {
    withGitFixture((root) => {
      runGit(root, [
        "mv",
        `packages/cli/${CATALOG_SHARD}`,
        "packages/cli/capabilities/renamed.json",
      ]);
      runGit(root, ["commit", "-am", "rename generated contract"]);
      expect(runCliContractGuard({ root, base: "main" }).exitCode).toBe(1);
    });
  });
});
