import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkCheckoutMaterialization } from "./check-checkout-materialization";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const workflowWithCheckout = (inputs: unknown) => ({
  jobs: {
    checks: {
      steps: [{ uses: "actions/checkout@0123456789", with: inputs }],
    },
  },
});

describe("checkout object materialization", () => {
  test.each([
    undefined,
    {},
    { "fetch-depth": 1 },
    { "fetch-depth": 0 },
    { "fetch-depth": 1, filter: "", "sparse-checkout": "" },
  ])(
    "accepts checkouts whose requested history is fully materialized: %j",
    (inputs) => {
      expect(
        checkCheckoutMaterialization(
          workflowWithCheckout(inputs),
          "fixture.yml",
        ),
      ).toEqual([]);
    },
  );

  test.each([
    { filter: "blob:none" },
    { filter: "tree:0" },
    { filter: `\${{ inputs.filter }}` },
    { filter: "blob:none", "fetch-depth": 0 },
    { "sparse-checkout": "apps/web" },
    { filter: "", "sparse-checkout": "apps/web\npackages" },
    { "sparse-checkout": `\${{ inputs.paths }}` },
    { filter: false },
    { "sparse-checkout": false },
  ])(
    "rejects checkout inputs that can defer object downloads: %j",
    (inputs) => {
      const problems = checkCheckoutMaterialization(
        workflowWithCheckout(inputs),
        "fixture.yml",
      );

      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toContain("fixture.yml");
      expect(problems.join("\n")).toMatch(/filter|sparse/iu);
    },
  );

  test("finds every deferred checkout in composite action steps and nested workflow jobs", () => {
    const document = {
      runs: {
        using: "composite",
        steps: [{ uses: "actions/checkout@v4", with: { filter: "blob:none" } }],
      },
      jobs: {
        first: {
          steps: [
            {
              uses: "actions/checkout@v4",
              with: { "sparse-checkout": "scripts" },
            },
          ],
        },
        second: {
          steps: [{ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }],
        },
      },
    };

    expect(
      checkCheckoutMaterialization(
        document,
        ".github/actions/fixture/action.yml",
      ),
    ).toHaveLength(2);
  });

  test("ignores checkout-like text and filter inputs belonging to other actions", () => {
    expect(
      checkCheckoutMaterialization(
        {
          jobs: {
            checks: {
              steps: [
                {
                  uses: "example/action@v1",
                  with: { filter: "blob:none", "sparse-checkout": "scripts" },
                },
                { run: "echo actions/checkout@v4 filter: blob:none" },
              ],
            },
          },
        },
        "fixture.yml",
      ),
    ).toEqual([]);
  });

  test("every repository workflow and action materializes its requested Git objects", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const files = [
      ...new Bun.Glob(".github/**/*.{yml,yaml}").scanSync({ cwd: root }),
    ];
    expect(files.length).toBeGreaterThan(0);
    const problems: string[] = [];
    const checkouts: { source: string; step: Record<string, unknown> }[] = [];
    const collectCheckouts = (node: unknown, source: string): void => {
      if (Array.isArray(node)) {
        for (const child of node) {
          collectCheckouts(child, source);
        }
        return;
      }
      if (typeof node !== "object" || node === null) {
        return;
      }
      if (
        "uses" in node &&
        typeof node.uses === "string" &&
        /^actions\/checkout@/u.test(node.uses)
      ) {
        checkouts.push({ source, step: { ...node } });
      }
      for (const child of Object.values(node)) {
        collectCheckouts(child, source);
      }
    };
    for (const file of files) {
      const document: unknown = Bun.YAML.parse(
        await Bun.file(path.join(root, file)).text(),
      );
      problems.push(...checkCheckoutMaterialization(document, file));
      collectCheckouts(document, file);
    }

    expect(problems).toEqual([]);
    expect(checkouts.length).toBeGreaterThan(0);
    for (const { source, step } of checkouts) {
      for (const inputs of [
        { filter: "blob:none" },
        { filter: "", "sparse-checkout": "scripts" },
      ]) {
        const mutated = { ...step, with: inputs };
        expect(
          checkCheckoutMaterialization(mutated, source).join("\n"),
        ).toMatch(/filter|sparse/iu);
      }
    }
  });
});

type GitCommandOptions = {
  cwd: string;
  args: string[];
  input?: string;
  noLazyFetch?: "disabled";
};

const gitCommand = ({ cwd, args, input, noLazyFetch }: GitCommandOptions) => {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdin: input === undefined ? undefined : Buffer.from(input),
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...(noLazyFetch === "disabled" ? { GIT_NO_LAZY_FETCH: "1" } : {}),
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const successfulGit = (options: GitCommandOptions) => {
  const result = gitCommand(options);
  expect(result.stderr).not.toMatch(/fatal:/iu);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
};

describe("Git object availability after the clone transport disappears", () => {
  test("partial clones defer historical blobs while full clones can read both revisions offline", () => {
    const root = mkdtempSync(path.join(tmpdir(), "checkout-materialization-"));
    fixtureRoots.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    const filtered = path.join(root, "filtered");
    const full = path.join(root, "full");
    mkdirSync(source);
    successfulGit({ cwd: source, args: ["init", "--initial-branch=main"] });
    successfulGit({
      cwd: source,
      args: ["config", "user.name", "Checkout fixture"],
    });
    successfulGit({
      cwd: source,
      args: ["config", "user.email", "checkout-fixture@example.invalid"],
    });
    const historicalContent = "Historical fixture blob: first revision only.\n";
    const headContent = "Current fixture blob: second revision only.\n";
    expect(historicalContent).not.toBe(headContent);
    writeFileSync(path.join(source, "tracked.txt"), historicalContent);
    successfulGit({ cwd: source, args: ["add", "tracked.txt"] });
    successfulGit({
      cwd: source,
      args: ["commit", "-m", "First fixture revision"],
    });
    writeFileSync(path.join(source, "tracked.txt"), headContent);
    successfulGit({
      cwd: source,
      args: ["commit", "-am", "Second fixture revision"],
    });
    const historicalBlob = successfulGit({
      cwd: source,
      args: ["rev-parse", "HEAD~1:tracked.txt"],
    });
    const headBlob = successfulGit({
      cwd: source,
      args: ["rev-parse", "HEAD:tracked.txt"],
    });
    expect(historicalBlob).not.toBe(headBlob);
    successfulGit({
      cwd: root,
      args: ["init", "--bare", "--initial-branch=main", remote],
    });
    successfulGit({
      cwd: remote,
      args: ["config", "uploadpack.allowFilter", "true"],
    });
    const remoteUrl = pathToFileURL(remote).href;
    successfulGit({ cwd: source, args: ["push", remoteUrl, "main"] });
    successfulGit({
      cwd: root,
      args: [
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        remoteUrl,
        filtered,
      ],
    });
    successfulGit({
      cwd: root,
      args: ["clone", "--no-checkout", remoteUrl, full],
    });
    expect(
      successfulGit({
        cwd: filtered,
        args: ["config", "remote.origin.promisor"],
      }),
    ).toBe("true");

    const missingBeforeDisconnect = gitCommand({
      cwd: filtered,
      args: ["cat-file", "--batch"],
      input: `${historicalBlob}\n`,
      noLazyFetch: "disabled",
    });
    expect(missingBeforeDisconnect.exitCode).toBe(0);
    expect(missingBeforeDisconnect.stdout).toBe(`${historicalBlob} missing\n`);
    renameSync(remote, path.join(root, "unavailable-remote.git"));

    const deferredRead = gitCommand({
      cwd: filtered,
      args: ["cat-file", "--batch"],
      input: `${historicalBlob}\n`,
    });
    expect(deferredRead.exitCode).not.toBe(0);
    expect(deferredRead.stderr).toMatch(/promisor remote/iu);

    const offlineRead = gitCommand({
      cwd: full,
      args: ["cat-file", "--batch"],
      input: `${historicalBlob}\n${headBlob}\n`,
    });
    expect(offlineRead.exitCode).toBe(0);
    expect(offlineRead.stdout).toBe(
      `${historicalBlob} blob ${Buffer.byteLength(historicalContent)}\n${historicalContent}\n` +
        `${headBlob} blob ${Buffer.byteLength(headContent)}\n${headContent}\n`,
    );
    expect(offlineRead.stderr).toBe("");
  });
});
