import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";

import { childExitStatus } from "./child-exit-status";

const UNAVAILABLE = "Tree comparison base unavailable";
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

/** Where each CI event that compares against a base records that commit. */
const EVENT_BASE_FIELDS = {
  merge_group: ["merge_group", "base_sha"],
  pull_request: ["pull_request", "base", "sha"],
} as const;

type BaseEvent = keyof typeof EVENT_BASE_FIELDS;

const isBaseEvent = (name: string | undefined): name is BaseEvent =>
  name !== undefined && Object.hasOwn(EVENT_BASE_FIELDS, name);

/**
 * The commit the CI event compares against. A merge group's base may trail
 * `origin/main` by several queued commits, so the live merge base would
 * compare against changes the group does not contain.
 */
const eventBaseRevision = (env: NodeJS.ProcessEnv): string | undefined => {
  // The workflow exports an empty value outside merge groups.
  const mergeGroupBase = env["MERGE_GROUP_BASE_SHA"];
  if (mergeGroupBase) {
    return mergeGroupBase;
  }
  const eventName = env["GITHUB_EVENT_NAME"];
  if (!isBaseEvent(eventName)) {
    return undefined;
  }
  const eventPath =
    env["GITHUB_EVENT_PATH"] ||
    panic(
      `${UNAVAILABLE}: GITHUB_EVENT_PATH is not set for a ${eventName} event`,
    );
  const payload = Result.try(() =>
    JSON.parse(readFileSync(eventPath, "utf-8")),
  );
  if (payload.isErr()) {
    return panic(
      `${UNAVAILABLE}: the ${eventName} payload at ${eventPath} is unreadable`,
      payload.error,
    );
  }
  const fields = EVENT_BASE_FIELDS[eventName];
  let base: unknown = payload.value;
  for (const key of fields) {
    base =
      typeof base === "object" && base !== null
        ? Reflect.get(base, key)
        : undefined;
  }
  if (typeof base !== "string" || !COMMIT_SHA.test(base)) {
    return panic(
      `${UNAVAILABLE}: the ${eventName} payload has no ${fields.join(".")} commit`,
    );
  }
  return base;
};

type TreeBaseRevisionOptions = {
  repoRoot: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  env?: NodeJS.ProcessEnv;
};

/**
 * The base this tree is compared against, in order: an explicit base or
 * RATCHET_BASE_REF, the CI event's base, then the merge base with
 * origin/main. The event base describes the checked-out tree, so it applies
 * only when no other head is named.
 */
export const treeBaseRevision = ({
  repoRoot,
  baseRef,
  headRef,
  env = process.env,
}: TreeBaseRevisionOptions): string => {
  // Hooks may export selectors for another repository; cwd owns this Git read.
  const gitEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => !key.startsWith("GIT_") && value !== undefined,
    ),
  );
  const readGit = (args: [string, ...string[]]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (childExitStatus(result) !== 0) {
      return panic(
        `${UNAVAILABLE}: git ${args[0]} failed (${args.join(" ")}): ${result.stderr.toString().trim()}`,
      );
    }
    return result.stdout.toString().trim();
  };
  const revision =
    baseRef ??
    env["RATCHET_BASE_REF"] ??
    (headRef === undefined ? eventBaseRevision(env) : undefined) ??
    readGit(["merge-base", "origin/main", headRef ?? "HEAD"]);
  return readGit([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
};
