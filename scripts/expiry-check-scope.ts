import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Runs before any dependency install (install-free-ci.test.ts), so it
// raises a tagged built-in error instead of a better-result panic.
export class ExpiryScopeError extends Error {
  override name = "ExpiryScopeError";
  readonly _tag = "ExpiryScopeError";
}

export type ExpiryCheckScope =
  | { type: "all" }
  | { type: "changes"; changedFiles: ReadonlySet<string>; baseSha?: string };

/** Only wall-clock expiry is scoped; malformed and undated entries always fail. */
export const expiryBlocksFiles = (
  scope: ExpiryCheckScope,
  owningFiles: readonly string[],
): boolean =>
  scope.type === "all" ||
  owningFiles.some((file) => scope.changedFiles.has(file));

export const expiryWarning = (message: string): string =>
  `::warning::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

export const expiryScopeBase = (
  eventName: string,
  event: unknown,
): string | undefined => {
  if (eventName !== "pull_request" && eventName !== "merge_group") {
    return undefined;
  }
  if (typeof event !== "object" || event === null) {
    throw new ExpiryScopeError("Expiry scope requires a GitHub event payload");
  }
  let base: unknown;
  if (eventName === "pull_request" && "pull_request" in event) {
    const pr = event.pull_request;
    if (typeof pr === "object" && pr !== null && "base" in pr) {
      const prBase = pr.base;
      if (typeof prBase === "object" && prBase !== null && "sha" in prBase) {
        base = prBase.sha;
      }
    }
  }
  if (eventName === "merge_group" && "merge_group" in event) {
    const group = event.merge_group;
    if (typeof group === "object" && group !== null && "base_sha" in group) {
      base = group.base_sha;
    }
  }
  if (typeof base !== "string" || !/^[a-f\d]{40}$/u.test(base)) {
    throw new ExpiryScopeError(
      "Expiry scope requires the exact event base SHA",
    );
  }
  return base;
};

export const readExpiryCheckScope = (): ExpiryCheckScope => {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
  if (eventName !== "pull_request" && eventName !== "merge_group") {
    return { type: "all" };
  }
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  if (eventPath === undefined) {
    throw new ExpiryScopeError("Expiry scope requires GITHUB_EVENT_PATH");
  }
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf-8"));
  const base = expiryScopeBase(eventName, event);
  if (base === undefined) {
    throw new ExpiryScopeError("Expiry scope has no event base");
  }
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const present = spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], {
    cwd,
  });
  if (present.status !== 0) {
    const fetched = spawnSync(
      "git",
      ["fetch", "--no-tags", "--depth=1", "origin", base],
      { cwd },
    );
    if (fetched.status !== 0) {
      throw new ExpiryScopeError("Cannot fetch the expiry scope base commit");
    }
  }
  return {
    type: "changes",
    baseSha: base,
    changedFiles: changedFilesSince(base, cwd),
  };
};

// The checked-out PR merge commit and merge-group commit already contain the
// base. A two-tree diff remains valid with the shallow checkout used in CI.
// Rename detection is off: a moved owner path must stay in scope under its
// old name too, as a deletion plus an addition.
export const changedFilesSince = (base: string, cwd: string): Set<string> => {
  const diff = spawnSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"],
    { cwd },
  );
  if (diff.status !== 0) {
    throw new ExpiryScopeError(
      "Cannot determine changed files for expiry scope",
    );
  }
  return new Set(diff.stdout.toString().split("\0").filter(Boolean));
};

if (import.meta.main) {
  const scope = readExpiryCheckScope();
  console.log(
    JSON.stringify(
      scope.type === "all"
        ? scope
        : {
            type: scope.type,
            changedFiles: [...scope.changedFiles],
            baseSha: scope.baseSha,
          },
    ),
  );
}
