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

import {
  classifyConflicts,
  isAllowedResolution,
  parseUnmerged,
} from "./generated-conflicts";
import { GENERATORS } from "./generated-files";

const MESSAGES = "apps/web/src/i18n/langs/messages.gen.ts";
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
    expect(result.allowed).toContain(MESSAGES);
    expect(isAllowedResolution(MESSAGES, result)).toBe(true);
    expect(isAllowedResolution("apps/web/src/i18n/langs/cs.json", result)).toBe(
      false,
    );
    expect(isAllowedResolution(".github/workflows/ci.yml", result)).toBe(false);
    expect(isAllowedResolution("apps/web/../../etc/passwd", result)).toBe(
      false,
    );
  });

  const leftToPeople: { name: string; path: string; kind?: "delete-modify" }[] =
    [
      { name: "source", path: "apps/api/src/index.ts" },
      { name: "the root lockfile", path: "bun.lock" },
      { name: "a nested lockfile", path: "apps/desktop/src-tauri/Cargo.lock" },
      // Output of the autofix mcp-surface generator, but a decision record.
      { name: "a baseline", path: "apps/api/mcp-surface-baseline.json" },
      { name: "a changeset", path: ".changeset/new.md" },
      // design-tokens only owns marked blocks of this file.
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

  test("reads git's unmerged stages", () => {
    const sha = "a".repeat(40);
    const records = [
      `100644 ${sha} 1\tboth.ts`,
      `100644 ${sha} 2\tboth.ts`,
      `100644 ${sha} 3\tboth.ts`,
      `100644 ${sha} 2\tadded.ts`,
      `100644 ${sha} 3\tadded.ts`,
      `100644 ${sha} 1\tgone.ts`,
      `100644 ${sha} 3\tgone.ts`,
    ];
    expect(parseUnmerged(`${records.join("\0")}\0`)).toEqual([
      { path: "both.ts", kind: "both-modified" },
      { path: "added.ts", kind: "both-added" },
      { path: "gone.ts", kind: "delete-modify" },
    ]);
  });
});

describe("resolution across jobs", () => {
  let root = "";
  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const run = (cwd: string, command: readonly string[]) => {
    const result = Bun.spawnSync([...command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
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
  const conflicts = (cli: readonly string[], repo: string) =>
    run(repo, ["bun", SCRIPT, ...cli, "--repo", repo]);

  // main and the branch both regenerate the message types from different
  // catalogue edits that merge cleanly.
  const fixture = (branchSource: string) => {
    root = mkdtempSync(path.join(tmpdir(), "generated-conflicts-"));
    const origin = path.join(root, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    write(origin, MESSAGES, "type Messages = { a: string };\n");
    write(origin, "apps/api/src/index.ts", "export {};\n");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "base");
    git(origin, "switch", "-qc", "feature");
    write(origin, MESSAGES, "type Messages = { a: string; b: string };\n");
    write(origin, "apps/api/src/index.ts", branchSource);
    git(origin, "commit", "-qam", "feature");
    const head = git(origin, "rev-parse", "HEAD");
    git(origin, "switch", "-q", "main");
    write(origin, MESSAGES, "type Messages = { a: string; c: string };\n");
    git(origin, "commit", "-qam", "main");
    const main = git(origin, "rev-parse", "HEAD");
    const clone = (name: string) => {
      const target = path.join(root, name);
      git(root, "clone", "-q", origin, target);
      git(target, "checkout", "-q", "--detach", head);
      return target;
    };
    return { head, main, clone };
  };

  test("the trusted job rebuilds exactly the collected tree", () => {
    const { head, main, clone } = fixture("export {};\n");
    const untrusted = clone("resolve");
    const plan = path.join(root, "classification.json");
    const merged = conflicts(["merge", "--main", main], untrusted);
    expect(merged.exitCode, merged.stderr).toBe(0);
    expect(JSON.parse(merged.stdout)).toMatchObject({
      eligible: true,
      conflicts: [{ path: MESSAGES, kind: "both-modified" }],
    });
    writeFileSync(plan, merged.stdout);
    const baseline = conflicts(["take-main", "--plan", plan], untrusted);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    // Stand-in for the generator: the merged catalogue has both keys.
    const regenerated =
      "type Messages = { a: string; b: string; c: string };\n";
    write(untrusted, MESSAGES, regenerated);
    const out = path.join(root, "resolution");
    const collected = conflicts(
      [
        "collect",
        "--head",
        head,
        "--main",
        main,
        "--plan",
        plan,
        "--baseline",
        baseline.stdout,
        "--out",
        out,
      ],
      untrusted,
    );
    expect(collected.exitCode, collected.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(path.join(out, "manifest.json"), "utf-8"),
    );
    expect(manifest.files).toEqual([{ path: MESSAGES, deleted: false }]);

    const trusted = clone("publish");
    const requests = path.join(root, "requests");
    const prepared = conflicts(
      [
        "prepare",
        "--head",
        head,
        "--main",
        main,
        "--collected",
        out,
        "--out",
        requests,
      ],
      trusted,
    );
    expect(prepared.exitCode, prepared.stderr).toBe(0);
    expect(readFileSync(path.join(requests, "expected-tree"), "utf-8")).toBe(
      `${manifest.tree}\n`,
    );
    const commit = JSON.parse(
      readFileSync(path.join(requests, "commit.json"), "utf-8"),
    );
    expect(commit.parents).toEqual([head, main]);
    expect(commit.tree).toBe(manifest.tree);
    const tree = JSON.parse(
      readFileSync(path.join(requests, "tree.json"), "utf-8"),
    );
    expect(tree.base_tree).toBe(git(trusted, "rev-parse", `${head}^{tree}`));
    expect(tree.tree).toEqual([
      expect.objectContaining({ path: MESSAGES, mode: "100644", type: "blob" }),
    ]);
    const blob = JSON.parse(
      readFileSync(path.join(requests, "blobs", "0.json"), "utf-8"),
    );
    expect(Buffer.from(blob.content, "base64").toString()).toBe(regenerated);

    // Tampered data never reaches a request: a different content changes the
    // tree, and a path outside the owners' outputs is refused outright.
    writeFileSync(path.join(out, "files", MESSAGES), "tampered\n");
    const tampered = conflicts(
      [
        "prepare",
        "--head",
        head,
        "--main",
        main,
        "--collected",
        out,
        "--out",
        requests,
      ],
      clone("publish-tampered"),
    );
    expect(tampered.exitCode).not.toBe(0);
    expect(tampered.stderr).toContain("differs from the collected tree");

    writeFileSync(path.join(out, "files", MESSAGES), regenerated);
    write(
      path.join(out, "files"),
      "apps/api/src/index.ts",
      "export const x = 1;\n",
    );
    manifest.files.push({ path: "apps/api/src/index.ts", deleted: false });
    writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
    const smuggled = conflicts(
      [
        "prepare",
        "--head",
        head,
        "--main",
        main,
        "--collected",
        out,
        "--out",
        requests,
      ],
      clone("publish-smuggled"),
    );
    expect(smuggled.exitCode).not.toBe(0);
    expect(smuggled.stderr).toContain("outside the owning generators' outputs");
  });

  test("a source conflict is left to people", () => {
    const { main, clone } = fixture("export const feature = 1;\n");
    // Make main touch the same source line too.
    const origin = path.join(root, "origin");
    write(origin, "apps/api/src/index.ts", "export const main = 1;\n");
    git(origin, "commit", "-qam", "main source");
    const mainWithSource = git(origin, "rev-parse", "HEAD");
    expect(mainWithSource).not.toBe(main);
    const repo = clone("resolve");
    const merged = conflicts(["merge", "--main", mainWithSource], repo);
    expect(merged.exitCode, merged.stderr).toBe(0);
    const result = JSON.parse(merged.stdout);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(
      "apps/api/src/index.ts: not a generated output",
    );
    expect(existsSync(path.join(repo, ".git/MERGE_HEAD"))).toBe(true);
  });
});
