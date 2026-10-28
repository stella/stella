import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  apply,
  assertFinalAutofixLockfile,
  assertFrozenLockfile,
  assertLockfileWorkspaces,
  classifyConflicts,
  collect,
  conflictsOf,
  indentationOnly,
  isAllowedResolution,
  mergeLockfile,
  parseStageEntries,
  pathShapeProblem,
  plan,
  push,
  refreshLockfile,
} from "./generated-conflicts";
import { type Generator, GENERATORS } from "./generated-files";

const MESSAGES = "apps/landing/src/i18n/messages/messages.gen.ts";

// Every file this test reads is a temporary fixture or request, never
// Markdown in the repository.
export const CI_MARKDOWN_READER_INPUTS = [] as const;

const field = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    current =
      typeof current === "object" && current !== null
        ? Reflect.get(current, key)
        : undefined;
  }
  return current;
};
const SCRIPT = path.join(import.meta.dirname, "generated-conflicts.ts");

describe("conservative format and lockfile proofs", () => {
  test("indentation changes preserve literals and line boundaries", () => {
    expect(
      indentationOnly({
        before: 'const x = {\n  value: "two words",\n};\n',
        after: 'const x = {\n    value: "two words",\n};\n',
      }),
    ).toBe(true);
    for (const [before, after] of [
      ["return\n  value;", "return value;"],
      ['const x = "two words";', 'const x = "twowords";'],
      ["const x = `line\n  value`;", "const x = `line\n    value`;"],
      ["/* line\n  value */", "/* line\n    value */"],
      ["const x = <p>\n  value</p>;", "const x = <p>\n    value</p>;"],
    ] as const) {
      expect(indentationOnly({ before, after })).toBe(false);
    }
  });

  test.each(["\u2028", "\u2029"])(
    "literal Unicode separator %j does not hide changes to JSON string values",
    (separator) => {
      const before = `{"value":"first${separator}  second"}`;
      const after = `{"value":"first${separator}    second"}`;
      expect(before).toContain(separator);
      expect(JSON.parse(before).value).not.toBe(JSON.parse(after).value);
      expect(indentationOnly({ before, after })).toBe(false);
    },
  );

  test("independent lock additions retain every parent pin", () => {
    const base = {
      packages: { common: ["common@1.0.0", "", {}, "integrity"] },
    };
    const head = { packages: { ...base.packages, a: ["a@1.0.0"] } };
    const main = { packages: { ...base.packages, b: ["b@2.0.0"] } };
    expect(mergeLockfile({ base, head, main })).toEqual({
      packages: { ...base.packages, a: ["a@1.0.0"], b: ["b@2.0.0"] },
    });
    expect(() =>
      mergeLockfile({
        base,
        head: { packages: { common: ["common@2.0.0"] } },
        main: { packages: { common: ["common@3.0.0"] } },
      }),
    ).toThrow("competing edits");
  });

  test("workspace metadata is derived from merged manifests and rejects forged specs", () => {
    const manifest = {
      name: "fixture",
      version: "1",
      dependencies: { a: "1.0.0" },
    };
    const before = {
      workspaces: { "": { name: "fixture", dependencies: { a: "0.9.0" } } },
    };
    const after = {
      workspaces: { "": { name: "fixture", dependencies: { a: "1.0.0" } } },
    };
    expect(() =>
      assertLockfileWorkspaces({ before, after, readManifest: () => manifest }),
    ).not.toThrow();
    expect(() =>
      assertLockfileWorkspaces({
        before,
        after: {
          workspaces: {
            "": { ...after.workspaces[""], dependencies: { a: "*" } },
          },
        },
        readManifest: () => manifest,
      }),
    ).toThrow("differs from merged manifest");
    expect(() =>
      assertLockfileWorkspaces({
        before,
        after: { workspaces: {} },
        readManifest: () => manifest,
      }),
    ).toThrow("changed the merged workspace set");
  });

  test("metadata refresh cannot upgrade, add, remove or change integrity of any frozen pin", () => {
    const before = {
      lockfileVersion: 3,
      packages: { a: ["a@1.0.0", "", {}, "sha512-old"] },
      workspaces: { "": { version: "1" } },
    };
    expect(() =>
      assertFrozenLockfile({
        before,
        after: {
          ...before,
          workspaces: { "": { version: "2" } },
        },
      }),
    ).not.toThrow();
    for (const packages of [
      {},
      { a: ["a@2.0.0"] },
      { ...before.packages, b: ["b@1.0.0"] },
      { a: ["a@1.0.0", "", {}, "sha512-other"] },
    ]) {
      expect(() =>
        assertFrozenLockfile({ before, after: { ...before, packages } }),
      ).toThrow("frozen pins or policy");
    }
    expect(() =>
      assertFrozenLockfile({
        before,
        after: { ...before, trustedDependencies: ["a"] },
      }),
    ).toThrow("frozen pins or policy");
  });

  test("the final autofix boundary rejects lockfile drift after refresh", () => {
    const root = mkdtempSync(path.join(tmpdir(), "autofix-final-lock-"));
    const frozen = path.join(root, "refresh-approved.lock");
    const manifest = {
      name: "fixture",
      dependencies: { a: "1.0.0" },
    };
    const approved = {
      lockfileVersion: 3,
      workspaces: { "": manifest },
      packages: { a: ["a@1.0.0", "", {}, "sha512-approved"] },
    };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(frozen, JSON.stringify(approved));
    writeFileSync(path.join(root, "bun.lock"), JSON.stringify(approved));

    expect(() =>
      assertFinalAutofixLockfile({ repo: root, frozen }),
    ).not.toThrow();

    writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({
        ...approved,
        workspaces: {
          "": { ...approved.workspaces[""], dependencies: { a: "*" } },
        },
      }),
    );
    expect(() => assertFinalAutofixLockfile({ repo: root, frozen })).toThrow(
      "differs from merged manifest",
    );

    writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({ ...approved, workspaces: {} }),
    );
    expect(() => assertFinalAutofixLockfile({ repo: root, frozen })).toThrow(
      "changed the merged workspace set",
    );

    writeFileSync(
      path.join(root, "bun.lock"),
      JSON.stringify({
        ...approved,
        packages: { a: ["a@2.0.0", "", {}, "sha512-changed"] },
      }),
    );
    expect(() => assertFinalAutofixLockfile({ repo: root, frozen })).toThrow(
      "frozen pins or policy",
    );
    rmSync(root, { recursive: true });
  });
});

describe("classification", () => {
  test("a conflict only in an autofix generator's output is regenerable", () => {
    const result = classifyConflicts([
      { path: MESSAGES, kind: "both-modified" },
    ]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) {
      return;
    }
    expect(result.ids).toContain("i18n-messages-landing");
    expect(isAllowedResolution(MESSAGES, result)).toBe(true);
    for (const refused of [
      "apps/landing/src/i18n/messages/cs.json",
      ".github/workflows/ci.yml",
      "apps/web/../../etc/passwd",
      "/etc/passwd",
      // A file output never stands for a directory.
      `${MESSAGES}/nested.ts`,
    ]) {
      expect(isAllowedResolution(refused, result), refused).toBe(false);
    }
  });

  const leftToPeople: { name: string; path: string; kind?: "delete-modify" }[] =
    [
      { name: "source", path: "apps/api/src/index.ts" },
      { name: "the root lockfile", path: "bun.lock" },
      { name: "a nested lockfile", path: "apps/desktop/src-tauri/Cargo.lock" },
      { name: "a baseline", path: "apps/api/mcp-surface-baseline.json" },
      { name: "a changeset", path: ".changeset/new.md" },
      {
        name: "a job classification decision",
        path: ".github/ci-job-classification-decisions/candidate%3A.github%2Fworkflows%2Fci.yml%2Fcheck.json",
      },
      { name: "hand-written regions", path: "DESIGN.md" },
      {
        name: "a generator autofix may not run",
        path: "packages/ai-catalog/upstream/openrouter.gen.json",
      },
      {
        name: "a product screenshot",
        path: "apps/landing/public/media/products/workspace-light.png",
      },
      { name: "delete/modify", path: MESSAGES, kind: "delete-modify" },
    ];
  for (const { name, path: file, kind } of leftToPeople) {
    test(`leaves ${name} to people`, () => {
      const result = classifyConflicts([
        { path: MESSAGES, kind: "both-modified" },
        { path: file, kind: kind ?? "both-modified" },
      ]);
      expect(result.eligible).toBe(false);
    });
  }

  test("no conflict is not a resolution", () => {
    expect(classifyConflicts([]).eligible).toBe(false);
  });

  test("every eligible owner is autofix-enabled and writes committed files", () => {
    for (const generator of GENERATORS) {
      for (const output of generator.outputs) {
        const witness = output.replaceAll("**", "x/y").replaceAll("*", "x");
        const result = classifyConflicts([
          { path: witness, kind: "both-modified" },
        ]);
        if (result.eligible) {
          expect(generator.autofix, `${generator.id}: ${witness}`).toBe(true);
          expect(generator.outputKind).toBe("committed");
        }
      }
    }
  });

  test("reads git's conflict stages", () => {
    const sha = "a".repeat(40);
    const entries = parseStageEntries([
      `100644 ${sha} 1\tboth.ts`,
      `100644 ${sha} 2\tboth.ts`,
      `100644 ${sha} 3\tboth.ts`,
      `100644 ${sha} 2\tadded.ts`,
      `100644 ${sha} 3\tadded.ts`,
      `100644 ${sha} 1\tgone.ts`,
      `100644 ${sha} 3\tgone.ts`,
    ]);
    expect(conflictsOf(entries)).toEqual([
      { path: "both.ts", kind: "both-modified" },
      { path: "added.ts", kind: "both-added" },
      { path: "gone.ts", kind: "delete-modify" },
    ]);
  });

  test("a path through a symlink, submodule or file is refused", () => {
    const modes = new Map([
      ["docs", "040000"],
      ["docs/link", "120000"],
      ["docs/module", "160000"],
      ["docs/file.md", "100644"],
    ]);
    expect(pathShapeProblem("docs/new.md", modes)).toBeNull();
    expect(pathShapeProblem("docs/file.md", modes)).toBeNull();
    expect(pathShapeProblem("docs/link/x.md", modes)).toContain("120000");
    expect(pathShapeProblem("docs/link", modes)).toContain("120000");
    expect(pathShapeProblem("docs/module/x.md", modes)).toContain("160000");
    expect(pathShapeProblem("docs/file.md/x.md", modes)).toContain("100644");
    // Checked against every tree it could land in.
    expect(
      pathShapeProblem(
        "docs/x/y.md",
        new Map(),
        new Map([["docs/x", "120000"]]),
      ),
    ).not.toBeNull();
  });
});

describe("resolution across runs", () => {
  let root = "";
  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (cwd: string, command: readonly string[]) => {
    const result = Bun.spawnSync([...command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString(),
    };
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = run(cwd, ["git", "-c", "commit.gpgsign=false", ...args]);
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  const write = (repo: string, file: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const cli = (cwd: string, ...args: string[]) =>
    run(cwd, ["bun", SCRIPT, ...args]);

  const NOTES = "apps/api/notes.txt";
  const DERIVED = "generated/result.txt";
  const lines = (edit: (rows: string[]) => void) => {
    const rows = Array.from(
      { length: 20 },
      (_, index) => `line ${String(index)}`,
    );
    edit(rows);
    return `${rows.join("\n")}\n`;
  };

  type Fixture = {
    baseEdits?: (origin: string) => void;
    branchEdits?: (origin: string) => void;
    mainEdits?: (origin: string) => void;
  };
  // main and the branch both regenerate the message types from catalogue
  // edits that merge cleanly; each side also edits a different hunk of an
  // ordinary file, which the merge combines into a blob neither side has.
  const fixture = ({ baseEdits, branchEdits, mainEdits }: Fixture = {}) => {
    root = mkdtempSync(path.join(tmpdir(), "generated-conflicts-"));
    const origin = path.join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    write(origin, MESSAGES, "type Messages = { a: string };\n");
    write(
      origin,
      NOTES,
      lines(() => {}),
    );
    baseEdits?.(origin);
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "base");
    git(origin, "switch", "-qc", "feature");
    write(origin, MESSAGES, "type Messages = { a: string; b: string };\n");
    write(
      origin,
      NOTES,
      lines((rows) => {
        rows[1] = "branch";
      }),
    );
    branchEdits?.(origin);
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "feature");
    const head = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    write(origin, MESSAGES, "type Messages = { a: string; c: string };\n");
    write(
      origin,
      NOTES,
      lines((rows) => {
        rows[18] = "main";
      }),
    );
    mainEdits?.(origin);
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "main");
    const main = git(origin, "rev-parse", "HEAD");
    return { origin, head, main };
  };

  const deletionGenerator = (
    outputKind: Generator["outputKind"],
  ): Generator => ({
    id: `fixture-${outputKind}`,
    outputKind,
    outputs: [DERIVED],
    inputs: [],
    write: ["true"],
    check: ["true"],
    autofix: true,
    after: [],
  });

  const deletionFixture = ({ ignored = true, file = DERIVED } = {}) => {
    root = mkdtempSync(path.join(tmpdir(), "generated-conflicts-delete-"));
    const origin = path.join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    write(origin, file, "base\n");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "base");
    git(origin, "switch", "-qc", "feature");
    rmSync(path.join(origin, file));
    if (ignored) {
      write(origin, ".gitignore", `/${file}\n`);
    }
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "derive output");
    const head = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    write(origin, file, "changed on main\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "update output");
    const main = git(origin, "rev-parse", "HEAD");
    return { origin, head, main };
  };

  type ResolveOptions = {
    origin: string;
    head: string;
    main: string;
    regenerate?: (repo: string) => void;
  };

  /** The untrusted resolve run, with a stand-in generator. */
  const resolve = ({ origin, head, main, regenerate }: ResolveOptions) => {
    const regenerated =
      "type Messages = { a: string; b: string; c: string };\n";
    const repo = path.join(root, "resolve");
    git(root, "clone", "-q", origin, repo);
    git(repo, "checkout", "-q", "--detach", head);
    const planned = cli(
      repo,
      "plan",
      "--git-dir",
      ".git",
      "--head",
      head,
      "--main",
      main,
    );
    expect(planned.exitCode, planned.stderr).toBe(0);
    const planFile = path.join(root, "plan.json");
    writeFileSync(planFile, planned.stdout);
    const parsed = JSON.parse(planned.stdout);
    expect(parsed.eligible).toBe(true);
    git(repo, "read-tree", "-m", "-u", "HEAD", parsed.baseline);
    write(repo, MESSAGES, regenerated);
    regenerate?.(repo);
    const out = path.join(root, "resolution");
    const collected = cli(
      repo,
      "collect",
      "--repo",
      repo,
      "--plan",
      planFile,
      "--out",
      out,
    );
    expect(collected.exitCode, collected.stderr).toBe(0);
    return { out, regenerated };
  };

  /** The trusted publish run: objects only, in a bare repository. */
  const publish = (origin: string, head: string, out: string) => {
    const bare = mkdtempSync(path.join(root, "publish-"));
    git(bare, "init", "-q", "--bare", ".");
    git(bare, "fetch", "-q", origin, "+refs/heads/*:refs/heads/*");
    const mainTip = git(bare, "rev-parse", "refs/heads/main");
    const requests = path.join(bare, "requests");
    const applied = cli(
      root,
      "apply",
      "--git-dir",
      bare,
      "--head",
      head,
      "--main-tip",
      mainTip,
      "--collected",
      out,
      "--out",
      requests,
    );
    return { ...applied, requests, bare };
  };

  type TestManifest = {
    main: string;
    files: { path: string; deleted: boolean; mode: string }[];
  };
  const editManifest = (
    out: string,
    edit: (manifest: TestManifest) => void,
  ) => {
    const file = path.join(out, "manifest.json");
    const manifest: TestManifest = JSON.parse(readFileSync(file, "utf-8"));
    edit(manifest);
    writeFileSync(file, JSON.stringify(manifest));
  };

  test("lock refresh skips lifecycle scripts and rolls back unpinned resolutions", () => {
    root = mkdtempSync(path.join(tmpdir(), "lock-refresh-"));
    write(
      root,
      "peer/package.json",
      JSON.stringify({ name: "fixture-peer", version: "1.0.0" }),
    );
    write(
      root,
      "other-peer/package.json",
      JSON.stringify({ name: "fixture-other", version: "1.0.0" }),
    );
    write(
      root,
      "dependency/package.json",
      JSON.stringify({
        name: "local-dependency",
        version: "1.0.0",
        bin: { fixture: "index.js" },
        dependencies: { "fixture-peer": "workspace:*" },
        devDependencies: { "fixture-other": "workspace:*" },
        peerDependencies: {
          "fixture-peer": "workspace:*",
          "fixture-other": "workspace:*",
        },
        peerDependenciesMeta: {
          "fixture-peer": { optional: true },
          "fixture-other": { optional: true },
        },
      }),
    );
    const manifest = {
      name: "fixture",
      workspaces: ["dependency", "peer", "other-peer"],
      dependencies: { "local-dependency": "workspace:*" },
      scripts: { postinstall: "touch lifecycle-ran" },
    };
    write(root, "package.json", JSON.stringify(manifest));
    const seeded = run(root, [
      "bun",
      "--no-env-file",
      "install",
      "--lockfile-only",
      "--ignore-scripts",
    ]);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    refreshLockfile(root);
    expect(existsSync(path.join(root, "lifecycle-ran"))).toBe(false);
    expect(existsSync(path.join(root, "node_modules"))).toBe(false);
    write(
      root,
      "second/package.json",
      JSON.stringify({ name: "second-dependency", version: "1.0.0" }),
    );
    write(
      root,
      "package.json",
      JSON.stringify({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          "second-dependency": "file:./second",
        },
      }),
    );
    const before = readFileSync(path.join(root, "bun.lock"), "utf-8");
    expect(() => refreshLockfile(root)).toThrow("frozen pins or policy");
    expect(readFileSync(path.join(root, "bun.lock"), "utf-8")).toBe(before);
    expect(existsSync(path.join(root, "lifecycle-ran"))).toBe(false);
  });

  test("format-only conflict keeps the semantic side and rejects an artifact changing logic", () => {
    const source = "apps/api/format.ts";
    const { origin, head, main } = fixture({
      baseEdits: (repo) =>
        write(repo, source, "const x = {\n  value: 1,\n};\n"),
      branchEdits: (repo) =>
        write(repo, source, "const x = {\n    value: 1,\n};\n"),
      mainEdits: (repo) =>
        write(repo, source, "const x = {\n  value: 2,\n};\n"),
    });
    const { out } = resolve({ origin, head, main });
    expect(readFileSync(path.join(out, "files", source), "utf-8")).toContain(
      "value: 2",
    );
    const published = publish(origin, head, out);
    expect(published.exitCode, published.stderr).toBe(0);
    write(path.join(out, "files"), source, "const x = 99;\n");
    expect(publish(origin, head, out).stderr).toContain(
      "format-only resolution changed source logic",
    );
  });

  test.each(["rewrite", "delete"] as const)(
    "allowed non-conflicted generator outputs can %s during resolution",
    (operation) => {
      const compose = "docker-compose.selfhost.yml";
      const docs = "docs/self-hosting.md";
      const before =
        "Hand-written introduction\n<!-- BEGIN GENERATED SELF-HOST CONTRACT -->\nold contract\n<!-- END GENERATED SELF-HOST CONTRACT -->\n";
      const after = before.replace("old contract", "merged contract");
      expect(after).not.toBe(before);
      const { origin, head, main } = fixture({
        baseEdits: (repo) => {
          write(repo, compose, "services: {}\n");
          write(repo, docs, before);
        },
        branchEdits: (repo) =>
          write(repo, compose, "services: { branch: {} }\n"),
        mainEdits: (repo) => write(repo, compose, "services: { main: {} }\n"),
      });
      const { out } = resolve({
        origin,
        head,
        main,
        regenerate: (repo) => {
          if (operation === "delete") {
            rmSync(path.join(repo, docs));
            return;
          }
          write(repo, docs, after);
        },
      });
      const planned = JSON.parse(
        readFileSync(path.join(root, "plan.json"), "utf-8"),
      );
      expect(planned.conflicts).toEqual(
        [MESSAGES, compose]
          .toSorted()
          .map((file) => ({ path: file, kind: "both-modified" })),
      );
      expect(planned.allowed).toContain(docs);
      const published = publish(origin, head, out);
      expect(published.exitCode, published.stderr).toBe(0);
      const manifest: { tree: string } = JSON.parse(
        readFileSync(path.join(out, "manifest.json"), "utf-8"),
      );
      if (operation === "delete") {
        expect(git(published.bare, "ls-tree", manifest.tree, "--", docs)).toBe(
          "",
        );
        return;
      }
      expect(git(published.bare, "show", `${manifest.tree}:${docs}`)).toBe(
        after.trim(),
      );
    },
  );

  test("source logic conflicts remain ineligible", () => {
    const source = "apps/api/logic.ts";
    const { origin, head, main } = fixture({
      baseEdits: (repo) => write(repo, source, "const x = 1;\n"),
      branchEdits: (repo) => write(repo, source, "const x = 2;\n"),
      mainEdits: (repo) => write(repo, source, "const x = 3;\n"),
    });
    const planned = cli(
      origin,
      "plan",
      "--git-dir",
      ".git",
      "--head",
      head,
      "--main",
      main,
    );
    expect(planned.exitCode, planned.stderr).toBe(0);
    expect(JSON.parse(planned.stdout).eligible).toBe(false);
  });

  test("lockfile-only conflicts combine existing pins and reject a forged upgrade", () => {
    const lock = (packages: Record<string, unknown>) =>
      JSON.stringify({
        lockfileVersion: 3,
        workspaces: { "": { name: "fixture" } },
        packages,
      });
    const { origin, head, main } = fixture({
      baseEdits: (repo) => {
        write(repo, "package.json", JSON.stringify({ name: "fixture" }));
        write(repo, "bun.lock", lock({ common: ["common@1.0.0"] }));
      },
      branchEdits: (repo) =>
        write(
          repo,
          "bun.lock",
          lock({ common: ["common@1.0.0"], a: ["a@1.0.0"] }),
        ),
      mainEdits: (repo) =>
        write(
          repo,
          "bun.lock",
          lock({ common: ["common@1.0.0"], b: ["b@1.0.0"] }),
        ),
    });
    const { out } = resolve({ origin, head, main });
    const merged = JSON.parse(
      readFileSync(path.join(out, "files", "bun.lock"), "utf-8"),
    );
    expect(Object.keys(merged.packages).toSorted()).toEqual([
      "a",
      "b",
      "common",
    ]);
    const published = publish(origin, head, out);
    expect(published.exitCode, published.stderr).toBe(0);
    merged.workspaces[""].dependencies = { arbitrary: "*" };
    write(path.join(out, "files"), "bun.lock", JSON.stringify(merged));
    expect(publish(origin, head, out).stderr).toContain(
      "differs from merged manifest",
    );
    delete merged.workspaces[""].dependencies;
    merged.packages.common = ["common@2.0.0"];
    write(path.join(out, "files"), "bun.lock", JSON.stringify(merged));
    expect(publish(origin, head, out).stderr).toContain(
      "frozen pins or policy",
    );
  });

  test("the trusted run rebuilds exactly the collected tree", () => {
    const { origin, head, main } = fixture();
    const { out, regenerated } = resolve({ origin, head, main });
    const published = publish(origin, head, out);
    expect(published.exitCode, published.stderr).toBe(0);
    const commit = JSON.parse(
      readFileSync(path.join(published.requests, "commit.json"), "utf-8"),
    );
    expect(commit.parents).toEqual([head, main]);
    const tree: {
      tree: { path: string; mode: string; type: string; sha: string }[];
    } = JSON.parse(
      readFileSync(path.join(published.requests, "tree.json"), "utf-8"),
    );
    const entry = (file: string) => {
      const found = tree.tree.find((item) => item.path === file);
      if (found === undefined) {
        throw new TypeError(`${file} is not in the tree request`);
      }
      return found;
    };
    const byteOrder = (a: string, b: string) => Number(a > b) - Number(a < b);
    expect(entry(MESSAGES)).toMatchObject({ mode: "100644", type: "blob" });
    // Every blob neither parent has is uploaded, including the one the
    // clean part of the merge synthesized for the ordinary file.
    const uploads = readdirSync(path.join(published.requests, "blobs"))
      .map((file) => file.replace(/\.json$/u, ""))
      .toSorted(byteOrder);
    expect(uploads).toEqual(
      [entry(MESSAGES).sha, entry(NOTES).sha].toSorted(byteOrder),
    );
    const blob = JSON.parse(
      readFileSync(
        path.join(published.requests, "blobs", `${entry(MESSAGES).sha}.json`),
        "utf-8",
      ),
    );
    expect(Buffer.from(blob.content, "base64").toString()).toBe(regenerated);
  });

  test("the trusted run independently accepts a derived output deletion", () => {
    const { origin, head, main } = deletionFixture();
    const repo = path.join(root, "resolve");
    git(root, "clone", "-q", origin, repo);
    git(repo, "checkout", "-q", "--detach", head);
    const planned = plan(path.join(repo, ".git"), head, main, [
      deletionGenerator("derived"),
    ]);
    expect(planned.eligible).toBe(true);
    expect(planned.deletions).toEqual([DERIVED]);
    if (!planned.eligible || planned.baseline === null) {
      return;
    }
    const planFile = path.join(root, "plan.json");
    writeFileSync(planFile, JSON.stringify(planned));
    git(repo, "read-tree", "-m", "-u", "HEAD", planned.baseline);
    const collected = path.join(root, "resolution");
    collect({
      repo,
      planFile,
      out: collected,
      generators: [deletionGenerator("derived")],
    });

    const bare = path.join(root, "publish.git");
    git(root, "init", "-q", "--bare", bare);
    git(bare, "fetch", "-q", origin, "+refs/heads/*:refs/heads/*");
    const requests = path.join(root, "requests");
    apply({
      gitDir: bare,
      head,
      mainTip: main,
      collected,
      out: requests,
      generators: [deletionGenerator("committed")],
    });
    const request: { tree: string } = JSON.parse(
      readFileSync(path.join(requests, "commit.json"), "utf-8"),
    );
    expect(git(bare, "ls-tree", request.tree, "--", DERIVED)).toBe("");
  });

  const forgedDeletionRejections = [
    {
      name: "the head tree does not ignore the deletion",
      fixture: () => deletionFixture({ ignored: false }),
      generators: [deletionGenerator("committed")],
    },
    {
      name: "main has no registered generator owner",
      fixture: () => deletionFixture(),
      generators: [] as Generator[],
    },
    {
      name: "the stored deletion is a source file",
      fixture: () => deletionFixture({ file: "src/source.ts" }),
      generators: [deletionGenerator("committed")],
    },
    // The same owner safeguards as a regenerated conflict: a generator that
    // writes only marked regions does not own the prose around them.
    {
      name: "its owner writes only regions of the file",
      fixture: () => deletionFixture(),
      generators: [
        {
          ...deletionGenerator("committed"),
          blocks: [
            { path: DERIVED, begin: "<!-- begin -->", end: "<!-- end -->" },
          ],
        },
      ],
    },
    {
      name: "its owner is not autofix-eligible",
      fixture: () => deletionFixture(),
      generators: [{ ...deletionGenerator("committed"), autofix: false }],
    },
  ];
  test.each(forgedDeletionRejections)(
    "the trusted run rejects a forged deletion when $name",
    (rejection) => {
      const { origin, head, main } = rejection.fixture();
      const bare = path.join(root, "publish.git");
      git(root, "init", "-q", "--bare", bare);
      git(bare, "fetch", "-q", origin, "+refs/heads/*:refs/heads/*");
      const collected = path.join(root, "forged");
      mkdirSync(path.join(collected, "files"), { recursive: true });
      writeFileSync(
        path.join(collected, "manifest.json"),
        JSON.stringify({
          head,
          main,
          baseline: "0".repeat(40),
          tree: "0".repeat(40),
          deletions: [
            rejection.name.includes("source") ? "src/source.ts" : DERIVED,
          ],
          files: [],
        }),
      );
      expect(() =>
        apply({
          gitDir: bare,
          head,
          mainTip: main,
          collected,
          out: path.join(root, "requests"),
          generators: rejection.generators,
        }),
      ).toThrow("The merge is not generated-only");
    },
  );

  test("repository attributes cannot change how the merge resolves", () => {
    // A union driver would merge both versions silently, hiding the
    // conflict, and would differ between a checkout and a bare repository.
    const { origin, head, main } = fixture({
      branchEdits: (repo) =>
        write(repo, ".gitattributes", `${MESSAGES} merge=union\n`),
    });
    // Proof the attribute bites: a plain checkout merge reports no conflict.
    const plain = path.join(root, "plain");
    git(root, "clone", "-q", origin, plain);
    git(plain, "checkout", "-q", "--detach", head);
    const merged = run(plain, [
      "git",
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-commit",
      main,
    ]);
    expect(merged.exitCode, merged.stderr).toBe(0);
    const { out } = resolve({ origin, head, main });
    const storedPlan = JSON.parse(
      readFileSync(path.join(root, "plan.json"), "utf-8"),
    );
    expect(storedPlan.conflicts).toEqual([
      { path: MESSAGES, kind: "both-modified" },
    ]);
    const published = publish(origin, head, out);
    expect(published.exitCode, published.stderr).toBe(0);
  });

  test("a symlinked parent in the branch is refused before anything is written", () => {
    const { origin, head, main } = fixture({
      branchEdits: (repo) => {
        mkdirSync(path.join(repo, "docs"), { recursive: true });
        symlinkSync(tmpdir(), path.join(repo, "docs/module-ownership"));
      },
    });
    const { out } = resolve({ origin, head, main });
    // The output glob docs/module-ownership/*.md is an owning generator's.
    write(path.join(out, "files"), "docs/module-ownership/x.md", "owned\n");
    editManifest(out, (manifest) => {
      manifest.files.push({
        path: "docs/module-ownership/x.md",
        deleted: false,
        mode: "100644",
      });
    });
    const published = publish(origin, head, out);
    expect(published.exitCode).not.toBe(0);
    expect(published.stderr).toContain(
      "docs/module-ownership is not a directory (120000)",
    );
  });

  // timeout: checks three rejected Git-backed publish attempts.
  test("tampered or foreign data never reaches a request", () => {
    const { origin, head, main } = fixture();
    const { out, regenerated } = resolve({ origin, head, main });

    writeFileSync(path.join(out, "files", MESSAGES), "tampered\n");
    const tampered = publish(origin, head, out);
    expect(tampered.exitCode).not.toBe(0);
    expect(tampered.stderr).toContain("differs from the collected tree");
    writeFileSync(path.join(out, "files", MESSAGES), regenerated);

    editManifest(out, (manifest) => {
      manifest.files.push({ path: NOTES, deleted: false, mode: "100644" });
    });
    write(path.join(out, "files"), NOTES, "smuggled\n");
    const smuggled = publish(origin, head, out);
    expect(smuggled.exitCode).not.toBe(0);
    expect(smuggled.stderr).toContain("outside the owning generators' outputs");
    editManifest(out, (manifest) => {
      manifest.files.pop();
    });

    // A resolution built for another branch head or another main.
    const other = "f".repeat(40);
    editManifest(out, (manifest) => {
      manifest.main = other;
    });
    expect(publish(origin, head, out).stderr).toContain("not on main");
    editManifest(out, (manifest) => {
      manifest.main = main;
    });
    expect(publish(origin, other, out).exitCode).not.toBe(0);

    // A symlink inside the collected data itself.
    symlinkSync("/etc/hosts", path.join(out, "files", "link"));
    expect(publish(origin, head, out).stderr).toContain("non-regular entry");
  }, 15_000);

  test("a deletion of a file nobody conflicted on is refused", () => {
    const { origin, head, main } = fixture();
    const { out } = resolve({ origin, head, main });
    for (const target of [
      // An ordinary file the merge resolved cleanly.
      NOTES,
      // Another generator's output: only owners of a conflict may write.
      "packages/transactional/i18n/langs/messages.gen.ts",
    ]) {
      editManifest(out, (manifest) => {
        manifest.files.push({ path: target, deleted: true, mode: "100644" });
      });
      const published = publish(origin, head, out);
      expect(published.exitCode, target).not.toBe(0);
      expect(published.stderr, target).toContain(
        `${target} is outside the owning generators' outputs`,
      );
      editManifest(out, (manifest) => {
        manifest.files.pop();
      });
    }
    expect(publish(origin, head, out).exitCode).toBe(0);
  });

  test("a collected artifact cannot delete a non-conflicted bun.lock", () => {
    const { origin, head, main } = fixture({
      baseEdits: (repo) =>
        write(
          repo,
          "bun.lock",
          JSON.stringify({
            lockfileVersion: 3,
            workspaces: { "": { name: "fixture" } },
            packages: { common: ["common@1.0.0"] },
          }),
        ),
    });
    const { out } = resolve({
      origin,
      head,
      main,
      regenerate: (repo) => rmSync(path.join(repo, "bun.lock")),
    });
    const planned = JSON.parse(
      readFileSync(path.join(root, "plan.json"), "utf-8"),
    );
    expect(planned.conflicts).toEqual([
      { path: MESSAGES, kind: "both-modified" },
    ]);
    const manifest = JSON.parse(
      readFileSync(path.join(out, "manifest.json"), "utf-8"),
    );
    expect(manifest.files).toContainEqual({
      path: "bun.lock",
      deleted: true,
      mode: "100644",
    });
    const published = publish(origin, head, out);
    expect(published.exitCode).not.toBe(0);
    expect(published.stderr).toContain(
      "bun.lock: cannot delete a format or lockfile resolution",
    );
  });

  test("a branch that moved between the jobs gets no merge from the old resolution", () => {
    const { origin, head, main } = fixture();
    const { out } = resolve({ origin, head, main });
    git(origin, "switch", "-q", "feature");
    write(origin, "apps/api/later.txt", "pushed after the resolve run\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "later");
    const moved = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    const published = publish(origin, moved, out);
    expect(published.exitCode).not.toBe(0);
    expect(published.stderr).toContain(
      "The collected resolution is for a different head",
    );
  });

  test("main that moved between the jobs still merges the commit that was resolved", () => {
    const { origin, head, main } = fixture();
    const { out } = resolve({ origin, head, main });
    write(origin, "apps/api/later.txt", "landed after the resolve run\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "later");
    expect(git(origin, "rev-parse", "HEAD")).not.toBe(main);
    const published = publish(origin, head, out);
    expect(published.exitCode, published.stderr).toBe(0);
    const commit = JSON.parse(
      readFileSync(path.join(published.requests, "commit.json"), "utf-8"),
    );
    expect(commit.parents).toEqual([head, main]);
  });

  test("a mixed conflict is left to people, even in the trusted run", () => {
    // The fixture already conflicts in the generated message types; this
    // adds a conflict in source next to it.
    const { origin, head, main } = fixture({
      branchEdits: (repo) => write(repo, "apps/api/src/index.ts", "branch\n"),
      mainEdits: (repo) => write(repo, "apps/api/src/index.ts", "main\n"),
    });
    const repo = path.join(root, "resolve");
    git(root, "clone", "-q", origin, repo);
    const planned = cli(
      repo,
      "plan",
      "--git-dir",
      ".git",
      "--head",
      head,
      "--main",
      main,
    );
    expect(planned.exitCode, planned.stderr).toBe(0);
    const result = JSON.parse(planned.stdout);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(
      "apps/api/src/index.ts: not a generated output",
    );
    // A resolve run that claims otherwise is refused when the merge is
    // rebuilt, whatever it collected.
    const out = path.join(root, "forged");
    mkdirSync(path.join(out, "files"), { recursive: true });
    writeFileSync(
      path.join(out, "manifest.json"),
      JSON.stringify({
        head,
        main,
        baseline: "0".repeat(40),
        tree: "0".repeat(40),
        deletions: [],
        files: [],
      }),
    );
    const published = publish(origin, head, out);
    expect(published.exitCode).not.toBe(0);
    expect(published.stderr).toContain("The merge is not generated-only");
    expect(published.stderr).toContain(
      "apps/api/src/index.ts: not a generated output",
    );
  });
});

describe("branch update", () => {
  const head = "1".repeat(40);
  const main = "2".repeat(40);
  const tree = "3".repeat(40);
  const commit = "4".repeat(40);
  const blob = "5".repeat(40);

  const requests = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "generated-push-"));
    mkdirSync(path.join(directory, "blobs"));
    writeFileSync(
      path.join(directory, "expected.json"),
      JSON.stringify({ head, main, tree }),
    );
    writeFileSync(path.join(directory, "tree.json"), "{}");
    writeFileSync(path.join(directory, "commit.json"), "{}");
    return directory;
  };

  const github = (
    updateRefsErrors: unknown[] | null,
    blobStatuses: number[] = [],
  ) => {
    const calls: { route: string; body: unknown }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const route = url.replace("https://api.example", "");
      const body: unknown = JSON.parse(
        typeof init.body === "string" ? init.body : "null",
      );
      calls.push({ route, body });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (route.endsWith("/git/blobs")) {
        const status = blobStatuses.shift();
        return status === undefined
          ? json({ sha: blob })
          : new Response("unavailable", { status });
      }
      if (route.endsWith("/git/trees")) {
        return json({ sha: tree });
      }
      if (route.endsWith("/git/commits")) {
        return json({
          sha: commit,
          tree: { sha: tree },
          parents: [{ sha: head }, { sha: main }],
        });
      }
      if (String(field(body, "query")).startsWith("query")) {
        return json({ data: { repository: { id: "R_1" } } });
      }
      return json(
        updateRefsErrors === null
          ? { data: { updateRefs: { clientMutationId: null } } }
          : { errors: updateRefsErrors },
      );
    };
    return { calls, fetch };
  };

  test("moves the branch only from the resolved head", async () => {
    const { calls, fetch } = github(null);
    const directory = requests();
    try {
      expect(
        await push({
          requests: directory,
          repository: "stella/stella",
          branch: "feat/x",
          token: "token",
          api: "https://api.example",
          fetch,
        }),
      ).toBe(commit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const update = calls.at(-1);
    expect(update?.route).toBe("/graphql");
    expect(update?.body).toMatchObject({
      variables: { input: { repositoryId: "R_1" } },
    });
    const refUpdates = field(update?.body, "variables", "input", "refUpdates");
    expect(refUpdates).toEqual([
      {
        name: "refs/heads/feat/x",
        beforeOid: head,
        afterOid: commit,
        force: false,
      },
    ]);
    // Never a plain ref PATCH, which would fast-forward from any ancestor.
    expect(calls.some(({ route }) => route.includes("/git/refs"))).toBe(false);
  });

  test("a branch that moved in the meantime is not overwritten", async () => {
    const { fetch } = github([
      { message: "A ref update failed: expected beforeOid did not match" },
    ]);
    const directory = requests();
    let refusal: unknown;
    try {
      await push({
        requests: directory,
        repository: "stella/stella",
        branch: "feat/x",
        token: "token",
        api: "https://api.example",
        fetch,
      });
    } catch (error) {
      refusal = error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(String(refusal)).toContain("GraphQL refused");
  });

  const withBlob = () => {
    const directory = requests();
    writeFileSync(
      path.join(directory, "blobs", `${blob}.json`),
      JSON.stringify({ content: "", encoding: "base64" }),
    );
    return directory;
  };

  test("a server error on an object write is repeated", async () => {
    const { calls, fetch } = github(null, [500, 502]);
    const directory = withBlob();
    try {
      expect(
        await push({
          requests: directory,
          repository: "stella/stella",
          branch: "feat/x",
          token: "token",
          api: "https://api.example",
          fetch,
          retryDelayMs: 0,
        }),
      ).toBe(commit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(
      calls.filter(({ route }) => route.endsWith("/git/blobs")),
    ).toHaveLength(3);
  });

  test("a refused object write is not repeated", async () => {
    const { calls, fetch } = github(null, [422]);
    const directory = withBlob();
    let refusal: unknown;
    try {
      await push({
        requests: directory,
        repository: "stella/stella",
        branch: "feat/x",
        token: "token",
        api: "https://api.example",
        fetch,
        retryDelayMs: 0,
      });
    } catch (error) {
      refusal = error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(String(refusal)).toContain("git/blobs answered 422");
    expect(calls).toHaveLength(1);
  });
});
