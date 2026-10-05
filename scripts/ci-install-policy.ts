import { lexShell } from "./install-free-ci";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
        const owner = event.words.find((word) =>
          word.endsWith("/ci-install.ts"),
        );
        const install = event.words.some((word) =>
          ["install", "i", "ci", "add"].includes(word),
        );
        if (owner === undefined && install) {
          problems.push(`${name}: install bypasses scripts/ci-install.ts`);
        }
        if (owner === undefined) {
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
