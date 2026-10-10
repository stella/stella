import { afterEach, describe, expect, test } from "bun:test";
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

import { repoRelativePath } from "@stll/portable-path";

import {
  AUTO_INSTALL_DISABLED,
  checkStandaloneLockfiles,
  isTrackedLockfile,
  requiresMalwareScan,
  parseInstallCommands,
} from "./check-standalone-lockfiles";

const ROOT_BUNFIG = `
[install]
auto = "disable"
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native",
]
`;

const DEPENDABOT_ROOT_ONLY = `
version: 2
updates:
  - package-ecosystem: "bun"
    directories:
      - "/"
    cooldown:
      default-days: 5
`;

const DEPENDABOT_COVERING = `
version: 2
updates:
  - package-ecosystem: "bun"
    directories:
      - "/"
      - "/tools/docs"
    cooldown:
      default-days: 5
`;

const ROOT_PACKAGE = JSON.stringify({
  name: "root",
  scripts: {
    "setup:docs": "bun install --cwd tools/docs --frozen-lockfile",
  },
});

const STANDALONE_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "zod": ["zod@4.4.3", "", {}, "sha512-test"],
  }
}`;

const QUARANTINED_BUNFIG =
  '[install]\nauto = "disable"\nminimumReleaseAge = 432_000\n';

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots = [];
});

/** Writes a fixture repository and returns its root and file list. */
const fixture = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "standalone-lockfiles-"));
  roots.push(root);
  const all: Record<string, string> = {
    ".github/dependabot.yml": DEPENDABOT_COVERING,
    "bun.lock": "{}",
    "bunfig.toml": ROOT_BUNFIG,
    "package.json": ROOT_PACKAGE,
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return { root, trackedFiles: Object.keys(all) };
};

const withoutBunfig = {
  "tools/docs/bun.lock": STANDALONE_LOCK,
  "tools/docs/package.json": "{}",
};

const covered = {
  ...withoutBunfig,
  "tools/docs/bunfig.toml": QUARANTINED_BUNFIG,
};

describe("standalone lockfile guard", () => {
  test("passes a standalone lockfile that carries every safety net", () => {
    const result = checkStandaloneLockfiles(fixture(covered));

    expect(result.errors).toEqual([]);
    expect(result.covered).toEqual(["tools/docs/bun.lock"]);
  });

  test("fails a standalone lockfile with no bunfig and names the fix", () => {
    const result = checkStandaloneLockfiles(fixture(withoutBunfig));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith(
      "tools/docs/bun.lock is a standalone Bun lockfile missing 1 safety net(s):",
    );
    expect(result.errors[0]).toContain(
      "release-age quarantine: tools/docs/bunfig.toml does not exist",
    );
    expect(result.errors[0]).toContain(
      "Fix: add tools/docs/bunfig.toml with [install] minimumReleaseAge = 432000.",
    );
  });

  test("fails a bunfig whose quarantine is shorter than the root's", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "tools/docs/bunfig.toml":
          '[install]\nauto = "disable"\nminimumReleaseAge = 86_400\n',
      }),
    );

    expect(result.errors[0]).toContain(
      "minimumReleaseAge 86400 is below the root's 432000",
    );
  });

  test("fails a lockfile with a bunfig but no Dependabot entry", () => {
    const result = checkStandaloneLockfiles(
      fixture({ ...covered, ".github/dependabot.yml": DEPENDABOT_ROOT_ONLY }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      "Dependabot cooldown: no bun update in .github/dependabot.yml covers /tools/docs.",
    );
  });

  test("fails a Dependabot entry whose cooldown is shorter than the quarantine", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        ".github/dependabot.yml": DEPENDABOT_COVERING.replace(
          "default-days: 5",
          "default-days: 1",
        ),
      }),
    );

    expect(result.errors[0]).toContain("has a cooldown below 5 days");
  });

  test("fails a lockfile nothing installs frozen", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "package.json": JSON.stringify({
          scripts: { "setup:docs": "bun install --cwd tools/docs" },
        }),
      }),
    );

    expect(result.errors[0]).toContain(
      'frozen install: installed without --frozen-lockfile in package.json "setup:docs".',
    );
  });

  test("fails a lockfile no script or workflow installs", () => {
    const result = checkStandaloneLockfiles(
      fixture({ ...covered, "package.json": "{}" }),
    );

    expect(result.errors[0]).toContain(
      "frozen install: no script or workflow installs this directory.",
    );
  });

  test("requires the root excludes the standalone lockfile resolves", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "tools/docs/bun.lock": STANDALONE_LOCK.replace(
          '"packages": {',
          '"packages": {\n    "@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-test"],',
        ),
      }),
    );

    expect(result.errors[0]).toContain(
      "quarantine excludes: resolves root-excluded packages without excluding them: @stll/native.",
    );
  });

  test("rejects an exclude the root does not carry", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "tools/docs/bunfig.toml": `${QUARANTINED_BUNFIG}minimumReleaseAgeExcludes = ["zod"]\n`,
      }),
    );

    expect(result.errors[0]).toContain(
      "quarantine excludes: excludes packages the root does not: zod.",
    );
  });

  test.each(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"])(
    "fails a stray %s",
    (lockfile) => {
      const result = checkStandaloneLockfiles(
        fixture({ [`tools/legacy/${lockfile}`]: "{}" }),
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toStartWith(
        `tools/legacy/${lockfile}: this lockfile bypasses the repository's release-age quarantine`,
      );
      expect(result.errors[0]).toContain("Delete it and install with Bun");
    },
  );

  test.each(["bun.lockb", "tools/docs/bun.lockb"])(
    "fails a binary lockfile at %s, whose packages cannot be checked",
    (lockfile) => {
      const result = checkStandaloneLockfiles(
        fixture({ ...covered, [lockfile]: "" }),
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toStartWith(
        `${lockfile}: a binary Bun lockfile cannot be checked`,
      );
    },
  );

  test("fails an unfrozen install in a workflow step's working directory", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        ".github/workflows/docs.yml": `
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - name: Install docs
        working-directory: tools/docs
        run: bun install
`,
      }),
    );

    expect(result.errors[0]).toContain(
      'installed without --frozen-lockfile in .github/workflows/docs.yml job "docs" step "Install docs"',
    );
  });

  test("resolves a job's default working directory", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        ".github/workflows/docs.yml": `
jobs:
  docs:
    defaults:
      run:
        working-directory: tools
    steps:
      - run: cd docs && bun install
`,
      }),
    );

    expect(result.errors[0]).toContain(
      'installed without --frozen-lockfile in .github/workflows/docs.yml job "docs" step "#1"',
    );
  });

  test("passes an allowlisted lockfile", () => {
    const result = checkStandaloneLockfiles({
      ...fixture({ "tools/legacy/yarn.lock": "", "tools/other/bun.lock": "" }),
      allowlist: [
        { path: "tools/legacy/yarn.lock", reason: "vendored fixture" },
        { path: "tools/other/bun.lock", reason: "vendored fixture" },
      ],
    });

    expect(result.errors).toEqual([]);
  });

  test("fails an allowlist entry that names no tracked file", () => {
    const result = checkStandaloneLockfiles({
      ...fixture({}),
      allowlist: [{ path: "tools/gone/yarn.lock", reason: "removed" }],
    });

    expect(result.errors).toEqual([
      "scripts/check-standalone-lockfiles.ts ALLOWLIST names tools/gone/yarn.lock, which is not a tracked file. Remove the entry.",
    ]);
  });

  test("fails every bunfig.toml that lets Bun install at run time", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "apps/web/bunfig.toml": '[test]\npreload = ["./setup.ts"]\n',
        "bunfig.toml": ROOT_BUNFIG.replace('auto = "disable"\n', ""),
        "tools/docs/bunfig.toml": QUARANTINED_BUNFIG.replace(
          '"disable"',
          '"fallback"',
        ),
      }),
    );

    const problem = (file: string, dir: string) =>
      `${file} must set [install] auto = "${AUTO_INSTALL_DISABLED}": Bun reads it for every process started in ${dir}, and otherwise installs a missing import at run time instead of failing.`;
    expect(result.errors.toSorted()).toEqual([
      problem("apps/web/bunfig.toml", "apps/web"),
      problem("bunfig.toml", "the repository root"),
      problem("tools/docs/bunfig.toml", "tools/docs"),
    ]);
  });

  test.each(['"auto"', '"fallback"', '"force"', "true", "false", "0"])(
    "checks a new nested bunfig without a lockfile when auto is %s",
    (auto) => {
      const file = "tools/new/nested/bunfig.toml";
      const result = checkStandaloneLockfiles(
        fixture({ [file]: `[install]\nauto = ${auto}\n` }),
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors.at(0)).toStartWith(
        `${file} must set [install] auto = "${AUTO_INSTALL_DISABLED}"`,
      );
      expect(result.covered).toEqual([]);
    },
  );

  test("ignores lockfiles under node_modules", () => {
    const result = checkStandaloneLockfiles(
      fixture({ "node_modules/pkg/yarn.lock": "" }),
    );

    expect(result.errors).toEqual([]);
  });
});

describe("install command parsing", () => {
  test.each([
    ["bun install --cwd tools/docs --frozen-lockfile", "tools/docs", true],
    ["bun --cwd=./tools/docs/ install", "tools/docs", false],
    ["cd tools/docs && bun ci", "tools/docs", true],
    ["bash scripts/retry.sh bun install --frozen-lockfile", "", true],
    ["bun i", "", false],
    ["(cd tools/docs && bun install)", "tools/docs", false],
    ["{ cd tools && bun install --cwd docs; }", "tools/docs", false],
    ['echo "$(bun --cwd tools/docs ci)"', "tools/docs", true],
  ])("%s", (line, dir, frozen) => {
    expect(parseInstallCommands(line, "fixture")).toEqual([
      { dir, frozen, source: "fixture" },
    ]);
  });

  test("ignores other bun subcommands", () => {
    expect(
      parseInstallCommands("bun --cwd tools/docs test && bun run build", "x"),
    ).toEqual([]);
  });
});

test("all guarded lock formats and manifests select the malware gate at every depth", () => {
  for (const directory of ["", "tools/docs/", ".claude/mcp/"]) {
    for (const base of [
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]) {
      expect(isTrackedLockfile(`${directory}${base}`)).toBe(true);
      expect(requiresMalwareScan([`${directory}${base}`])).toBe(true);
    }
    expect(requiresMalwareScan([`${directory}package.json`])).toBe(true);
  }
  for (const file of [
    "docs/a.md",
    "apps/web/src/page.tsx",
    "scripts/__fixtures__/malicious.bun-lock.txt",
  ]) {
    expect(isTrackedLockfile(file)).toBe(false);
    expect(requiresMalwareScan([file])).toBe(false);
  }
  expect(requiresMalwareScan([])).toBe(false);
});

describe("Bun under the repository's bunfig.toml files", () => {
  // Hermetic: the registry is a local server that records every request and
  // serves nothing, the package cache starts empty, and the home directory
  // holds no global bunfig. A run that would fetch shows up as a request.
  const PROBE_PACKAGE = "stella-auto-install-probe";
  const DISABLED_LINE = `auto = "${AUTO_INSTALL_DISABLED}"`;
  const repoRoot = path.resolve(import.meta.dir, "..");

  const trackedBunfigs = (): string[] => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot });
    expect(listed.exitCode).toBe(0);
    return listed.stdout
      .toString()
      .split("\0")
      .filter(
        (file) =>
          path.posix.basename(file) === "bunfig.toml" &&
          !file.split("/").includes("node_modules"),
      );
  };

  type ProbeRun = {
    readonly exitCode: number;
    readonly requests: readonly string[];
    readonly stderr: string;
  };

  type ProbeOptions = {
    /** bunfig.toml contents, by directory relative to the fixture root. */
    readonly bunfigs: Readonly<Record<string, string>>;
    /** The directory Bun starts in. */
    readonly cwd: string;
    /** The probe script, relative to the fixture root. */
    readonly script: string;
  };

  /** Runs a script that imports a package no directory provides. */
  const runProbe = async ({
    bunfigs,
    cwd,
    script,
  }: ProbeOptions): Promise<ProbeRun> => {
    const root = mkdtempSync(path.join(tmpdir(), "bun-auto-install-"));
    roots.push(root);
    // Bun never installs at run time below a node_modules directory, which
    // would make the control runs below prove nothing.
    for (let dir = root; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
    }
    for (const [dir, content] of Object.entries(bunfigs)) {
      mkdirSync(path.join(root, dir), { recursive: true });
      writeFileSync(path.join(root, dir, "bunfig.toml"), content);
    }
    mkdirSync(path.dirname(path.join(root, script)), { recursive: true });
    writeFileSync(
      path.join(root, script),
      `import probe from "${PROBE_PACKAGE}";\nconsole.log(probe);\n`,
    );
    mkdirSync(path.join(root, cwd), { recursive: true });
    const home = path.join(root, ".home");
    mkdirSync(home);

    const requests: string[] = [];
    const registry = Bun.serve({
      fetch: (request) => {
        requests.push(new URL(request.url).pathname);
        return new Response("not found", { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    const registryUrl = registry.url.href;
    const child = Bun.spawn(
      [
        process.execPath,
        repoRelativePath(path.join(root, cwd), path.join(root, script)),
      ],
      {
        cwd: path.join(root, cwd),
        env: {
          BUN_CONFIG_REGISTRY: registryUrl,
          BUN_INSTALL_CACHE_DIR: path.join(root, ".cache"),
          HOME: home,
          NPM_CONFIG_REGISTRY: registryUrl,
          PATH: process.env["PATH"] ?? "",
          XDG_CONFIG_HOME: home,
        },
        stderr: "pipe",
        stdout: "pipe",
        timeout: 60_000,
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    await registry.stop(true);
    return { exitCode, requests, stderr };
  };

  const expectFailureWithoutRequest = (run: ProbeRun) => {
    expect(run.requests).toEqual([]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(`Cannot find package '${PROBE_PACKAGE}'`);
  };

  test("finds the root bunfig.toml among the tracked files", () => {
    expect(trackedBunfigs()).toContain("bunfig.toml");
  });

  test.each(trackedBunfigs())(
    "%s makes a missing import fail without a registry request",
    async (file) => {
      const dir = path.posix.dirname(file);
      const content = readFileSync(path.join(repoRoot, file), "utf-8");
      const script = path.posix.join(dir, "probe.ts");

      expectFailureWithoutRequest(
        await runProbe({ bunfigs: { [dir]: content }, cwd: dir, script }),
      );

      // Control: the same file with run-time installs left on does reach the
      // registry, so the run above failed because of the setting.
      expect(content.split(DISABLED_LINE)).toHaveLength(2);
      const enabled = await runProbe({
        bunfigs: { [dir]: content.replace(DISABLED_LINE, 'auto = "auto"') },
        cwd: dir,
        script,
      });
      expect(enabled.requests).toContain(`/${PROBE_PACKAGE}`);
      expect(enabled.exitCode).not.toBe(0);
    },
  );

  test("only the bunfig.toml of the directory Bun starts in applies", async () => {
    const content = readFileSync(path.join(repoRoot, "bunfig.toml"), "utf-8");
    const script = "tools/probe/probe.ts";

    // Started at the root, a script in a subdirectory is covered.
    expectFailureWithoutRequest(
      await runProbe({ bunfigs: { ".": content }, cwd: ".", script }),
    );

    // Started in a subdirectory without its own bunfig.toml, Bun does not
    // read the root's. Hence a copy wherever a bunfig.toml exists, and the
    // install-free CI guard checking imports whatever the directory.
    const fromSubdirectory = await runProbe({
      bunfigs: { ".": content },
      cwd: "tools/probe",
      script,
    });
    expect(fromSubdirectory.requests).toContain(`/${PROBE_PACKAGE}`);
  });
});
