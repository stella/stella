import { lexShell } from "./install-free-ci";

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
    const windows = JSON.stringify([
      job["runs-on"],
      isRecord(job["strategy"]) ? job["strategy"]["matrix"] : null,
    ]).includes("windows");
    if (scope === "windows" && !windows) {
      continue;
    }
    const steps = job["steps"].filter(isRecord);
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
        const program = event.words.at(1);
        const owner = program?.endsWith("/ci-install.ts") === true;
        const install = event.words.some((word) =>
          ["install", "i", "ci", "add"].includes(word),
        );
        if (!owner && install) {
          problems.push(`${name}: install bypasses scripts/ci-install.ts`);
        }
        if (!owner) {
          continue;
        }
        const limit = step["timeout-minutes"];
        if (
          typeof limit !== "number" ||
          limit <= 0 ||
          limit > (windows ? 3 : 10) ||
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
