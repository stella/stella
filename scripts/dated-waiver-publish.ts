import { panic, Result, TaggedError } from "better-result";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { waiverKey } from "./dated-waiver-fix-task";
import type { DatedWaiver } from "./dated-waivers";

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

type WaiverPublishFailure = {
  file: string;
  stage: "parse";
  cause: unknown;
};
export class WaiverPublishFailures extends TaggedError(
  "WaiverPublishFailures",
)<{
  message: string;
  failures: WaiverPublishFailure[];
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
  const failures: WaiverPublishFailure[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (!MODULE_EXTENSIONS.has(path.extname(file))) {
      continue;
    }
    const parsed = Result.try(() => {
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
    });
    if (Result.isError(parsed)) {
      failures.push({ file, stage: "parse", cause: parsed.error });
    }
  }
  if (failures.length > 0) {
    throw new WaiverPublishFailures({
      message: `Generated module has syntax diagnostics: ${failures.map(({ file }) => file).join(", ")}`,
      failures,
    });
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
const REF_HEAD = v.object({ object: v.object({ sha: v.string() }) });
const COMMIT_TREE = v.object({ tree: v.object({ sha: v.string() }) });
const SIGNED_COMMIT = v.union([
  v.object({
    errors: v.pipe(v.array(v.object({ message: v.string() })), v.minLength(1)),
  }),
  v.object({
    data: v.object({
      createCommitOnBranch: v.object({
        commit: v.object({
          oid: v.string(),
          tree: v.object({ oid: v.string() }),
        }),
      }),
    }),
  }),
]);

type RemovalBranchOptions = {
  branch: string;
  repo: string | undefined;
  request: typeof githubRequest;
};
const REMOVAL_BRANCH = /^chore\/dated-waiver-([a-f0-9]{24})$/u;
const requireRemovalRepository = (repo: string | undefined) => {
  if (repo !== "stella/stella") {
    panic("Dated-waiver publishing requires stella/stella");
  }
  return repo;
};
const removalLocation = ({
  branch,
  repo,
}: Pick<RemovalBranchOptions, "branch" | "repo">) => {
  if (!REMOVAL_BRANCH.test(branch)) {
    panic("Invalid removal branch");
  }
  const repository = requireRemovalRepository(repo);
  return {
    api: `repos/${repository}`,
    owner: repository.slice(0, repository.indexOf("/")),
  };
};

export type RemovalProposal = { branch: string; key: string };
const proposalListSchema = v.array(
  v.object({
    head: v.object({
      ref: v.string(),
      repo: v.nullable(v.object({ full_name: v.string() })),
    }),
    base: v.object({ ref: v.string() }),
  }),
);
type ListRemovalProposalsOptions = Pick<
  RemovalBranchOptions,
  "repo" | "request"
>;
export const listRemovalProposals = async ({
  repo,
  request,
}: ListRemovalProposalsOptions): Promise<RemovalProposal[]> => {
  const repository = requireRemovalRepository(repo);
  const proposals = new Map<string, RemovalProposal>();
  for (let page = 1; ; page++) {
    const pulls = v.parse(
      proposalListSchema,
      await request([
        `repos/${repository}/pulls`,
        "--method",
        "GET",
        "-f",
        "state=open",
        "-f",
        "base=main",
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
      ]),
    );
    for (const pull of pulls) {
      if (
        pull.base.ref !== "main" ||
        pull.head.repo?.full_name !== repository
      ) {
        continue;
      }
      const key = REMOVAL_BRANCH.exec(pull.head.ref)?.at(1);
      if (key) {
        proposals.set(pull.head.ref, { branch: pull.head.ref, key });
      }
    }
    if (pulls.length < 100) {
      return [...proposals.values()];
    }
  }
};

export const orphanRemovalProposals = (
  inventory: readonly DatedWaiver[],
  proposals: readonly RemovalProposal[],
): RemovalProposal[] => {
  const current = new Set(inventory.map(waiverKey));
  return proposals.filter(({ key }) => !current.has(key));
};
const listRemovalPrs = async ({
  branch,
  repo,
  request,
}: RemovalBranchOptions): Promise<RemovalPr[]> => {
  const { api, owner } = removalLocation({ branch, repo });
  return v.parse(
    PR_LIST,
    await request([
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
    ]),
  );
};

type RetireRemovalOptions = RemovalBranchOptions & {
  disarm: (number: number) => Promise<void>;
};
export const retireRemoval = async ({
  branch,
  repo,
  request,
  disarm,
}: RetireRemovalOptions): Promise<void> => {
  const { api } = removalLocation({ branch, repo });
  const open = await listRemovalPrs({ branch, repo, request });
  if (open.length > 1) {
    panic(
      "Multiple open dated-waiver recheck PRs; reconcile the reserved branch.",
    );
  }
  const existing = open.at(0);
  if (!existing) {
    return;
  }
  // Closure follows a verified sanctioned disarm; a refusal leaves the proposal
  // visible for recovery rather than disguising an armed removal as retired.
  await disarm(existing.number);
  await request(
    [`${api}/pulls/${existing.number}`, "--method", "PATCH", "--input", "-"],
    {
      state: "closed",
      body: `${existing.body}\n\nThis dated maintenance proposal is superseded.`,
    },
  );
};

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
  const { api } = removalLocation({ branch, repo });
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
    list: async () => listRemovalPrs({ branch, repo, request }),
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
  const alreadyRemoved = Object.entries(files).every(
    ([file, content]) => baseFiles[file] === content,
  );
  if (alreadyRemoved && !existing) {
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
  if (alreadyRemoved && existing) {
    await request(
      [`${api}/pulls/${existing.number}`, "--method", "PATCH", "--input", "-"],
      {
        state: "closed",
        body: `${existing.body}\n\nThe dated maintenance entry is already removed on main.`,
      },
    );
    return undefined;
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
        "mutation ($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid tree { oid } } } }",
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
  const generated = commit.data.createCommitOnBranch.commit;
  await setRef(branch, generated.oid);
  const pushed = v.parse(
    REF_HEAD,
    await request([`${api}/git/ref/heads/${branch}`]),
  ).object.sha;
  const pushedCommit = v.parse(
    COMMIT_TREE,
    await request([`${api}/git/commits/${pushed}`]),
  );
  if (
    pushed !== generated.oid ||
    pushedCommit.tree.sha !== generated.tree.oid
  ) {
    throw new WaiverPublishError({
      message: "Published removal does not match the generated tree.",
    });
  }
  await request([`${api}/git/refs/heads/${buildBranch}`, "--method", "DELETE"]);
  return reconcileRemovalPr({ body, github });
};
