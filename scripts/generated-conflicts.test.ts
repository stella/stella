import { afterEach, describe, expect, test } from "bun:test";
import {
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
  classifyConflicts,
  conflictsOf,
  isAllowedResolution,
  parseStageEntries,
  pathShapeProblem,
  push,
} from "./generated-conflicts";
import { GENERATORS } from "./generated-files";

const MESSAGES = "apps/web/src/i18n/langs/messages.gen.ts";

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

describe("classification", () => {
  test("a conflict only in an autofix generator's output is regenerable", () => {
    const result = classifyConflicts([
      { path: MESSAGES, kind: "both-modified" },
    ]);
    expect(result.eligible).toBe(true);
    if (!result.eligible) {
      return;
    }
    expect(result.ids).toContain("i18n-messages-web");
    expect(isAllowedResolution(MESSAGES, result)).toBe(true);
    for (const refused of [
      "apps/web/src/i18n/langs/cs.json",
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
  const lines = (edit: (rows: string[]) => void) => {
    const rows = Array.from(
      { length: 20 },
      (_, index) => `line ${String(index)}`,
    );
    edit(rows);
    return `${rows.join("\n")}\n`;
  };

  type Fixture = {
    branchEdits?: (origin: string) => void;
    mainEdits?: (origin: string) => void;
  };
  // main and the branch both regenerate the message types from catalogue
  // edits that merge cleanly; each side also edits a different hunk of an
  // ordinary file, which the merge combines into a blob neither side has.
  const fixture = ({ branchEdits, mainEdits }: Fixture = {}) => {
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

  /** The untrusted resolve run, with a stand-in generator. */
  const resolve = (
    origin: string,
    head: string,
    main: string,
    regenerated = "type Messages = { a: string; b: string; c: string };\n",
  ) => {
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

  test("the trusted run rebuilds exactly the collected tree", () => {
    const { origin, head, main } = fixture();
    const { out, regenerated } = resolve(origin, head, main);
    const published = publish(origin, head, out);
    expect(published.exitCode, published.stderr).toBe(0);
    const commit = JSON.parse(
      readFileSync(path.join(published.requests, "commit.json"), "utf-8"),
    );
    expect(commit.parents).toEqual([head, main]);
    const tree = JSON.parse(
      readFileSync(path.join(published.requests, "tree.json"), "utf-8"),
    );
    const entry = (file: string) =>
      tree.tree.find((item: { path: string }) => item.path === file);
    expect(entry(MESSAGES)).toMatchObject({ mode: "100644", type: "blob" });
    // Every blob neither parent has is uploaded, including the one the
    // clean part of the merge synthesized for the ordinary file.
    const uploads = readdirSync(path.join(published.requests, "blobs"))
      .map((file) => file.replace(/\.json$/u, ""))
      .toSorted();
    expect(uploads).toEqual([entry(MESSAGES).sha, entry(NOTES).sha].toSorted());
    const blob = JSON.parse(
      readFileSync(
        path.join(published.requests, "blobs", `${entry(MESSAGES).sha}.json`),
        "utf-8",
      ),
    );
    expect(Buffer.from(blob.content, "base64").toString()).toBe(regenerated);
  });

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
    const { out } = resolve(origin, head, main);
    const plan = JSON.parse(
      readFileSync(path.join(root, "plan.json"), "utf-8"),
    );
    expect(plan.conflicts).toEqual([{ path: MESSAGES, kind: "both-modified" }]);
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
    const { out } = resolve(origin, head, main);
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

  test("tampered or foreign data never reaches a request", () => {
    const { origin, head, main } = fixture();
    const { out, regenerated } = resolve(origin, head, main);

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
  });

  test("a source conflict is left to people", () => {
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
  });
});

describe("branch update", () => {
  const head = "1".repeat(40);
  const main = "2".repeat(40);
  const tree = "3".repeat(40);
  const commit = "4".repeat(40);

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

  const github = (updateRefsErrors: unknown[] | null) => {
    const calls: { route: string; body: unknown }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const route = url.replace("https://api.example", "");
      const body: unknown = JSON.parse(String(init.body));
      calls.push({ route, body });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
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
});
