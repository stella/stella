import { panic } from "better-result";

import {
  ONLINE_WORK_LIFECYCLE,
  type OnlineWorkLifecycle,
} from "../apps/api/src/db/online-work-lifecycle";

export const ONLINE_WORK_LIFECYCLE_PATH =
  "apps/api/src/db/online-work-lifecycle.ts";

type GitResult = { exitCode: number; stdout: string; stderr: string };
export type OnlineWorkLifecycleGit = (args: readonly string[]) => GitResult;
type LifecycleState = OnlineWorkLifecycle["state"];

const ENTRY_LINE = /^"?([A-Za-z0-9_-]+)"?: (PENDING|FINALIZED),$/u;
const STATE_OF_CONSTANT = {
  PENDING: "pending",
  FINALIZED: "finalized",
} as const satisfies Record<string, LifecycleState>;
const STABLE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/u;

export const parseOnlineWorkLifecycle = (
  source: string,
): Map<string, LifecycleState> => {
  const entries = new Map<string, LifecycleState>();
  for (const line of source.split("\n")) {
    const match = ENTRY_LINE.exec(line.trimStart());
    if (match === null) {
      continue;
    }
    const [, name, constant] = match;
    if (
      name === undefined ||
      (constant !== "PENDING" && constant !== "FINALIZED")
    ) {
      return panic("Online work lifecycle entry pattern lost a group");
    }
    entries.set(name, STATE_OF_CONSTANT[constant]);
  }
  return entries;
};

const requireGit = (git: OnlineWorkLifecycleGit, args: readonly string[]) => {
  const result = git(args);
  if (result.exitCode !== 0) {
    return panic(
      `Online work lifecycle git command failed: git ${args.join(" ")}\n${result.stderr}`,
    );
  }
  return result.stdout;
};

/** The first commit whose diff added this entry's line to the lifecycle file. */
const registrationCommit = (
  git: OnlineWorkLifecycleGit,
  name: string,
): string | undefined =>
  requireGit(git, [
    "log",
    "--reverse",
    "--format=%H",
    "--pickaxe-regex",
    `-S[[:space:]"]${name}"?: `,
    "--",
    ONLINE_WORK_LIFECYCLE_PATH,
  ])
    .trim()
    .split("\n")
    .find((line) => line !== "");

type CheckOnlineWorkLifecycleOptions = {
  git: OnlineWorkLifecycleGit;
  base: string;
  /** The map the code compiles against; the file's text must say the same. */
  lifecycle: Readonly<Record<string, OnlineWorkLifecycle>>;
  /** The lifecycle file's text in the same tree as `lifecycle`. */
  source: string;
};

export const checkOnlineWorkLifecycle = ({
  git,
  base,
  lifecycle,
  source,
}: CheckOnlineWorkLifecycleOptions): string[] => {
  const problems: string[] = [];
  const parsed = parseOnlineWorkLifecycle(source);
  for (const [name, { state }] of Object.entries(lifecycle)) {
    if (parsed.get(name) !== state) {
      problems.push(
        `${name}: write its entry as one \`${name}: PENDING,\` or \`${name}: FINALIZED,\` line`,
      );
    }
  }
  if (problems.length > 0) {
    return problems;
  }

  const baseSource = git(["show", `${base}:${ONLINE_WORK_LIFECYCLE_PATH}`]);
  // The PR that introduces the lifecycle file registers the existing work.
  if (baseSource.exitCode !== 0) {
    return problems;
  }
  const baseEntries = parseOnlineWorkLifecycle(baseSource.stdout);
  for (const [name, { state }] of Object.entries(lifecycle)) {
    const previous = baseEntries.get(name);
    if (previous === "finalized" || state === "pending") {
      continue;
    }
    if (previous === undefined) {
      problems.push(
        `${name}: register new work as PENDING; finalize it in a later PR once a stable release contains it`,
      );
      continue;
    }
    const registered = registrationCommit(git, name);
    if (registered === undefined) {
      return panic(`Cannot find the commit that registered ${name}`);
    }
    const stableTags = requireGit(git, [
      "tag",
      "--contains",
      registered,
      "--list",
      "v*",
    ])
      .split("\n")
      .filter((tag) => STABLE_TAG.test(tag));
    if (stableTags.length === 0) {
      problems.push(
        `${name}: finalize it in a PR after a stable release contains ${registered.slice(0, 7)}`,
      );
    }
  }
  return problems;
};

const git: OnlineWorkLifecycleGit = (args) => {
  const result = Bun.spawnSync(["git", ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

if (import.meta.main) {
  const base = requireGit(git, ["merge-base", "HEAD", "origin/main"]).trim();
  const problems = checkOnlineWorkLifecycle({
    git,
    base,
    lifecycle: ONLINE_WORK_LIFECYCLE,
    source: await Bun.file(ONLINE_WORK_LIFECYCLE_PATH).text(),
  });
  if (problems.length > 0) {
    panic(problems.join("\n"));
  }
  console.log("Online work lifecycle transitions are release-safe.");
}
