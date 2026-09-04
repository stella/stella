import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCheckResolutionsOnlyChange } from "./check-resolutions-only-change";

const MANIFEST = `{
  "name": "stella",
  "resolutions": {
    "alpha": "3.0.0"
  }
}
`;

const git = (root: string, args: readonly string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
};

describe("committed-versus-working manifest guard", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "resolutions-guard-"));
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "guard@example.test"]);
    git(root, ["config", "user.name", "guard"]);
    await Bun.write(path.join(root, "package.json"), MANIFEST);
    git(root, ["add", "package.json"]);
    git(root, ["commit", "--quiet", "-m", "manifest"]);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const write = async (manifest: string): Promise<void> => {
    await Bun.write(path.join(root, "package.json"), manifest);
  };

  // The guard throws on inputs it must not even compare; a test boundary is
  // where catching that is appropriate.
  const failure = async (args: readonly string[]): Promise<string> => {
    try {
      await runCheckResolutionsOnlyChange(args, root);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  };

  it("passes when the working tree matches the commit", async () => {
    expect(await runCheckResolutionsOnlyChange([], root)).toBe(0);
  });

  it("passes when only a pin was raised", async () => {
    await write(MANIFEST.replace('"3.0.0"', '"3.4.0"'));

    expect(await runCheckResolutionsOnlyChange([], root)).toBe(0);
  });

  it("fails when anything else moved", async () => {
    await write(MANIFEST.replace('"stella"', '"not-stella"'));

    expect(await runCheckResolutionsOnlyChange([], root)).toBe(1);
  });

  it("resolves an explicit commit SHA", async () => {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root })
      .stdout.toString()
      .trim();
    await write(MANIFEST.replace('"3.0.0"', '"3.4.0"'));

    expect(await runCheckResolutionsOnlyChange(["--ref", head], root)).toBe(0);
  });

  it("refuses a ref that is not HEAD or a full commit SHA", async () => {
    expect(await failure(["--ref", "main"])).toContain(
      "expected HEAD or a full commit SHA",
    );
  });

  it("refuses a manifest that is no longer a regular file", async () => {
    git(root, ["rm", "--quiet", "--cached", "package.json"]);
    await rm(path.join(root, "package.json"));
    await Bun.write(path.join(root, "elsewhere.json"), MANIFEST);
    Bun.spawnSync(["ln", "-s", "elsewhere.json", "package.json"], {
      cwd: root,
    });
    git(root, ["add", "package.json"]);
    git(root, ["commit", "--quiet", "-m", "symlink"]);

    expect(await failure([])).toContain("is not a regular file");
  });
});
