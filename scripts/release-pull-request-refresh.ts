#!/usr/bin/env bun

// Keeps an open release pull request consuming every `@stll/cli` changeset.
//
// A release pull request versions the changesets pending at its cut. A
// `@stll/cli` entry that reaches main afterwards stays pending in main plus
// the release, and the tag refuses that shape (check-cli-release-coupling.ts):
// a server contract change must not deploy without its CLI version. So when
// such an entry lands while a release is open, the release branch takes main
// and versions it. The Version packages workflow runs two steps from here:
//
//   plan    which release, and whether main added a `@stll/cli` entry since
//           the release branched from it or one still pends on the release
//           head after an unfinished refresh (read-only)
//   update  merge main into the release branch through GitHub, guarded by
//           its head, so the merge commit is signed
//
// The versioning itself is `prepare-maintenance-release.ts --refresh`, and its
// files are committed by the shared signed-commit action. Runs without
// `bun install`, so it uses only Bun and Node built-ins.

import { appendFileSync } from "node:fs";
import path from "node:path";

// Relative: CI runs this before the dependency install.
import { changesetNamesCli } from "./check-cli-release-coupling";

const ROOT = path.resolve(import.meta.dir, "..");
const CHANGESET_DIRECTORY = ".changeset";
const CHANGESET_README = "README.md";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const BRANCH_POLL_ATTEMPTS = 30;
const BRANCH_POLL_INTERVAL_MS = 4000;

export class ReleaseRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRefreshError";
  }
}

/** `gh api` arguments, plus an optional JSON body; resolves the parsed reply. */
export type GitHubRequest = (
  args: readonly string[],
  input?: unknown,
) => Promise<unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string, what: string): unknown => {
  if (!isRecord(value) || !(key in value)) {
    throw new ReleaseRefreshError(`GitHub ${what} has no ${key}`);
  }
  return value[key];
};

const fullSha = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new ReleaseRefreshError(`GitHub ${what} is not a full commit SHA`);
  }
  return value;
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new ReleaseRefreshError(`GitHub ${what} is not a non-empty string`);
  }
  return value;
};

export const ghRetryRequest: GitHubRequest = async (args, input) => {
  const proc = Bun.spawn(
    ["bash", path.join(ROOT, "scripts/gh-retry.sh"), "api", ...args],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "inherit",
      stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
    },
  );
  const [stdout, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new ReleaseRefreshError(
      `GitHub request ${String(args.at(0))} failed with exit code ${String(exit)}`,
    );
  }
  return stdout.trim() === "" ? null : JSON.parse(stdout);
};

const changesetNames = async (
  request: GitHubRequest,
  repo: string,
  ref: string,
): Promise<Set<string>> => {
  const listing = await request([
    `repos/${repo}/contents/${CHANGESET_DIRECTORY}?ref=${ref}`,
  ]);
  if (!Array.isArray(listing)) {
    throw new ReleaseRefreshError(
      `GitHub ${CHANGESET_DIRECTORY} listing at ${ref} is not a directory`,
    );
  }
  return new Set(
    listing
      .map((entry) => text(field(entry, "name", "changeset entry"), "name"))
      .filter((name) => name.endsWith(".md") && name !== CHANGESET_README),
  );
};

const cliEntries = async (
  request: GitHubRequest,
  repo: string,
  ref: string,
  names: Iterable<string>,
): Promise<string[]> => {
  const cli: string[] = [];
  for (const name of [...names].toSorted()) {
    const entry = await request([
      `repos/${repo}/contents/${CHANGESET_DIRECTORY}/${name}?ref=${ref}`,
    ]);
    const content = text(field(entry, "content", "changeset"), "content");
    if (changesetNamesCli(Buffer.from(content, "base64").toString("utf-8"))) {
      cli.push(name);
    }
  }
  return cli;
};

export type RefreshPlan =
  | { refresh: false; reason: string }
  | {
      refresh: true;
      number: number;
      branch: string;
      head: string;
      /** Main added a `@stll/cli` entry the release branch does not hold yet. */
      merge: boolean;
      changesets: readonly string[];
    };

/**
 * Decides from repository state, not from the push that ran it. The release
 * needs main when main holds a `@stll/cli` entry the release branch point did
 * not, and needs versioning while its own head still holds a pending
 * `@stll/cli` entry: the cut consumed everything pending, so such an entry is
 * a refresh whose merge landed and whose versioning did not, which the next run
 * resumes. Once both are done a run finds nothing to do.
 */
export const planReleaseRefresh = async ({
  request,
  repo,
  mainSha,
  releaseNumbers,
}: {
  request: GitHubRequest;
  repo: string;
  mainSha: string;
  /** The `numbers=` line of scripts/release-pull-requests.sh. */
  releaseNumbers: string;
}): Promise<RefreshPlan> => {
  fullSha(mainSha, "main commit");
  const numbers = releaseNumbers.split(/\s+/u).filter((entry) => entry !== "");
  if (numbers.length === 0) {
    return { refresh: false, reason: "no release pull request is open" };
  }
  if (numbers.length > 1) {
    throw new ReleaseRefreshError(
      `${String(numbers.length)} release pull requests are open (${numbers.join(", ")}); refresh one by hand`,
    );
  }
  const number = Number(numbers.at(0));
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ReleaseRefreshError(
      `Release pull request number is invalid: ${String(numbers.at(0))}`,
    );
  }
  const pull = await request([`repos/${repo}/pulls/${String(number)}`]);
  const headInfo = field(pull, "head", "pull request");
  const head = fullSha(field(headInfo, "sha", "pull request head"), "head");
  const branch = text(field(headInfo, "ref", "pull request head"), "branch");
  const comparison = await request([
    `repos/${repo}/compare/${head}...${mainSha}`,
  ]);
  const mergeBase = fullSha(
    field(
      field(comparison, "merge_base_commit", "comparison"),
      "sha",
      "merge base",
    ),
    "merge base",
  );
  const before = await changesetNames(request, repo, mergeBase);
  const added = await cliEntries(
    request,
    repo,
    mainSha,
    [...(await changesetNames(request, repo, mainSha))].filter(
      (name) => !before.has(name),
    ),
  );
  const pending = await cliEntries(
    request,
    repo,
    head,
    await changesetNames(request, repo, head),
  );
  if (added.length === 0 && pending.length === 0) {
    return {
      refresh: false,
      reason: `release #${String(number)} holds every @stll/cli changeset on main, versioned`,
    };
  }
  return {
    refresh: true,
    number,
    branch,
    head,
    merge: added.length > 0,
    changesets: [...new Set([...pending, ...added])].toSorted(),
  };
};

/**
 * Merges main into the release branch through GitHub, refusing when the
 * branch moved since the plan read it, then waits for the new head.
 */
export const updateReleaseBranch = async ({
  request,
  repo,
  number,
  head,
  sleep = Bun.sleep,
}: {
  request: GitHubRequest;
  repo: string;
  number: number;
  head: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> => {
  fullSha(head, "planned head");
  await request(
    [
      `repos/${repo}/pulls/${String(number)}/update-branch`,
      "--method",
      "PUT",
      "--input",
      "-",
    ],
    { expected_head_sha: head },
  );
  for (let attempt = 0; attempt < BRANCH_POLL_ATTEMPTS; attempt += 1) {
    const pull = await request([`repos/${repo}/pulls/${String(number)}`]);
    const current = fullSha(
      field(field(pull, "head", "pull request"), "sha", "pull request head"),
      "head",
    );
    if (current !== head) {
      return current;
    }
    await sleep(BRANCH_POLL_INTERVAL_MS);
  }
  throw new ReleaseRefreshError(
    `Release #${String(number)} still points at ${head} after the update`,
  );
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ReleaseRefreshError(`${name} is required`);
  }
  return value;
};

const writeOutputs = (outputs: Record<string, string>) => {
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  const file = process.env["GITHUB_OUTPUT"];
  if (file) {
    appendFileSync(file, lines);
  }
  process.stdout.write(lines);
};

const COMMANDS = ["plan", "update"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  COMMANDS.some((command) => command === value);

const main = async () => {
  const command = process.argv.at(2);
  if (!isCommand(command)) {
    throw new ReleaseRefreshError(
      `usage: release-pull-request-refresh.ts ${COMMANDS.join("|")}`,
    );
  }
  const repo = requiredEnv("REPOSITORY");
  switch (command) {
    case "plan": {
      const plan = await planReleaseRefresh({
        request: ghRetryRequest,
        repo,
        mainSha: requiredEnv("MAIN_SHA"),
        releaseNumbers: process.env["RELEASE_NUMBERS"] ?? "",
      });
      if (!plan.refresh) {
        process.stdout.write(`::notice::No release refresh: ${plan.reason}\n`);
        writeOutputs({ refresh: "false" });
        return;
      }
      writeOutputs({
        refresh: "true",
        number: String(plan.number),
        branch: plan.branch,
        head: plan.head,
        merge: String(plan.merge),
      });
      process.stdout.write(
        `::notice::Release #${String(plan.number)} takes main for ${plan.changesets.join(", ")}\n`,
      );
      return;
    }
    case "update": {
      const head = await updateReleaseBranch({
        request: ghRetryRequest,
        repo,
        number: Number(requiredEnv("RELEASE_PULL_REQUEST")),
        head: requiredEnv("HEAD_SHA"),
      });
      writeOutputs({ head });
      return;
    }
    default: {
      command satisfies never;
      throw new ReleaseRefreshError(`Unhandled command: ${String(command)}`);
    }
  }
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::release refresh: ${message}`);
    process.exit(1);
  });
}
