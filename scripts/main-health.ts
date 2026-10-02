#!/usr/bin/env bun
import { readFileSync, appendFileSync } from "node:fs";

export const MAIN_HEAVY = {
  context: "main/heavy",
  path: ".github/workflows/main-heavy.yml",
  workflow: "main-heavy.yml",
  name: "Main heavy suites",
  testedPrefix: "Main heavy suites ",
  publisher: "github-actions[bot]",
} as const;
export const MAIN_INCIDENT_LABEL = "main-health-incident";
const SHA = /^[0-9a-f]{40}$/u;
const INCIDENT = /<!-- main-health:([0-9a-f]{40}) -->/u;
const BISECT = /<!-- main-health-bisect:([0-9a-f]{40}) -->/u;
const MAX_HISTORY = 100;
const MAX_FILES = 100;
type Json = Record<string, unknown>;
export type MainHealthApi = {
  request: (route: string, args: Json) => Promise<{ data: unknown }>;
  graphql: (query: string, args: Json) => Promise<unknown>;
};
export type MainHealthContext = {
  eventName: string;
  repo: { owner: string; repo: string };
  payload: Json;
};
export type MainHealthOptions = {
  github: MainHealthApi;
  writer?: MainHealthApi;
  context: MainHealthContext;
  config: { autoRevert: string | undefined };
};
export class MainHealthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "MainHealthError";
  }
}
const fail = (code: string): never => {
  throw new MainHealthError(code);
};
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Json =>
  isObject(value) ? value : fail("INVALID_OBJECT");
const text = (value: unknown): string =>
  typeof value === "string" ? value : fail("INVALID_STRING");
const number = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fail("INVALID_NUMBER");
const sha = (value: unknown): string => {
  const result = text(value);
  return SHA.test(result) ? result : fail("INVALID_SHA");
};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : fail("INVALID_LIST");
const receipt = ({
  pullNumber,
  head,
  actor,
}: {
  pullNumber: number;
  head: string;
  actor: string;
}) => `<!-- main-health-revert:${pullNumber}:${head}:${actor} -->`;
const viewer = async (github: MainHealthApi) =>
  text(
    object(
      object(await github.graphql("query { viewer { login } }", {}))["viewer"],
    )["login"],
  );
const marker = (commit: string) => `<!-- main-health:${commit} -->`;
const repositoryTools = (
  github: MainHealthApi,
  repo: MainHealthContext["repo"],
) => {
  const repository = `${repo.owner}/${repo.repo}`;
  const api = async (route: string, args: Json = {}) =>
    (await github.request(route, { ...repo, ...args })).data;
  const list = async (route: string, args: Json = {}, field?: string) => {
    const result: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const response = await api(route, { ...args, per_page: 100, page });
      const items = array(field ? object(response)[field] : response);
      result.push(...items);
      if (items.length < 100) {
        return result;
      }
    }
    return fail("LIST_TOO_LARGE");
  };
  const main = async () =>
    sha(
      object(
        object(
          await api("GET /repos/{owner}/{repo}/git/ref/{ref}", {
            ref: "heads/main",
          }),
        )["object"],
      )["sha"],
    );
  const onMain = async (commit: string, head: string) => {
    const comparison = object(
      await api("GET /repos/{owner}/{repo}/compare/{basehead}", {
        basehead: `${commit}...${head}`,
      }),
    );
    if (sha(object(comparison["merge_base_commit"])["sha"]) !== commit) {
      return fail("NOT_ON_MAIN");
    }
  };
  const readRun = async (id: number) =>
    object(
      await api("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
        run_id: id,
      }),
    );
  const testedSha = (run: Json): string => {
    if (
      text(object(run["repository"])["full_name"]) !== repository ||
      run["path"] !== MAIN_HEAVY.path ||
      run["head_branch"] !== "main" ||
      !["push", "workflow_dispatch"].includes(text(run["event"]))
    ) {
      return fail("UNTRUSTED_HEAVY_RUN");
    }
    const title = text(run["display_title"]);
    if (!title.startsWith(MAIN_HEAVY.testedPrefix)) {
      return fail("MISSING_TESTED_SHA_BINDING");
    }
    const result = sha(title.slice(MAIN_HEAVY.testedPrefix.length));
    if (run["event"] === "push" && sha(run["head_sha"]) !== result) {
      return fail("HEAVY_SHA_MISMATCH");
    }
    return result;
  };
  const heavy = async (commit: string) => {
    const statuses = await list(
      "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
      { ref: commit },
    );
    const status = statuses
      .map(object)
      .find((entry) => entry["context"] === MAIN_HEAVY.context);
    if (!status) {
      return { state: "unknown" } as const;
    }
    if (object(status["creator"])["login"] !== MAIN_HEAVY.publisher) {
      return fail("UNTRUSTED_HEAVY_STATUS");
    }
    const prefix = `https://github.com/${repository}/actions/runs/`;
    const link = text(status["target_url"]);
    if (!link.startsWith(prefix) || !/^\d+$/u.test(link.slice(prefix.length))) {
      return fail("INVALID_HEAVY_RUN_LINK");
    }
    const run = await readRun(number(Number(link.slice(prefix.length))));
    if (testedSha(run) !== commit || run["html_url"] !== link) {
      return fail("HEAVY_SHA_MISMATCH");
    }
    await onMain(commit, await main());
    if (
      run["status"] !== "completed" ||
      status["state"] === "pending" ||
      ["skipped", "neutral"].includes(text(run["conclusion"]))
    ) {
      return { state: "unknown" } as const;
    }
    if (run["conclusion"] === "success" && status["state"] === "success") {
      return { state: "green", run } as const;
    }
    if (
      ["failure", "timed_out", "action_required"].includes(
        text(run["conclusion"]),
      ) &&
      status["state"] === "failure"
    ) {
      return { state: "red", run } as const;
    }
    return fail("HEAVY_RESULT_MISMATCH");
  };
  const incidents = async () =>
    (
      await list("GET /repos/{owner}/{repo}/issues", {
        state: "open",
        labels: MAIN_INCIDENT_LABEL,
      })
    ).map(object);
  const reverts = async (commit: string) => {
    const checks = (
      await list(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        { ref: commit, check_name: "main-health", filter: "all" },
        "check_runs",
      )
    ).map(object);
    const numbers = new Set<number>();
    for (const check of checks) {
      if (object(check["app"])["slug"] !== "github-actions") {
        continue;
      }
      const summary = text(object(check["output"])["summary"] ?? "");
      for (const match of summary.matchAll(
        /<!-- main-health-revert:(\d+):[0-9a-f]{40}:[^\s:<>]+ -->/gu,
      )) {
        numbers.add(number(Number(match.at(1))));
      }
    }
    const pulls: Json[] = [];
    for (const pullNumber of numbers) {
      pulls.push(
        object(
          await api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            pull_number: pullNumber,
          }),
        ),
      );
    }
    return pulls;
  };
  return {
    repository,
    api,
    list,
    reverts,
    main,
    onMain,
    readRun,
    testedSha,
    heavy,
    incidents,
  };
};

// The tag selector and detector share the same provenance boundary.
export const autoRevertEnabled = (value: unknown) => value === "on";

export const verifyReleaseHealth = async ({
  github,
  repo,
  commit,
}: {
  github: MainHealthApi;
  repo: MainHealthContext["repo"];
  commit: string;
}) => {
  const tools = repositoryTools(github, repo);
  await tools.onMain(sha(commit), await tools.main());
  if ((await tools.heavy(commit)).state !== "green") {
    return fail("RELEASE_HEAVY_NOT_GREEN");
  }
  if ((await tools.incidents()).length !== 0) {
    return fail("RELEASE_OPEN_MAIN_INCIDENT");
  }
};

type PatchPart = { context: string[] } | { removed: string[]; added: string[] };
const patchParts = (file: Json): PatchPart[][] => {
  const patch = text(file["patch"]);
  const hunks: PatchPart[][] = [];
  let parts: PatchPart[] | undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line)) {
      parts = [];
      hunks.push(parts);
      continue;
    }
    if (line === "\\ No newline at end of file") {
      const previous = parts?.at(-1);
      if (!previous) {
        return fail("INVALID_PATCH");
      }
      if ("context" in previous) {
        previous.context.push(line);
      } else if (previous.added.length) {
        previous.added.push(line);
      } else {
        previous.removed.push(line);
      }
      continue;
    }
    if (!parts || ![" ", "+", "-"].includes(line.slice(0, 1))) {
      return fail("INVALID_PATCH");
    }
    if (line.startsWith(" ")) {
      const previous = parts.at(-1);
      if (previous && "context" in previous) {
        previous.context.push(line.slice(1));
      } else {
        parts.push({ context: [line.slice(1)] });
      }
      continue;
    }
    let previous = parts.at(-1);
    if (!previous || "context" in previous) {
      previous = { removed: [], added: [] };
      parts.push(previous);
    }
    if (line.startsWith("+")) {
      additions++;
      previous.added.push(line.slice(1));
    } else {
      deletions++;
      previous.removed.push(line.slice(1));
    }
  }
  if (
    hunks.length === 0 ||
    additions !== file["additions"] ||
    deletions !== file["deletions"]
  ) {
    return fail("TRUNCATED_PATCH");
  }
  return hunks;
};
const changeIdentity = (file: Json, inverse: boolean) => {
  const filename = text(file["filename"]);
  const status = text(file["status"]);
  if (!["added", "removed", "modified", "renamed"].includes(status)) {
    return fail("UNSUPPORTED_FILE_STATUS");
  }
  const previous =
    status === "renamed" ? text(file["previous_filename"]) : filename;
  const parts = patchParts(file).map((hunk) =>
    hunk.map((part) => {
      if ("context" in part || !inverse) {
        return part;
      }
      return { removed: part.added, added: part.removed };
    }),
  );
  let mappedStatus = status;
  if (inverse && status === "added") {
    mappedStatus = "removed";
  }
  if (inverse && status === "removed") {
    mappedStatus = "added";
  }
  return {
    filename: inverse ? previous : filename,
    previous: inverse ? filename : previous,
    status: mappedStatus,
    parts,
  };
};
// Hunk coordinates may move with unrelated later edits; all content and paths must match.
export const verifyInverseDiff = (original: unknown[], reverted: unknown[]) => {
  if (
    original.length === 0 ||
    original.length >= MAX_FILES ||
    original.length !== reverted.length
  ) {
    return fail("REVERT_DIFF_MISMATCH");
  }
  const expected = original
    .map(object)
    .map((file) => changeIdentity(file, true))
    .toSorted((a, b) => a.filename.localeCompare(b.filename));
  const actual = reverted
    .map(object)
    .map((file) => changeIdentity(file, false))
    .toSorted((a, b) => a.filename.localeCompare(b.filename));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail("REVERT_DIFF_MISMATCH");
  }
};
const parent = (commit: Json) => {
  const parents = array(commit["parents"]);
  if (parents.length !== 1) {
    return fail("NON_LINEAR_HISTORY");
  }
  return sha(object(parents.at(0))["sha"]);
};
const protectedPath = (name: string) =>
  /(?:^|\/)(?:migrations?|drizzle)(?:\/|$)/iu.test(name) ||
  name.startsWith(".github/workflows/") ||
  /(?:^|\/)ruleset[^/]*\.json$/iu.test(name) ||
  name.includes("migration-alias-inventory");
export const verifyRevertCandidate = async ({
  github,
  repo,
  pull,
  culprit,
  expectedHead,
  actor,
  purpose = "arm",
}: {
  github: MainHealthApi;
  repo: MainHealthContext["repo"];
  pull: Json;
  culprit: string;
  expectedHead?: string;
  actor: string;
  purpose?: "arm" | "resolve";
}) => {
  const { api, list, main, onMain, incidents, repository } = repositoryTools(
    github,
    repo,
  );
  const commitData = async (commit: string) =>
    object(
      await api("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        commit_sha: commit,
      }),
    );
  const comparisonFiles = async (base: string, head: string) =>
    array(
      object(
        await api("GET /repos/{owner}/{repo}/compare/{basehead}", {
          basehead: `${base}...${head}`,
        }),
      )["files"],
    );
  const head = sha(object(pull["head"])["sha"]);
  if (
    (purpose === "arm"
      ? pull["state"] !== "open" || pull["draft"] !== false
      : pull["state"] !== "closed" || pull["merged"] !== true) ||
    object(pull["base"])["ref"] !== "main" ||
    object(object(pull["head"])["repo"])["full_name"] !== repository ||
    object(object(pull["base"])["repo"])["full_name"] !== repository ||
    !text(pull["body"]).includes(marker(culprit))
  ) {
    return fail("UNTRUSTED_REVERT_PULL");
  }
  if (expectedHead !== undefined && head !== sha(expectedHead)) {
    return fail("REVERT_HEAD_CHANGED");
  }
  if (object(pull["user"])["login"] !== actor) {
    return fail("UNTRUSTED_REVERT_AUTHOR");
  }
  const proof = receipt({ pullNumber: number(pull["number"]), head, actor });
  const recorded = (
    await list(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      { ref: culprit, check_name: "main-health", filter: "all" },
      "check_runs",
    )
  ).map(object);
  if (
    !recorded.some(
      (check) =>
        object(check["app"])["slug"] === "github-actions" &&
        text(object(check["output"])["summary"] ?? "").includes(proof),
    )
  ) {
    return fail("UNTRUSTED_REVERT_RECEIPT");
  }
  const reverted = await commitData(head);
  if (object(reverted["verification"])["verified"] !== true) {
    return fail("UNSIGNED_REVERT");
  }
  const base = parent(reverted);
  await onMain(base, await main());
  if (
    purpose === "arm" &&
    (await incidents()).some(
      (issue) => !text(issue["body"] ?? "").includes(marker(culprit)),
    )
  ) {
    return fail("ANOTHER_INCIDENT_OPEN");
  }
  const associated = (
    await list("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
      commit_sha: culprit,
    })
  )
    .map(object)
    .filter(
      (candidate) =>
        candidate["merge_commit_sha"] === culprit &&
        candidate["merged_at"] !== null,
    );
  if (associated.length !== 1) {
    return fail("CULPRIT_PULL_UNKNOWN");
  }
  const original = object(
    await api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      pull_number: number(associated.at(0)?.["number"]),
    }),
  );
  if (
    original["merged"] !== true ||
    original["merge_commit_sha"] !== culprit ||
    object(original["base"])["ref"] !== "main" ||
    object(object(original["base"])["repo"])["full_name"] !== repository
  ) {
    return fail("CULPRIT_PULL_MISMATCH");
  }
  const files = await comparisonFiles(
    parent(await commitData(culprit)),
    culprit,
  );
  if (original["changed_files"] !== files.length) {
    return fail("INCOMPLETE_CULPRIT_DIFF");
  }
  if (
    files
      .map(object)
      .some(
        (file) =>
          protectedPath(text(file["filename"])) ||
          (file["previous_filename"] !== undefined &&
            protectedPath(text(file["previous_filename"]))),
      )
  ) {
    return fail("PROTECTED_PATH");
  }
  if (
    /^chore(?:\([^)]*\))?:\s*release\b/iu.test(text(original["title"])) ||
    array(original["labels"]).some(
      (label) => object(label)["name"] === "release",
    ) ||
    (await list("GET /repos/{owner}/{repo}/tags")).some(
      (tag) => object(object(tag)["commit"])["sha"] === culprit,
    )
  ) {
    return fail("RELEASE_OR_TAGGED_COMMIT");
  }
  const inverse = await comparisonFiles(base, head);
  if (pull["changed_files"] !== inverse.length) {
    return fail("INCOMPLETE_REVERT_DIFF");
  }
  verifyInverseDiff(files, inverse);
  if (purpose === "resolve") {
    const landed = sha(pull["merge_commit_sha"]);
    await onMain(landed, await main());
    verifyInverseDiff(
      files,
      await comparisonFiles(parent(await commitData(landed)), landed),
    );
  }
  return { pullNumber: number(pull["number"]), head };
};

const healthReporter = ({
  api,
  list,
  incidents,
}: ReturnType<typeof repositoryTools>) => {
  const report = async (
    commit: string,
    title: string,
    reason: string,
    queue?: { pullNumber: number; head: string },
  ) => {
    await api("POST /repos/{owner}/{repo}/check-runs", {
      name: "main-health",
      head_sha: commit,
      status: "completed",
      conclusion: title === "MAIN_GREEN" ? "success" : "failure",
      output: { title, summary: `${marker(commit)}\n${reason}` },
    });
    return { sha: commit, title, reason, queue };
  };
  const ensureLabel = async () => {
    const labels = (await list("GET /repos/{owner}/{repo}/labels")).map(object);
    if (!labels.some((label) => label["name"] === MAIN_INCIDENT_LABEL)) {
      await api("POST /repos/{owner}/{repo}/labels", {
        name: MAIN_INCIDENT_LABEL,
        color: "b60205",
        description: "Open main health incident",
      });
    }
  };
  const ensureIncident = async (commit: string, reason: string) => {
    if ((await incidents()).length === 0) {
      await ensureLabel();
      await api("POST /repos/{owner}/{repo}/issues", {
        title: "Main health requires attention",
        labels: [MAIN_INCIDENT_LABEL],
        body: `${marker(commit)}\nMain health verification requires attention.\nReason: ${reason}\nCommit: ${commit}`,
      });
    }
  };
  const escalate = async (commit: string, reason: string) => {
    await ensureIncident(commit, reason);
    return report(commit, "MAIN_RED_ESCALATED", reason);
  };
  return { report, ensureLabel, ensureIncident, escalate };
};

const recoveryTools = (options: MainHealthOptions) => {
  const { github, writer, context } = options;
  const tools = repositoryTools(github, context.repo);
  const { api, list, repository } = tools;
  const commitData = async (commit: string) =>
    object(
      await api("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        commit_sha: commit,
      }),
    );
  const comparisonFiles = async (base: string, head: string) =>
    array(
      object(
        await api("GET /repos/{owner}/{repo}/compare/{basehead}", {
          basehead: `${base}...${head}`,
        }),
      )["files"],
    );
  const originalPull = async (commit: string) => {
    const pulls = (
      await list("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
        commit_sha: commit,
      })
    )
      .map(object)
      .filter(
        (pull) =>
          pull["merge_commit_sha"] === commit && pull["merged_at"] !== null,
      );
    if (pulls.length !== 1) {
      return fail("CULPRIT_PULL_UNKNOWN");
    }
    const result = object(
      await api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        pull_number: number(pulls.at(0)?.["number"]),
      }),
    );
    if (
      result["merged"] !== true ||
      result["merge_commit_sha"] !== commit ||
      object(result["base"])["ref"] !== "main" ||
      object(object(result["base"])["repo"])["full_name"] !== repository
    ) {
      return fail("CULPRIT_PULL_MISMATCH");
    }
    return result;
  };
  const revertingActor = async () =>
    writer ? viewer(writer) : fail("WRITE_DISABLED");
  const verifyRevert = async (pull: Json, culprit: string) =>
    verifyRevertCandidate({
      github,
      repo: context.repo,
      pull,
      culprit,
      actor: await revertingActor(),
    });
  return {
    ...options,
    ...tools,
    ...healthReporter(tools),
    commitData,
    comparisonFiles,
    originalPull,
    revertingActor,
    verifyRevert,
  };
};
type RecoveryTools = ReturnType<typeof recoveryTools>;
type HealthOutcome = Awaited<
  ReturnType<ReturnType<typeof healthReporter>["report"]>
>;
type WakeResult =
  | { type: "target"; target: string; root?: string }
  | {
      type: "complete";
      result: HealthOutcome | { title: "IGNORED"; reason: string };
    };

const publishRevert = async ({
  tools,
  target,
  rootCommit,
  run,
  original,
  files,
  title,
  actor,
}: {
  tools: RecoveryTools;
  target: string;
  rootCommit: string;
  run: Json;
  original: Json;
  files: unknown[];
  title: string;
  actor: string;
}) => {
  const { api, list, writer, ensureLabel, report, incidents, verifyRevert } =
    tools;
  // Validate diff completeness before minting any branch or pull request.
  for (const file of files) {
    changeIdentity(object(file), true);
  }
  if (!writer) {
    return fail("WRITE_DISABLED");
  }
  await ensureLabel();
  const jobs = (
    await list(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
      { run_id: number(run["id"]) },
      "jobs",
    )
  )
    .map(object)
    .filter((job) => job["conclusion"] === "failure")
    .map((job) => text(job["name"]).replace(/[\r\n]/gu, " "));
  const body = `${marker(target)}\n<!-- main-health-origin:${rootCommit} -->\nHeavy suites failed: ${jobs.join(", ") || MAIN_HEAVY.name}.\nWorkflow run: ${text(run["html_url"])}\nReverts #${number(original["number"])}.`;
  const result = object(
    await writer.graphql(
      `mutation($input:RevertPullRequestInput!) { revertPullRequest(input:$input) { revertPullRequest { number headRefOid author { login } } } }`,
      {
        input: {
          pullRequestId: text(original["node_id"]),
          title: `revert: ${title.replace(/[\r\n]/gu, " ")} (#${number(original["number"])})`,
          body,
        },
      },
    ),
  );
  const created = object(
    object(result["revertPullRequest"])["revertPullRequest"],
  );
  const newNumber = number(created["number"]);
  const createdHead = sha(created["headRefOid"]);
  if (object(created["author"])["login"] !== actor) {
    return fail("UNTRUSTED_REVERT_AUTHOR");
  }
  await report(
    target,
    "MAIN_RED_REVERT_OPENED",
    receipt({ pullNumber: newNumber, head: createdHead, actor }),
  );
  // Label before closing the issue so a concurrent release always sees an incident.
  await api("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    issue_number: newNumber,
    labels: [MAIN_INCIDENT_LABEL],
  });
  for (const issue of await incidents()) {
    if (
      issue["pull_request"] === undefined &&
      text(issue["body"] ?? "").includes(marker(rootCommit))
    ) {
      await api("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        issue_number: number(issue["number"]),
        state: "closed",
      });
    }
  }
  const pull = object(
    await api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      pull_number: newNumber,
    }),
  );
  if (sha(object(pull["head"])["sha"]) !== createdHead) {
    return fail("REVERT_HEAD_CHANGED");
  }
  return report(
    target,
    "MAIN_RED_REVERT_OPENED",
    "Revert proposed; merge bar must evaluate live gates.",
    await verifyRevert(pull, target),
  );
};

const proposeRevert = async ({
  tools,
  target,
  rootCommit,
  predecessor,
  run,
}: {
  tools: RecoveryTools;
  target: string;
  rootCommit: string;
  predecessor: string;
  run: Json;
}) => {
  const {
    config,
    list,
    api,
    originalPull,
    comparisonFiles,
    escalate,
    revertingActor,
    report,
    verifyRevert,
  } = tools;
  const original = await originalPull(target);
  const files = await comparisonFiles(predecessor, target);
  if (
    original["changed_files"] !== files.length ||
    files.length === 0 ||
    files.length >= MAX_FILES
  ) {
    return escalate(target, "UNSUPPORTED_CHANGE_SIZE");
  }
  if (
    files
      .map(object)
      .some(
        (file) =>
          protectedPath(text(file["filename"])) ||
          (file["previous_filename"] !== undefined &&
            protectedPath(text(file["previous_filename"]))),
      )
  ) {
    return escalate(target, "PROTECTED_PATH");
  }
  const title = text(original["title"]);
  if (
    /^chore(?:\([^)]*\))?:\s*release\b/iu.test(title) ||
    array(original["labels"]).some(
      (label) => object(label)["name"] === "release",
    ) ||
    (await list("GET /repos/{owner}/{repo}/tags")).some(
      (tag) => object(object(tag)["commit"])["sha"] === target,
    )
  ) {
    return escalate(target, "RELEASE_OR_TAGGED_COMMIT");
  }
  if (!autoRevertEnabled(config.autoRevert)) {
    return escalate(target, "AUTO_REVERT_OFF");
  }
  const actor = await revertingActor();
  const known = await tools.reverts(target);
  const openPulls = (
    await list("GET /repos/{owner}/{repo}/pulls", {
      state: "open",
      base: "main",
    })
  ).map(object);
  const existing = [
    ...new Map(
      [...known, ...openPulls]
        .filter(
          (pull) =>
            object(pull["user"])["login"] === actor &&
            text(pull["body"] ?? "").includes(marker(target)),
        )
        .map((pull) => [number(pull["number"]), pull]),
    ).values(),
  ];
  if (existing.length > 1) {
    return escalate(target, "REVERT_PULL_AMBIGUOUS");
  }
  if (existing.length === 1) {
    const previous = object(
      await api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        pull_number: number(existing.at(0)?.["number"]),
      }),
    );
    if (previous["state"] !== "open") {
      return escalate(target, "REVERT_ALREADY_CLOSED");
    }
    return report(
      target,
      "MAIN_RED_REVERT_OPENED",
      "Existing revert retained.",
      await verifyRevert(previous, target),
    );
  }
  return publishRevert({
    tools,
    target,
    rootCommit,
    run,
    original,
    files,
    title,
    actor,
  });
};

const bisectHistory = async ({
  tools,
  target,
  rootCommit,
  predecessor,
}: {
  tools: RecoveryTools;
  target: string;
  rootCommit: string;
  predecessor: string;
}) => {
  const {
    heavy,
    commitData,
    config,
    escalate,
    ensureIncident,
    list,
    report,
    api,
  } = tools;
  let oldest = predecessor;
  for (let count = 0; count < MAX_HISTORY; count++) {
    const earlier = parent(await commitData(oldest));
    const earlierState = await heavy(earlier);
    if (earlierState.state === "red") {
      return escalate(target, "EARLIER_RED_INCIDENT");
    }
    if (earlierState.state === "green") {
      if (!autoRevertEnabled(config.autoRevert)) {
        return escalate(target, "AUTO_REVERT_OFF");
      }
      await ensureIncident(rootCommit, "MAIN_RED_BISECTING");
      const checks = (
        await list(
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          { ref: oldest, check_name: "main-health", filter: "all" },
          "check_runs",
        )
      ).map(object);
      const bisectMarker = `<!-- main-health-bisect:${rootCommit} -->`;
      if (
        !checks.some(
          (check) =>
            object(check["app"])["slug"] === "github-actions" &&
            text(object(check["output"])["summary"] ?? "").includes(
              bisectMarker,
            ),
        )
      ) {
        await report(
          oldest,
          "MAIN_RED_BISECTING",
          `${bisectMarker}\nRe-evaluate ${oldest}; incident ${target}.`,
        );
        await api(
          "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
          {
            workflow_id: MAIN_HEAVY.workflow,
            ref: "main",
            inputs: { sha: oldest },
          },
        );
      }
      return report(target, "MAIN_RED_BISECTING", `Waiting for ${oldest}.`);
    }
    oldest = earlier;
  }
  return escalate(target, "NO_GREEN_WITHIN_HISTORY_LIMIT");
};

const bisectRoot = async (tools: RecoveryTools, commit: string) => {
  const checks = (
    await tools.list(
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      { ref: commit, check_name: "main-health", filter: "all" },
      "check_runs",
    )
  ).map(object);
  const roots = new Set(
    checks
      .filter((check) => object(check["app"])["slug"] === "github-actions")
      .map((check) =>
        text(object(check["output"])["summary"] ?? "")
          .match(BISECT)
          ?.at(1),
      )
      .filter((root) => root !== undefined),
  );
  if (roots.size > 1) {
    return fail("AMBIGUOUS_BISECT");
  }
  const root = roots.values().next().value;
  if (!root) {
    return undefined;
  }
  await tools.onMain(sha(root), await tools.main());
  return root;
};

const evaluateCiWake = async (tools: RecoveryTools, run: Json) => {
  const {
    context,
    config,
    repository,
    list,
    api,
    onMain,
    main,
    report,
    revertingActor,
    escalate,
    incidents,
    verifyRevert,
  } = tools;
  if (
    object(run["repository"])["full_name"] !== repository ||
    run["event"] !== "pull_request" ||
    object(run["head_repository"])["full_name"] !== repository
  ) {
    return { title: "IGNORED", reason: "UNTRUSTED_CI_RUN" } as const;
  }
  const pulls = (
    await list("GET /repos/{owner}/{repo}/pulls", {
      state: "open",
      head: `${context.repo.owner}:${text(run["head_branch"])}`,
      base: "main",
    })
  )
    .map(object)
    .filter((pull) => INCIDENT.test(text(pull["body"] ?? "")));
  if (pulls.length !== 1) {
    return { title: "IGNORED", reason: "UNRELATED_CI_RUN" } as const;
  }
  const pull = object(
    await api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      pull_number: number(pulls.at(0)?.["number"]),
    }),
  );
  const target = sha(text(pull["body"]).match(INCIDENT)?.at(1));
  await onMain(target, await main());
  if (sha(object(pull["head"])["sha"]) !== sha(run["head_sha"])) {
    return { title: "IGNORED", reason: "STALE_CI_RUN" } as const;
  }
  if (!autoRevertEnabled(config.autoRevert)) {
    return report(target, "MAIN_RED_REVERT_OPENED", "AUTO_REVERT_OFF");
  }
  if (object(pull["user"])["login"] !== (await revertingActor())) {
    return { title: "IGNORED", reason: "UNTRUSTED_REVERT_AUTHOR" } as const;
  }
  if (
    (await incidents()).some(
      (issue) => !text(issue["body"] ?? "").includes(marker(target)),
    )
  ) {
    return escalate(target, "ANOTHER_INCIDENT_OPEN");
  }
  return report(
    target,
    "MAIN_RED_REVERT_OPENED",
    "Revert diff verified; merge bar must evaluate live gates.",
    await verifyRevert(pull, target),
  );
};

const wakeTarget = async (tools: RecoveryTools): Promise<WakeResult> => {
  const { context, readRun, testedSha, onMain, main, heavy, report } = tools;
  if (context.eventName === "workflow_dispatch") {
    const target = sha(object(context.payload["inputs"])["sha"]);
    await onMain(target, await main());
    return { type: "target", target };
  }
  if (context.eventName !== "workflow_run") {
    return {
      type: "complete",
      result: { title: "IGNORED", reason: "UNSUPPORTED_EVENT" },
    };
  }
  const run = await readRun(
    number(object(context.payload["workflow_run"])["id"]),
  );
  if (run["status"] !== "completed") {
    return {
      type: "complete",
      result: { title: "IGNORED", reason: "INCOMPLETE_RUN" },
    };
  }
  if (run["path"] === ".github/workflows/ci.yml") {
    return { type: "complete", result: await evaluateCiWake(tools, run) };
  }
  const candidate = testedSha(run);
  await onMain(candidate, await main());
  const advertised = await heavy(candidate);
  if (advertised.state === "unknown" || advertised.run["id"] !== run["id"]) {
    return fail("HEAVY_EVENT_STATUS_MISMATCH");
  }
  const root = await bisectRoot(tools, candidate);
  if (root && advertised.state === "green") {
    await report(candidate, "MAIN_GREEN", "Heavy re-evaluation succeeded.");
    return { type: "target", target: root, root };
  }
  return { type: "target", target: candidate, ...(root ? { root } : {}) };
};

const recoverCommit = async ({
  tools,
  target,
  root,
}: {
  tools: RecoveryTools;
  target: string;
  root?: string;
}) => {
  const { heavy, report, escalate, incidents, commitData } = tools;
  const rootCommit = root ?? (await bisectRoot(tools, target)) ?? target;
  const state = await heavy(target);
  if (state.state === "green") {
    return report(
      target,
      "MAIN_GREEN",
      "Heavy suites succeeded on this commit.",
    );
  }
  if (state.state !== "red") {
    return escalate(target, "HEAVY_NOT_COMPLETE");
  }
  const open = await incidents();
  if (open.length > 1) {
    return escalate(target, "MULTIPLE_INCIDENTS");
  }
  if (
    open.some(
      (issue) =>
        !text(issue["body"] ?? "").includes(marker(target)) &&
        !text(issue["body"] ?? "").includes(marker(rootCommit)),
    )
  ) {
    return escalate(target, "ANOTHER_INCIDENT_OPEN");
  }
  const predecessor = parent(await commitData(target));
  const predecessorState = await heavy(predecessor);
  if (predecessorState.state === "red") {
    return escalate(target, "SAME_INCIDENT_AS_RED_PARENT");
  }
  if (predecessorState.state !== "green") {
    return bisectHistory({ tools, target, rootCommit, predecessor });
  }
  return proposeRevert({
    tools,
    target,
    rootCommit,
    predecessor,
    run: state.run,
  });
};

export const runMainHealth = async (options: MainHealthOptions) => {
  const tools = recoveryTools(options);
  let target: string | undefined;
  try {
    const wake = await wakeTarget(tools);
    if (wake.type === "complete") {
      return wake.result;
    }
    target = wake.target;
    return await recoverCommit({ tools, target, root: wake.root });
  } catch (error) {
    const reason =
      error instanceof MainHealthError ? error.code : "GITHUB_API_ERROR";
    if (target) {
      return tools.escalate(target, reason);
    }
    return { title: "IGNORED", reason };
  }
};

// Events are wake-ups. The bounded main history is the durable work queue.
export const reconcileMainHealth = async (options: MainHealthOptions) => {
  if (
    !["workflow_run", "workflow_dispatch", "schedule"].includes(
      options.context.eventName,
    )
  ) {
    return { title: "IGNORED", reason: "UNSUPPORTED_EVENT" };
  }
  if (options.context.eventName === "workflow_run") {
    const run = object(options.context.payload["workflow_run"]);
    if (
      run["path"] === MAIN_HEAVY.path &&
      ["skipped", "neutral"].includes(text(run["conclusion"] ?? ""))
    ) {
      return { title: "IGNORED", reason: "NO_HEAVY_KNOWLEDGE" };
    }
  }
  const tools = repositoryTools(options.github, options.context.repo);
  const head = await tools.main();
  const reporter = healthReporter(tools);
  try {
    if (options.context.eventName === "workflow_dispatch") {
      await tools.onMain(
        sha(object(options.context.payload["inputs"])["sha"]),
        head,
      );
    }
    const commits = array(
      await tools.api("GET /repos/{owner}/{repo}/commits", {
        sha: head,
        per_page: MAX_HISTORY,
        page: 1,
      }),
    ).map(object);
    if (
      commits.length === 0 ||
      commits.length > MAX_HISTORY ||
      sha(commits.at(0)?.["sha"]) !== head
    ) {
      return fail("INVALID_MAIN_HISTORY");
    }
    for (let index = 0; index < commits.length - 1; index++) {
      if (
        parent(object(commits.at(index))) !==
        sha(commits.at(index + 1)?.["sha"])
      ) {
        return fail("NON_LINEAR_MAIN_HISTORY");
      }
    }
    const open = await tools.incidents();
    if (open.length > 1) {
      return reporter.escalate(head, "MULTIPLE_INCIDENTS");
    }
    let resolvedRedParent = false;
    for (const commit of commits.toReversed()) {
      const candidate = sha(commit["sha"]);
      if ((await tools.heavy(candidate)).state !== "red") {
        resolvedRedParent = false;
        continue;
      }
      if (resolvedRedParent) {
        continue;
      }
      const merged = (await tools.reverts(candidate)).filter(
        (pull) =>
          pull["state"] === "closed" &&
          pull["merged_at"] !== null &&
          text(pull["body"] ?? "").includes(marker(candidate)),
      );
      let resolved = false;
      for (const previous of merged) {
        const pull = object(
          await tools.api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            pull_number: number(previous["number"]),
          }),
        );
        const actor = text(object(pull["user"])["login"]);
        // Only a trusted mutation receipt can resolve a historical incident, even while disabled.
        const checks = (
          await tools.list(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            { ref: candidate, check_name: "main-health", filter: "all" },
            "check_runs",
          )
        ).map(object);
        const proof = receipt({
          pullNumber: number(pull["number"]),
          head: sha(object(pull["head"])["sha"]),
          actor,
        });
        if (
          !checks.some(
            (check) =>
              object(check["app"])["slug"] === "github-actions" &&
              text(object(check["output"])["summary"] ?? "").includes(proof),
          )
        ) {
          continue;
        }
        await verifyRevertCandidate({
          github: options.github,
          repo: options.context.repo,
          pull,
          culprit: candidate,
          actor,
          purpose: "resolve",
        });
        resolved = true;
        break;
      }
      if (resolved) {
        resolvedRedParent = true;
        continue;
      }
      // The oldest unresolved red owns this round; a later red cannot starve it.
      return runMainHealth({
        ...options,
        context: {
          repo: options.context.repo,
          eventName: "workflow_dispatch",
          payload: { inputs: { sha: candidate } },
        },
      });
    }
    if (open.length !== 0) {
      return reporter.escalate(head, "OPEN_INCIDENT_REQUIRES_ATTENTION");
    }
    const current = await tools.heavy(head);
    if (current.state === "green") {
      return reporter.report(
        head,
        "MAIN_GREEN",
        "Bounded main history reconciled; no unresolved red remains.",
      );
    }
    return { title: "IGNORED", reason: "NO_HEAVY_KNOWLEDGE" };
  } catch (error) {
    return reporter.escalate(
      head,
      error instanceof MainHealthError ? error.code : "GITHUB_API_ERROR",
    );
  }
};

// No SDK or workspace imports: this executes before any dependency install.
export const createMainHealthApi = (
  token: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): MainHealthApi => {
  const send = async (path: string, method: string, body?: Json) => {
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) {
      return fail(`GITHUB_HTTP_${response.status}`);
    }
    if (response.status === 204) {
      return {};
    }
    return response.json();
  };
  return {
    request: async (route, args) => {
      const [method, template] = route.split(" ");
      if (!method || !template) {
        return fail("INVALID_API_ROUTE");
      }
      const params = new Map(Object.entries(args));
      const path = template.replace(/\{([^}]+)\}/gu, (_, key: string) => {
        const value = params.get(key);
        params.delete(key);
        return encodeURIComponent(
          String(value ?? fail("MISSING_API_PARAMETER")),
        );
      });
      if (method === "GET") {
        const query = new URLSearchParams(
          [...params].map(([key, value]) => [key, String(value)]),
        );
        return { data: await send(`${path}?${query}`, method) };
      }
      return { data: await send(path, method, Object.fromEntries(params)) };
    },
    graphql: async (query, variables) => {
      const response = object(
        await send("/graphql", "POST", { query, variables }),
      );
      if (response["errors"] !== undefined) {
        return fail("GITHUB_GRAPHQL_ERROR");
      }
      return object(response["data"]);
    },
  };
};
if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    const repoArgument = args.indexOf("--repo");
    const fullName =
      repoArgument === -1
        ? process.env["GITHUB_REPOSITORY"]
        : args.at(repoArgument + 1);
    if (!fullName || !/^[\w.-]+\/[\w.-]+$/u.test(fullName)) {
      fail("INVALID_REPOSITORY");
    }
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
      fail("INVALID_REPOSITORY");
    }
    const token =
      process.env["GH_TOKEN"] ??
      process.env["GITHUB_TOKEN"] ??
      fail("MISSING_READ_TOKEN");
    const github = createMainHealthApi(token);
    if (args.at(0) === "--release-guard") {
      await verifyReleaseHealth({
        github,
        repo: { owner, repo },
        commit: sha(args.at(1)),
      });
    } else if (args.at(0) === "--verify-revert") {
      const tools = repositoryTools(github, { owner, repo });
      const writer = createMainHealthApi(
        process.env["MAIN_HEALTH_WRITE_TOKEN"] ?? fail("MISSING_WRITE_TOKEN"),
      );
      if (!autoRevertEnabled(process.env["MAIN_AUTO_REVERT"])) {
        fail("AUTO_REVERT_OFF");
      }
      const pull = object(
        await tools.api("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          pull_number: number(Number(args.at(1))),
        }),
      );
      const culprit = sha(text(pull["body"]).match(INCIDENT)?.at(1));
      if (
        (await tools.heavy(culprit)).state !== "red" ||
        (
          await tools.heavy(
            parent(
              object(
                await tools.api(
                  "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
                  { commit_sha: culprit },
                ),
              ),
            ),
          )
        ).state !== "green"
      ) {
        fail("REVERT_NO_LONGER_REQUIRED");
      }
      await verifyRevertCandidate({
        github,
        repo: { owner, repo },
        pull,
        culprit,
        expectedHead: sha(args.at(2)),
        actor: await viewer(writer),
      });
    } else {
      const autoRevert = process.env["MAIN_AUTO_REVERT"];
      const writerToken = process.env["MAIN_HEALTH_WRITE_TOKEN"];
      const result = await reconcileMainHealth({
        github,
        ...(autoRevertEnabled(autoRevert) && writerToken
          ? { writer: createMainHealthApi(writerToken) }
          : {}),
        context: {
          eventName: process.env["GITHUB_EVENT_NAME"] ?? "",
          repo: { owner, repo },
          payload: object(
            JSON.parse(
              readFileSync(
                process.env["GITHUB_EVENT_PATH"] ?? fail("MISSING_EVENT_PATH"),
                "utf-8",
              ),
            ),
          ),
        },
        config: { autoRevert },
      });
      console.log(JSON.stringify(result));
      const output = process.env["GITHUB_OUTPUT"];
      if (output && "queue" in result && result.queue) {
        appendFileSync(
          output,
          `pull_number=${result.queue.pullNumber}\nhead=${result.queue.head}\n`,
        );
      }
    }
  } catch (error) {
    console.error(
      error instanceof MainHealthError ? error.code : "MAIN_HEALTH_ERROR",
    );
    process.exitCode = 1;
  }
}
