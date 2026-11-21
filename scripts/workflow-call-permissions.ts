import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Runs before CI installs dependencies: Bun built-ins only.

// A called workflow may not request more than its caller grants. GitHub
// rejects such a run at startup, before any job reports a result, and
// workflows that never run on pull requests would show it only after merge.

const LEVELS = { none: 0, read: 1, write: 2 } as const;
type Level = keyof typeof LEVELS;

export type PermissionGap = {
  caller: string;
  callee: string;
  scope: string;
  granted: Level;
  requested: Level;
};

class WorkflowCallPermissionsError extends Error {
  override name = "WorkflowCallPermissionsError";
  readonly _tag = "WorkflowCallPermissionsError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const levelOf = (value: unknown, where: string): Level => {
  if (value === "none" || value === "read" || value === "write") {
    return value;
  }
  throw new WorkflowCallPermissionsError(
    `${where}: unexpected permission level ${String(value)}`,
  );
};

type Permissions =
  | { kind: "all"; level: Level }
  | { kind: "scopes"; scopes: Map<string, Level> };

/** `undefined` means the block is absent; an explicit `{}` grants nothing. */
const parsePermissions = (
  value: unknown,
  where: string,
): Permissions | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === "read-all") {
    return { kind: "all", level: "read" };
  }
  if (value === "write-all") {
    return { kind: "all", level: "write" };
  }
  if (!isRecord(value)) {
    throw new WorkflowCallPermissionsError(
      `${where}: unexpected permissions ${JSON.stringify(value)}`,
    );
  }
  return {
    kind: "scopes",
    scopes: new Map(
      Object.entries(value).map(([scope, level]) => [
        scope,
        levelOf(level, `${where}.${scope}`),
      ]),
    ),
  };
};

const grantedLevel = (granted: Permissions, scope: string): Level =>
  granted.kind === "all"
    ? granted.level
    : (granted.scopes.get(scope) ?? "none");

const readWorkflow = (file: string): Record<string, unknown> => {
  const value: unknown = Bun.YAML.parse(readFileSync(file, "utf-8"));
  if (!isRecord(value)) {
    throw new WorkflowCallPermissionsError(`${file}: expected a workflow`);
  }
  return value;
};

const jobsOf = (workflow: Record<string, unknown>, where: string) => {
  const jobs = workflow["jobs"];
  if (!isRecord(jobs)) {
    throw new WorkflowCallPermissionsError(`${where}: expected jobs`);
  }
  return Object.entries(jobs).map(([id, job]) => {
    if (!isRecord(job)) {
      throw new WorkflowCallPermissionsError(`${where}#${id}: expected a job`);
    }
    return [id, job] as const;
  });
};

/**
 * Every local reusable-workflow call in `workflowsDir`, and each permission a
 * callee (workflow level or any of its jobs) requests beyond the caller's
 * grant. A caller with no permissions block at either level is treated as
 * granting nothing, so the grant is always written down.
 */
export const workflowCallPermissionGaps = (workflowsDir: string) => {
  const workflows = new Map<string, Record<string, unknown>>();
  const workflowAt = (file: string) => {
    const cached = workflows.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const parsed = readWorkflow(path.join(workflowsDir, file));
    workflows.set(file, parsed);
    return parsed;
  };

  const calls: string[] = [];
  const gaps: PermissionGap[] = [];
  const files = readdirSync(workflowsDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted();
  for (const file of files) {
    const caller = workflowAt(file);
    for (const [jobId, job] of jobsOf(caller, file)) {
      const uses = job["uses"];
      if (
        typeof uses !== "string" ||
        !uses.startsWith("./.github/workflows/")
      ) {
        continue;
      }
      const location = `${file}#${jobId}`;
      calls.push(location);
      const granted = parsePermissions(
        job["permissions"] ?? caller["permissions"],
        location,
      ) ?? { kind: "scopes", scopes: new Map<string, Level>() };
      const calleeFile = path.basename(uses);
      const callee = workflowAt(calleeFile);
      const requests = [
        ["workflow", callee["permissions"]] as const,
        ...jobsOf(callee, calleeFile).map(
          ([id, calleeJob]) => [id, calleeJob["permissions"]] as const,
        ),
      ];
      for (const [scopeOwner, value] of requests) {
        const where = `${uses}#${scopeOwner}`;
        const requested = parsePermissions(value, where);
        if (requested === undefined) {
          continue;
        }
        if (requested.kind === "all") {
          if (requested.level === "none") {
            continue;
          }
          if (
            granted.kind !== "all" ||
            LEVELS[granted.level] < LEVELS[requested.level]
          ) {
            gaps.push({
              caller: location,
              callee: where,
              scope: `${requested.level}-all`,
              granted: granted.kind === "all" ? granted.level : "none",
              requested: requested.level,
            });
          }
          continue;
        }
        for (const [scope, level] of requested.scopes) {
          const have = grantedLevel(granted, scope);
          if (LEVELS[have] < LEVELS[level]) {
            gaps.push({
              caller: location,
              callee: where,
              scope,
              granted: have,
              requested: level,
            });
          }
        }
      }
    }
  }
  return { calls, gaps };
};
