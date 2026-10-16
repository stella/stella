import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ExpiryScopeError,
  expiryScopeBase,
  type ExpiryCheckScope,
} from "./expiry-check-scope";

// The git side of the expiry scope. Offline checks import only
// `expiry-check-scope.ts` and receive the scope from a preparing step.
// Like that module, this runs before any dependency install.

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
