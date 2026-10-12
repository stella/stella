import { installTimeoutMs } from "./ci-install";
import { measuredInstallBudget } from "./ci-install-budgets";
import { lexShell } from "./install-free-ci";
import { flattenWorkflowSteps } from "./workflow-steps";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type InstallWorkflowPolicy =
  | { type: "check"; scope: "windows" | "all" }
  | { type: "pinned-release"; reason: string };

const WORKFLOW_EXCLUSIONS = {
  "release-desktop.yml": {
    type: "pinned-release",
    reason:
      "Checks out a pinned release SHA; repository install scripts may not exist there.",
  },
} as const satisfies Record<
  string,
  Extract<InstallWorkflowPolicy, { type: "pinned-release" }>
>;

export const installWorkflowPolicy = (file: string): InstallWorkflowPolicy => {
  const exclusion = Object.entries(WORKFLOW_EXCLUSIONS).find(
    ([name]) => name === file,
  );
  return (
    exclusion?.[1] ?? {
      type: "check",
      scope: file === "ci.yml" ? "all" : "windows",
    }
  );
};

const installPlatforms = (job: Record<string, unknown>) => {
  const runner = job["runs-on"];
  const matrixVariable =
    typeof runner === "string"
      ? /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/u.exec(runner)?.at(1)
      : undefined;
  const strategy = job["strategy"];
  const matrix = isRecord(strategy) ? strategy["matrix"] : undefined;
  const include =
    isRecord(matrix) && Array.isArray(matrix["include"])
      ? matrix["include"]
      : [];
  const hints = JSON.stringify(
    matrixVariable && isRecord(matrix)
      ? [
          matrix[matrixVariable],
          ...include.filter(isRecord).map((entry) => entry[matrixVariable]),
        ]
      : (runner ?? null),
  ).toLowerCase();
  const platforms: NodeJS.Platform[] = [];
  if (hints.includes("windows")) {
    platforms.push("win32");
  }
  if (hints.includes("ubuntu") || hints.includes("linux")) {
    platforms.push("linux");
  }
  if (hints.includes("macos")) {
    platforms.push("darwin");
  }
  return platforms;
};

/** Windows workflows and CI's explicit cold installs must share the owner. */
export const boundedInstallProblems = (
  workflow: unknown,
  scope: "windows" | "all",
) => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return ["Expected workflow jobs"];
  }
  const problems: string[] = [];
  for (const [name, job] of Object.entries(workflow["jobs"])) {
    if (!isRecord(job) || !Array.isArray(job["steps"])) {
      continue;
    }
    const platforms = installPlatforms(job);
    const windows = platforms.includes("win32");
    const steps = flattenWorkflowSteps(job["steps"]);
    const uploads = steps.filter(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith("actions/upload-artifact@") &&
        step["if"] === "failure()" &&
        isRecord(step["with"]) &&
        step["with"]["path"] === `\${{ runner.temp }}/bun-install/*.log`,
    );
    for (const [index, step] of steps.entries()) {
      if (typeof step["run"] !== "string") {
        continue;
      }
      for (const event of lexShell(step["run"])) {
        if (event.type !== "command" || event.words.at(0) !== "bun") {
          continue;
        }
        const program = event.words.findIndex(
          (word) => word === "ci-install.ts" || word.endsWith("/ci-install.ts"),
        );
        const owner = program >= 1;
        if (scope === "windows" && !windows && !owner) {
          continue;
        }
        const install = event.words.some((word) =>
          ["install", "i", "ci", "add"].includes(word),
        );
        if (!owner && install) {
          problems.push(`${name}: install bypasses scripts/ci-install.ts`);
        }
        if (!owner) {
          continue;
        }
        let timeoutMs = installTimeoutMs(windows ? "win32" : "linux");
        if (platforms.length === 0) {
          problems.push(`${name}: cannot determine the install platform`);
        }
        const budgets: number[] = [];
        for (const platform of platforms) {
          try {
            budgets.push(
              measuredInstallBudget({
                platform,
                flags: event.words.slice(program + 2),
              }).timeoutMs,
            );
          } catch (error) {
            problems.push(`${name}: ${String(error)}`);
          }
        }
        if (budgets.length > 0) {
          timeoutMs = Math.max(...budgets);
        }
        const minimum = Math.ceil(timeoutMs / 60_000) + 1;
        const maximum = windows ? minimum : 10;
        const limit = step["timeout-minutes"];
        if (
          typeof limit !== "number" ||
          limit < minimum ||
          limit > maximum ||
          (typeof job["timeout-minutes"] === "number" &&
            limit >= job["timeout-minutes"])
        ) {
          problems.push(`${name}: install needs a bounded step timeout`);
        }
        if (
          !uploads.some((upload) => steps.indexOf(upload) > index) ||
          !event.words.some((word) => word.includes("/bun-install/"))
        ) {
          problems.push(`${name}: install needs a retained failure log`);
        }
      }
    }
  }
  return problems;
};
