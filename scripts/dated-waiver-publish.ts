import { panic, TaggedError } from "better-result";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

export const REMOVAL_TITLE = "chore: remove verified dated waiver";
type RemovalPr = { number: number; body: string; title: string };
type ReconcileRemovalOptions = {
  body: string;
  github: {
    list: () => Promise<RemovalPr[]>;
    create: (body: string) => Promise<number>;
    update: (number: number, body: string) => Promise<void>;
  };
};
export const reconcileRemovalPr = async ({
  body,
  github,
}: ReconcileRemovalOptions): Promise<number> => {
  const open = await github.list();
  if (open.length > 1) {
    panic("Multiple removal pull requests for reserved branch");
  }
  const existing = open.at(0);
  if (!existing) {
    return github.create(body);
  }
  if (existing.body !== body || existing.title !== REMOVAL_TITLE) {
    await github.update(existing.number, body);
  }
  return existing.number;
};

class WaiverPublishError extends TaggedError("WaiverPublishError")<{
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
export const validateRemovalModules = (
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
      throw new WaiverPublishError({
        message: `Generated module has syntax diagnostics: ${file}: ${diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join("; ")}`,
      });
    }
  }
};

const root = path.resolve(import.meta.dir, "..");
export const githubRequest = async (
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
  const [stdout, , exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new WaiverPublishError({
      message: `GitHub request failed (${exit}); response withheld.`,
    });
  }
  if (stdout.trim() === "") {
    return null;
  }
  return JSON.parse(stdout);
};
const PR_NUMBER = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const REF_LIST = v.array(v.object({ ref: v.string() }));
const PR_LIST = v.array(
  v.object({
    number: PR_NUMBER,
    body: v.nullish(v.string(), ""),
    title: v.string(),
  }),
);
const CREATED_PR = v.object({ number: PR_NUMBER });
const FILE_CONTENT = v.object({ content: v.string() });
const REF_HEAD = v.object({ object: v.object({ sha: v.string() }) });
const COMMIT_PARENTS = v.object({
  parents: v.array(v.object({ sha: v.string() })),
});
const SIGNED_COMMIT = v.union([
  v.object({
    errors: v.pipe(v.array(v.object({ message: v.string() })), v.minLength(1)),
  }),
  v.object({
    data: v.object({
      createCommitOnBranch: v.object({ commit: v.object({ oid: v.string() }) }),
    }),
  }),
]);

// The two branch refs are reserved for this workflow. Build a proposal before
// swapping the PR head; moving an open PR straight to main would close it.
type PublishRemovalOptions = {
  branch: string;
  baseSha: string;
  baseFiles: Readonly<Record<string, string>>;
  body: string;
  files: Readonly<Record<string, string>>;
  repo: string | undefined;
  request: typeof githubRequest;
};
export const publishRemoval = async ({
  branch,
  baseSha,
  baseFiles,
  body,
  files,
  repo,
  request,
}: PublishRemovalOptions): Promise<number | undefined> => {
  validateRemovalModules(files);
  if (!/^chore\/dated-waiver-[a-f0-9]{24}$/u.test(branch)) {
    panic("Invalid removal branch");
  }
  if (repo !== "stella/stella") {
    panic("Dated-waiver publishing requires stella/stella");
  }
  const owner = repo.slice(0, repo.indexOf("/"));
  const api = `repos/${repo}`;
  const setRef = async (refBranch: string, sha: string): Promise<void> => {
    const refs = v.parse(
      REF_LIST,
      await request([`${api}/git/matching-refs/heads/${refBranch}`]),
    );
    const exists = refs.some(({ ref }) => ref === `refs/heads/${refBranch}`);
    await request(
      [
        exists ? `${api}/git/refs/heads/${refBranch}` : `${api}/git/refs`,
        "--method",
        exists ? "PATCH" : "POST",
        "--input",
        "-",
      ],
      exists ? { sha, force: true } : { ref: `refs/heads/${refBranch}`, sha },
    );
  };
  const github = {
    list: async (): Promise<RemovalPr[]> => {
      const result = await request([
        `${api}/pulls`,
        "--method",
        "GET",
        "-f",
        "state=open",
        "-f",
        "base=main",
        "-f",
        `head=${owner}:${branch}`,
        "-f",
        "per_page=100",
      ]);
      return v.parse(PR_LIST, result);
    },
    create: async (prBody: string): Promise<number> =>
      v.parse(
        CREATED_PR,
        await request([`${api}/pulls`, "--method", "POST", "--input", "-"], {
          head: branch,
          base: "main",
          title: REMOVAL_TITLE,
          body: prBody,
          draft: false,
        }),
      ).number,
    update: async (number: number, prBody: string): Promise<void> => {
      await request(
        [`${api}/pulls/${number}`, "--method", "PATCH", "--input", "-"],
        { title: REMOVAL_TITLE, body: prBody },
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
    Object.entries(files).every(
      ([file, content]) => baseFiles[file] === content,
    )
  ) {
    return undefined;
  }
  const remoteBase = v.parse(
    REF_HEAD,
    await request([`${api}/git/ref/heads/main`]),
  );
  if (remoteBase.object.sha !== baseSha) {
    throw new WaiverPublishError({
      message: "Main advanced; evidence must be recomputed.",
    });
  }
  if (existing) {
    const proposalHead = v.parse(
      REF_HEAD,
      await request([`${api}/git/ref/heads/${branch}`]),
    ).object.sha;
    const proposal = v.parse(
      COMMIT_PARENTS,
      await request([`${api}/git/commits/${proposalHead}`]),
    );
    // This workflow builds exactly one removal commit on its probed base.
    // Matching edited files alone cannot establish unchanged probe inputs.
    const sameBase =
      proposal.parents.length === 1 && proposal.parents.at(0)?.sha === baseSha;
    const sameFiles = sameBase
      ? await Promise.all(
          Object.entries(files).map(async ([file, content]) => {
            const response = v.parse(
              FILE_CONTENT,
              await request([
                `${api}/contents/${file}`,
                "--method",
                "GET",
                "-f",
                `ref=${proposalHead}`,
              ]),
            );
            return (
              Buffer.from(response.content, "base64").toString("utf-8") ===
              content
            );
          }),
        )
      : [];
    if (sameBase && sameFiles.every(Boolean)) {
      return reconcileRemovalPr({ body, github });
    }
  }
  // File contents were generated from this checkout, so the commit must share
  // its base even when main advances while documentation requests are running.
  const base = baseSha;
  const buildBranch = `${branch}-next`;
  await setRef(buildBranch, base);
  const commit = v.parse(
    SIGNED_COMMIT,
    await request(["graphql", "--input", "-"], {
      query:
        "mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repo, branchName: buildBranch },
          expectedHeadOid: base,
          message: { headline: REMOVAL_TITLE },
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
  if ("errors" in commit) {
    throw new WaiverPublishError({
      message: "GitHub signed commit failed; response withheld.",
    });
  }
  const sha = commit.data.createCommitOnBranch.commit.oid;
  await setRef(branch, sha);
  await request([`${api}/git/refs/heads/${buildBranch}`, "--method", "DELETE"]);
  return reconcileRemovalPr({ body, github });
};
