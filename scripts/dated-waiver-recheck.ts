import { panic, Result, TaggedError } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  DOC_SOURCE_EXCLUSIONS,
  type NoLlmsTxtExclusion,
} from "../.claude/mcp/doc-sources";
import {
  DAY_MS,
  DOC_SOURCE_FILE,
  dueWaivers,
  loadWaivers,
  RECHECK_DAYS,
  RECHECK_INSTRUCTIONS,
  type DatedWaiver,
} from "./dated-waivers";

export const RECHECK_BRANCH = "chore/recheck-dated-waivers";
export const RECHECK_TITLE = "chore: recheck dated waivers";
export const CHECKLIST_FILE = "docs/maintenance/dated-waiver-recheck.md";

type DocRecheck =
  | {
      status: "renewed";
      dependency: string;
      checkedAt: string;
      expiresAt: string;
    }
  | { status: "available"; dependency: string; url: string }
  | { status: "manual"; dependency: string; detail: string };

type RecheckDocOptions = {
  entry: NoLlmsTxtExclusion;
  now: Date;
  probe: (url: string) => Promise<number>;
};
export const recheckDoc = async ({
  entry,
  now,
  probe,
}: RecheckDocOptions): Promise<DocRecheck> => {
  const url = /https:\/\/[^\s()]+\/llms\.txt\b/u.exec(entry.explanation)?.at(0);
  if (url === undefined) {
    return {
      status: "manual",
      dependency: entry.dependency,
      detail: "No llms.txt URL recorded; recheck canonical documentation.",
    };
  }
  const response = await Result.tryPromise(() => probe(url));
  if (Result.isError(response)) {
    return {
      status: "manual",
      dependency: entry.dependency,
      detail: `Fetch failed for ${url}; entry unchanged.`,
    };
  }
  if (response.value === 200) {
    return { status: "available", dependency: entry.dependency, url };
  }
  if (response.value !== 404) {
    return {
      status: "manual",
      dependency: entry.dependency,
      detail: `HTTP ${response.value} from ${url}; entry unchanged.`,
    };
  }
  const checkedAt = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const window = Date.parse(entry.expiresAt) - Date.parse(entry.checkedAt);
  if (window <= 0 || window > 31 * DAY_MS) {
    panic(`Invalid documentation review window: ${entry.dependency}`);
  }
  return {
    status: "renewed",
    dependency: entry.dependency,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + window).toISOString(),
  };
};

type SourceEdit = { start: number; end: number; text: string };
// Read typed data from the owner; AST offsets only preserve its source layout.
export const applyDocRechecks = (
  source: string,
  decisions: readonly DocRecheck[],
): string => {
  const ast = ts.createSourceFile(
    DOC_SOURCE_FILE,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  let sourceMap: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === "DOC_SOURCES" &&
      node.initializer
    ) {
      let value = node.initializer;
      while (ts.isSatisfiesExpression(value) || ts.isAsExpression(value)) {
        value = value.expression;
      }
      if (ts.isObjectLiteralExpression(value)) {
        sourceMap = value;
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText(ast) === "dependency" &&
          ts.isStringLiteral(property.initializer)
        ) {
          objects.set(property.initializer.text, node);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const edits: SourceEdit[] = [];
  const additions: string[] = [];
  for (const decision of decisions) {
    if (decision.status === "manual") {
      continue;
    }
    const object = objects.get(decision.dependency);
    if (object === undefined) {
      panic(`Documentation exclusion object missing: ${decision.dependency}`);
    }
    switch (decision.status) {
      case "renewed": {
        for (const key of ["checkedAt", "expiresAt"] as const) {
          const property = object.properties.find(
            (value) =>
              ts.isPropertyAssignment(value) && value.name.getText(ast) === key,
          );
          if (!property || !ts.isPropertyAssignment(property)) {
            panic(`Documentation ${key} missing: ${decision.dependency}`);
          }
          edits.push({
            start: property.initializer.getStart(ast),
            end: property.initializer.end,
            text: JSON.stringify(decision[key]),
          });
        }
        break;
      }
      case "available": {
        // Scanner trivia includes comments between an argument and its comma.
        scanner.setTextPos(object.end);
        const token = scanner.scan();
        edits.push({
          start: object.getStart(ast),
          end:
            token === ts.SyntaxKind.CommaToken
              ? scanner.getTextPos()
              : object.end,
          text: "",
        });
        additions.push(
          `  ${JSON.stringify(decision.dependency)}: { dependencies: [${JSON.stringify(decision.dependency)}], url: ${JSON.stringify(decision.url)} },\n`,
        );
        break;
      }
      default: {
        decision satisfies never;
        panic("Unhandled documentation recheck decision");
      }
    }
  }
  if (additions.length > 0) {
    if (!sourceMap) {
      panic("Documentation source registry missing");
    }
    const separator =
      sourceMap.properties.length > 0 && !sourceMap.properties.hasTrailingComma
        ? ","
        : "";
    // NodeArray.end follows the existing separator, before closing-brace trivia.
    // One insertion retains comments and works even with adjacent braces.
    edits.push({
      start: sourceMap.properties.end,
      end: sourceMap.properties.end,
      text: `${separator}\n${additions.join("")}`,
    });
  }
  let updated = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    updated =
      updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  }
  return updated;
};

const markdown = (text: string): string =>
  text.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("`", "'");
export const renderRecheckBody = (
  entries: readonly DatedWaiver[],
  decisions: readonly DocRecheck[],
): string => {
  const byId = new Map(
    decisions.map((decision) => [decision.dependency, decision]),
  );
  const lines = [
    "Recheck the dated exceptions below before their review windows end.",
    "",
  ];
  for (const entry of entries) {
    const decision =
      entry.kind === "no-llms-txt" ? byId.get(entry.id) : undefined;
    let detail: string = RECHECK_INSTRUCTIONS[entry.kind];
    if (decision?.status === "renewed") {
      detail = `llms.txt still returns 404; proposed renewal through ${decision.expiresAt.slice(0, 10)}. Review the evidence.`;
    }
    if (decision?.status === "available") {
      detail = `llms.txt returns 200; proposed source registration at ${decision.url} and removal of the exclusion.`;
    }
    if (decision?.status === "manual") {
      detail = decision.detail;
    }
    lines.push(
      `- [ ] \`${markdown(entry.source)}:${entry.line}\` · ${entry.kind} · \`${markdown(entry.id)}\` · expires ${entry.expiresAt.slice(0, 10)}: ${markdown(detail)}`,
    );
  }
  lines.push(
    "",
    "Only documentation exclusions with a recorded llms.txt URL receive mechanical changes. All other exceptions require review.",
    "",
  );
  return lines.join("\n");
};

export type RecheckPr = { number: number; body: string; title: string };
type ReconcilePrOptions = {
  body: string;
  github: {
    list: () => Promise<readonly RecheckPr[]>;
    create: (body: string) => Promise<number>;
    update: (number: number, body: string) => Promise<void>;
  };
};
export const reconcileRecheckPr = async ({
  body,
  github,
}: ReconcilePrOptions): Promise<number> => {
  const open = await github.list();
  if (open.length > 1) {
    panic(
      "Multiple open dated-waiver recheck PRs; reconcile the reserved branch.",
    );
  }
  const existing = open.at(0);
  if (!existing) {
    return github.create(body);
  }
  if (existing.body !== body || existing.title !== RECHECK_TITLE) {
    await github.update(existing.number, body);
  }
  return existing.number;
};

class GitHubRecheckError extends TaggedError("GitHubRecheckError")<{
  message: string;
}> {}

const MODULE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const validateGeneratedModules = (
  files: Readonly<Record<string, string>>,
): void => {
  for (const [file, content] of Object.entries(files)) {
    if (!MODULE_EXTENSIONS.has(path.extname(file))) {
      continue;
    }
    const source = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    const options = { allowJs: true, noLib: true, noResolve: true };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => (name === file ? source : undefined);
    const diagnostics = ts
      .createProgram([file], options, host)
      .getSyntacticDiagnostics(source);
    if (diagnostics.length > 0) {
      throw new GitHubRecheckError({
        message: `Generated module has syntax diagnostics: ${file}: ${diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join("; ")}`,
      });
    }
  }
};

const root = path.resolve(import.meta.dir, "..");
const gh = async (
  args: readonly string[],
  input?: unknown,
): Promise<unknown> => {
  const proc = Bun.spawn(
    ["bash", path.join(root, "scripts/gh-retry.sh"), "api", ...args],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new GitHubRecheckError({
      message: `GitHub request failed (${exit}): ${stderr}`,
    });
  }
  if (stdout.trim() === "") {
    return null;
  }
  return JSON.parse(stdout);
};
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    panic("Invalid GitHub object");
  }
  return value;
};
const textField = (value: unknown): string => {
  if (typeof value !== "string") {
    panic("Invalid GitHub string");
  }
  return value;
};
const prNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    panic("Invalid GitHub PR number");
  }
  return value;
};

// The two branch refs are reserved for this workflow. Build a proposal before
// swapping the PR head; moving an open PR straight to main would close it.
type PublishRecheckOptions = {
  baseSha: string;
  baseFiles: Readonly<Record<string, string>>;
  body: string;
  files: Readonly<Record<string, string>>;
  repo: string | undefined;
  request: typeof gh;
};
export const publishRecheck = async ({
  baseSha,
  baseFiles,
  body,
  files,
  repo,
  request,
}: PublishRecheckOptions): Promise<number | undefined> => {
  validateGeneratedModules(files);
  if (repo !== "stella/stella") {
    panic("Dated-waiver publishing requires stella/stella");
  }
  const owner = repo.split("/").at(0);
  const api = `repos/${repo}`;
  const setRef = async (branch: string, sha: string): Promise<void> => {
    const refs = await request([`${api}/git/matching-refs/heads/${branch}`]);
    if (!Array.isArray(refs)) {
      panic("Invalid GitHub refs");
    }
    const exists = refs.some(
      (ref) => record(ref).ref === `refs/heads/${branch}`,
    );
    await request(
      [
        exists ? `${api}/git/refs/heads/${branch}` : `${api}/git/refs`,
        "--method",
        exists ? "PATCH" : "POST",
        "--input",
        "-",
      ],
      exists ? { sha, force: true } : { ref: `refs/heads/${branch}`, sha },
    );
  };
  const github = {
    list: async (): Promise<RecheckPr[]> => {
      const result = await request([
        `${api}/pulls`,
        "--method",
        "GET",
        "-f",
        "state=open",
        "-f",
        "base=main",
        "-f",
        `head=${owner}:${RECHECK_BRANCH}`,
        "-f",
        "per_page=100",
      ]);
      if (!Array.isArray(result)) {
        panic("Invalid GitHub pull requests");
      }
      return result.map((raw: unknown) => {
        const pr = record(raw);
        return {
          number: prNumber(pr.number),
          body: textField(pr.body ?? ""),
          title: textField(pr.title),
        };
      });
    },
    create: async (prBody: string): Promise<number> =>
      prNumber(
        record(
          await request([`${api}/pulls`, "--method", "POST", "--input", "-"], {
            head: RECHECK_BRANCH,
            base: "main",
            title: RECHECK_TITLE,
            body: prBody,
            draft: true,
          }),
        ).number,
      ),
    update: async (number: number, prBody: string): Promise<void> => {
      await request(
        [`${api}/pulls/${number}`, "--method", "PATCH", "--input", "-"],
        { title: RECHECK_TITLE, body: prBody },
      );
    },
  };
  // Refuse ambiguous state before any branch mutation.
  const open = await github.list();
  if (open.length > 1) {
    panic(
      "Multiple open dated-waiver recheck PRs; reconcile the reserved branch.",
    );
  }
  const existing = open.at(0);
  if (
    !existing &&
    Object.entries(files).every(
      ([file, content]) => baseFiles[file] === content,
    )
  ) {
    return undefined;
  }
  if (existing) {
    const sameFiles = await Promise.all(
      Object.entries(files).map(async ([file, content]) => {
        const response = record(
          await request([
            `${api}/contents/${file}`,
            "--method",
            "GET",
            "-f",
            `ref=${RECHECK_BRANCH}`,
          ]),
        );
        return (
          Buffer.from(textField(response.content), "base64").toString(
            "utf-8",
          ) === content
        );
      }),
    );
    if (sameFiles.every(Boolean)) {
      return reconcileRecheckPr({ body, github });
    }
  }
  // File contents were generated from this checkout, so the commit must share
  // its base even when main advances while documentation requests are running.
  const base = baseSha;
  const buildBranch = `${RECHECK_BRANCH}-next`;
  await setRef(buildBranch, base);
  const commit = record(
    await request(["graphql", "--input", "-"], {
      query:
        "mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repo, branchName: buildBranch },
          expectedHeadOid: base,
          message: { headline: RECHECK_TITLE },
          fileChanges: {
            additions: Object.entries(files).map(([file, contents]) => ({
              path: file,
              contents: Buffer.from(contents).toString("base64"),
            })),
          },
        },
      },
    }),
  );
  if (commit.errors !== undefined) {
    throw new GitHubRecheckError({
      message: `GitHub signed commit failed: ${JSON.stringify(commit.errors)}`,
    });
  }
  const sha = textField(
    record(record(record(commit.data).createCommitOnBranch).commit).oid,
  );
  await setRef(RECHECK_BRANCH, sha);
  await request([`${api}/git/refs/heads/${buildBranch}`, "--method", "DELETE"]);
  return reconcileRecheckPr({ body, github });
};

const main = async (): Promise<void> => {
  const checkout = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  if (checkout.exitCode !== 0) {
    panic("Cannot resolve dated-waiver proposal checkout");
  }
  const baseSha = checkout.stdout.toString().trim();
  const now = new Date();
  const entries = await loadWaivers();
  if (dueWaivers(entries, now).length === 0) {
    console.log("No dated waiver is due within five days.");
    return;
  }
  const due = dueWaivers(entries, now, RECHECK_DAYS);
  const ids = new Set(
    due
      .filter((entry) => entry.kind === "no-llms-txt")
      .map((entry) => entry.id),
  );
  const decisions: DocRecheck[] = [];
  const probes = new Map<string, Promise<number>>();
  for (const entry of DOC_SOURCE_EXCLUSIONS) {
    if (!ids.has(entry.dependency)) {
      continue;
    }
    decisions.push(
      await recheckDoc({
        entry,
        now,
        probe: (url) => {
          let pending = probes.get(url);
          if (!pending) {
            pending = fetch(url, { signal: AbortSignal.timeout(15_000) }).then(
              (response) => response.status,
            );
            probes.set(url, pending);
          }
          return pending;
        },
      }),
    );
  }
  const source = readFileSync(path.join(root, DOC_SOURCE_FILE), "utf-8");
  const updated = applyDocRechecks(source, decisions);
  const body = renderRecheckBody(due, decisions);
  const files = { [CHECKLIST_FILE]: body, [DOC_SOURCE_FILE]: updated };
  if (process.argv.includes("--publish")) {
    const tracked = Bun.spawnSync(
      ["git", "ls-tree", "--name-only", baseSha, "--", ...Object.keys(files)],
      { cwd: root },
    );
    if (tracked.exitCode !== 0) {
      panic("Cannot list dated-waiver proposal base files");
    }
    const baseFiles = Object.fromEntries(
      tracked.stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((file) => {
          const original = Bun.spawnSync(
            ["git", "show", `${baseSha}:${file}`],
            {
              cwd: root,
            },
          );
          if (original.exitCode !== 0) {
            panic("Cannot read dated-waiver proposal base file");
          }
          return [file, original.stdout.toString()];
        }),
    );
    const number = await publishRecheck({
      baseSha,
      baseFiles,
      body,
      files,
      repo: process.env.GITHUB_REPOSITORY,
      request: gh,
    });
    console.log(
      number === undefined
        ? "Dated-waiver proposal matches the checkout; nothing to publish."
        : `Dated-waiver recheck PR #${number}`,
    );
  } else {
    for (const [file, contents] of Object.entries(files)) {
      writeFileSync(path.join(root, file), contents);
    }
    console.log(body);
  }
};
if (import.meta.main) {
  await main();
}
