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

// The probe must distinguish warm and cold caches; an arbitrary output or
// unconditional true value cannot justify the longer install budget.
const RESTORED_CACHE_BUDGET_SCRIPT = `if compgen -G "$HOME/.bun/install/cache/*" > /dev/null; then
echo "cache-restored=true" >> "$GITHUB_OUTPUT"
else
echo "cache-restored=false" >> "$GITHUB_OUTPUT"
fi`;

const hasRestoredCacheBudget = (
  step: Record<string, unknown>,
  previousSteps: readonly Record<string, unknown>[],
) => {
  if (!isRecord(step["env"])) {
    return false;
  }
  const evidence = step["env"]["CI_INSTALL_CACHE_RESTORED"];
  return previousSteps.some((probe, index) => {
    if (
      typeof probe["id"] !== "string" ||
      probe["if"] !== undefined ||
      typeof probe["run"] !== "string" ||
      evidence !== `\${{ steps.${probe["id"]}.outputs.cache-restored }}`
    ) {
      return false;
    }
    const script = probe["run"]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .join("\n");
    return (
      script === RESTORED_CACHE_BUDGET_SCRIPT &&
      previousSteps
        .slice(0, index)
        .some(
          (candidate) =>
            candidate["if"] === undefined &&
            typeof candidate["uses"] === "string" &&
            candidate["uses"].startsWith(
              "stella/.github/actions/setup-bun-cached@",
            ) &&
            (!isRecord(candidate["with"]) ||
              candidate["with"]["install-cache"] === undefined ||
              candidate["with"]["install-cache"] === "actions"),
        )
    );
  });
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
        const cacheAware =
          windows && hasRestoredCacheBudget(step, steps.slice(0, index));
        const defaultMaximum = windows ? 3 : 10;
        const maximum = cacheAware ? 5 : defaultMaximum;
        const limit = step["timeout-minutes"];
        if (
          typeof limit !== "number" ||
          limit <= 0 ||
          (cacheAware && limit < 5) ||
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
