import { readFileSync } from "node:fs";
import path from "node:path";

import { definitelyFalse, evaluate } from "./github-expression";

const RELEASE_CHAIN_MARKER = "# release-chain-alert";

class WorkflowOutageError extends Error {
  override name = "WorkflowOutageError";
  readonly _tag = "WorkflowOutageError";
}

const panic = (message: string): never => {
  throw new WorkflowOutageError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown) =>
  isRecord(value) ? value : panic("Expected workflow data object");

const string = (value: unknown): string =>
  typeof value === "string" ? value : panic("Expected workflow data string");

const runData = (value: unknown) => {
  const run = record(value);
  if (typeof run["run_number"] !== "number") {
    return panic("Expected workflow run number");
  }
  const conclusion = run["conclusion"];
  if (conclusion !== null && typeof conclusion !== "string") {
    return panic("Expected workflow run conclusion");
  }
  return {
    number: run["run_number"],
    conclusion,
    event: string(run["event"]),
    branch: string(run["head_branch"]),
    title: string(run["display_title"]),
  };
};

type Run = ReturnType<typeof runData>;

const concurrencyGroups = (workflow: Record<string, unknown>, run: Run) => {
  const context = {
    values: {
      "github.workflow": string(workflow["name"]),
      "github.event_name": run.event,
      "github.ref": `refs/heads/${run.branch}`,
      "github.ref_name": run.branch,
    },
  };
  const runName = workflow["run-name"];
  const titleExpression =
    typeof runName === "string"
      ? /^(.*?)\$\{\{([\s\S]*?)\}\}(.*?)$/u.exec(runName)
      : null;
  const group = (concurrency: unknown) => {
    const template =
      typeof concurrency === "string"
        ? concurrency
        : string(record(concurrency)["group"]);
    return template
      .replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) => {
        // Inputs and upstream workflow_run payloads are absent from the runs API.
        // The run-name carries the same expression's value for release groups.
        if (
          titleExpression &&
          expression.trim() === titleExpression[2]?.trim()
        ) {
          const prefix = titleExpression[1] ?? "";
          const suffix = titleExpression[3] ?? "";
          if (!run.title.startsWith(prefix) || !run.title.endsWith(suffix)) {
            return panic("Run title does not match workflow run-name");
          }
          return run.title.slice(
            prefix.length,
            run.title.length - suffix.length,
          );
        }
        const value = evaluate(expression, context);
        return typeof value === "string"
          ? value
          : panic(`Cannot derive concurrency group: ${template}`);
      })
      .toLowerCase();
  };
  const groups: string[] = [];
  if (workflow["concurrency"] !== undefined) {
    groups.push(group(workflow["concurrency"]));
  }
  for (const value of Object.values(record(workflow["jobs"]))) {
    const job = record(value);
    if (job["concurrency"] === undefined) {
      continue;
    }
    const condition = job["if"];
    if (typeof condition === "string" && definitelyFalse(condition, context)) {
      continue;
    }
    groups.push(group(job["concurrency"]));
  }
  return groups;
};

export const workflowOutageSends = ({
  source,
  current,
  history,
}: {
  source: string;
  current: unknown;
  history: unknown[];
}) => {
  const workflow = record(Bun.YAML.parse(source));
  const run = runData(current);
  const runs = [...history.map(runData), run];
  const releaseChain = source.split("\n").includes(RELEASE_CHAIN_MARKER);
  const newestInGroup = new Map<string, number>();
  if (releaseChain) {
    for (const candidate of runs) {
      for (const group of concurrencyGroups(workflow, candidate)) {
        newestInGroup.set(
          group,
          Math.max(newestInGroup.get(group) ?? 0, candidate.number),
        );
      }
    }
  }
  const superseded = (candidate: Run) =>
    concurrencyGroups(workflow, candidate).some((group) => {
      const newest = newestInGroup.get(group);
      return newest === undefined
        ? panic("Missing concurrency group")
        : newest > candidate.number;
    });
  if (run.conclusion === "cancelled" && (!releaseChain || superseded(run))) {
    return false;
  }
  const previous = runs
    .filter(
      (candidate) =>
        candidate.number < run.number &&
        candidate.branch === run.branch &&
        candidate.event === run.event &&
        candidate.conclusion !== null &&
        candidate.conclusion !== "skipped" &&
        (candidate.conclusion !== "cancelled" ||
          (releaseChain && !superseded(candidate))),
    )
    .toSorted((left, right) => right.number - left.number)
    .at(0);
  return !["failure", "startup_failure", "timed_out", "cancelled"].includes(
    string(previous?.conclusion ?? "none"),
  );
};

if (import.meta.main) {
  const eventPath = process.argv.at(2) ?? panic("Expected workflow event path");
  const checkout =
    process.argv.at(3) ?? panic("Expected workflow checkout path");
  const event = record(JSON.parse(readFileSync(eventPath, "utf-8")));
  const current = record(event["workflow_run"]);
  const source = readFileSync(
    path.join(checkout, string(current["path"])),
    "utf-8",
  );
  const pages: unknown = JSON.parse(await Bun.stdin.text());
  const historyPages = Array.isArray(pages)
    ? pages
    : panic("Expected paginated workflow runs");
  const history = historyPages.flatMap((page: unknown) => {
    const runs = record(page)["workflow_runs"];
    return Array.isArray(runs) ? runs : panic("Expected workflow runs");
  });
  process.stdout.write(
    `send=${workflowOutageSends({ source, current, history })}\n`,
  );
}
