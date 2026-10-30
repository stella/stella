#!/usr/bin/env bun
import { Result, TaggedError } from "better-result";
import { readFileSync } from "node:fs";

const REQUEST_TIMEOUT_MS = 15_000;
const ACTION_PIN =
  /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_./-]+)?@([a-fA-F0-9]{40})$/u;

class ActionPinError extends TaggedError("ActionPinError")<{
  message: string;
  cause?: unknown;
}> {}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const actionUses = (source: string) => {
  const decoded = Result.try({
    try: (): unknown => Bun.YAML.parse(source),
    catch: (cause) =>
      new ActionPinError({ message: "Unable to parse action YAML", cause }),
  });
  if (decoded.isErr()) {
    return decoded;
  }
  const parsed = decoded.value;
  const uses: string[] = [];
  const steps = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const step of value) {
        if (record(step) && typeof step["uses"] === "string") {
          uses.push(step["uses"]);
        }
      }
    }
  };
  if (record(parsed)) {
    steps(parsed["steps"]);
    steps(parsed["checks"]);
    if (record(parsed["runs"])) {
      steps(parsed["runs"]["steps"]);
    }
    if (record(parsed["jobs"])) {
      for (const job of Object.values(parsed["jobs"])) {
        if (record(job)) {
          if (typeof job["uses"] === "string") {
            uses.push(job["uses"]);
          }
          steps(job["steps"]);
        }
      }
    }
  }
  return Result.ok(uses);
};

type ActionPinChange = { before: string; after: string };
/** Compare parsed uses values so shell bodies, comments and YAML quoting cannot impersonate pins. */
export const changedActionPins = (changes: readonly ActionPinChange[]) => {
  const pins = new Map<string, { repository: string; sha: string }>();
  for (const { before, after } of changes) {
    const previousUses = actionUses(before);
    if (previousUses.isErr()) {
      return previousUses;
    }
    const nextUses = actionUses(after);
    if (nextUses.isErr()) {
      return nextUses;
    }
    const previous = new Set(previousUses.value);
    for (const uses of nextUses.value) {
      if (previous.has(uses)) {
        continue;
      }
      if (
        uses.startsWith("./") ||
        uses.startsWith("$/") ||
        uses.startsWith("docker://")
      ) {
        continue;
      }
      const match = ACTION_PIN.exec(uses);
      if (!match) {
        return Result.err(
          new ActionPinError({
            message: `Changed remote action must use a full commit SHA: ${uses}`,
          }),
        );
      }
      const repository = match?.at(1)?.toLowerCase();
      const sha = match?.at(2)?.toLowerCase();
      if (repository && sha) {
        pins.set(`${repository}@${sha}`, { repository, sha });
      }
    }
  }
  return Result.ok([...pins.values()]);
};

type VerifyActionPinsOptions = {
  changes: readonly ActionPinChange[];
  token: string | undefined;
  request?: typeof fetch;
};

export const verifyActionPins = async ({
  changes,
  token,
  request = fetch,
}: VerifyActionPinsOptions) => {
  const parsed = changedActionPins(changes);
  if (parsed.isErr()) {
    return parsed;
  }
  const pins = parsed.value;
  if (pins.length === 0) {
    return Result.ok(0);
  }
  if (!token) {
    return Result.err(
      new ActionPinError({
        message: "GITHUB_TOKEN is required to verify changed action pins",
      }),
    );
  }
  for (const { repository, sha } of pins) {
    const checked = await Result.tryPromise({
      try: async () => {
        const response = await request(
          `https://api.github.com/repos/${repository}/git/commits/${sha}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: "error",
          },
        );
        if (!response.ok) {
          return false;
        }
        const commit: unknown = await response.json();
        // Git Database commits does not peel annotated tags, unlike /commits/{ref}.
        return (
          typeof commit === "object" &&
          commit !== null &&
          "sha" in commit &&
          commit.sha === sha &&
          "tree" in commit &&
          typeof commit.tree === "object" &&
          commit.tree !== null &&
          "sha" in commit.tree &&
          typeof commit.tree.sha === "string" &&
          /^[a-f0-9]{40}$/u.test(commit.tree.sha) &&
          "parents" in commit &&
          Array.isArray(commit.parents)
        );
      },
      catch: (cause) =>
        new ActionPinError({
          message: `Could not verify action commit ${repository}@${sha}`,
          cause,
        }),
    });
    if (checked.isErr()) {
      return checked;
    }
    if (!checked.value) {
      return Result.err(
        new ActionPinError({
          message: `Action pin is not a verified commit: ${repository}@${sha}`,
        }),
      );
    }
  }
  return Result.ok(pins.length);
};

if (import.meta.main) {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new ActionPinError({
        message: "Unable to read changed action pins",
      });
    }
    return result.stdout.toString();
  };
  const base =
    process.argv.at(2) ?? git(["merge-base", "origin/main", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/u.test(base) || process.argv.length > 3) {
    process.stderr.write("Usage: check-action-commit-pins.ts [base-sha]\n");
    process.exit(1);
  }
  const changes = git([
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=AM",
    "-z",
    base,
    "--",
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ".github/actions/**/action.yml",
    ".github/actions/**/action.yaml",
    ".github/ci-checks/*.yml",
  ])
    .split("\0")
    .filter(Boolean)
    .map((file) => {
      const exists = git(["ls-tree", base, "--", file]).length > 0;
      return {
        before: exists ? git(["show", `${base}:${file}`]) : "",
        after: readFileSync(file, "utf-8"),
      };
    });
  const result = await verifyActionPins({
    changes,
    token: process.env.GITHUB_TOKEN,
  });
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Verified ${result.value} changed action commit pin(s).\n`,
  );
}
