import { installTimeoutMs } from "./ci-install";
import { lexShell } from "./install-free-ci";
import { flattenWorkflowSteps } from "./workflow-steps";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type InstallWorkflowPolicy =
  | { type: "check"; scope: "windows" | "all" }
  | { type: "pinned-release"; reason: string };

const CI_INSTALL_ACTION_SELECTORS = new Set([
  "$/.github/actions/ci-install",
  "./.github/actions/ci-install",
]);

const isCiInstallAction = (step: Record<string, unknown>) =>
  typeof step["uses"] === "string" &&
  CI_INSTALL_ACTION_SELECTORS.has(step["uses"]);

const isMisownedCiInstallAction = (step: Record<string, unknown>) =>
  typeof step["uses"] === "string" &&
  /(?:^|\/)\.github\/actions\/ci-install(?:@[^/]+)?$/u.test(step["uses"]) &&
  !CI_INSTALL_ACTION_SELECTORS.has(step["uses"]);

const stepRunsOnWindows = (
  step: Record<string, unknown>,
  jobIncludesWindows: boolean,
) => {
  const condition = step["if"];
  if (typeof condition !== "string") {
    return jobIncludesWindows;
  }
  if (/matrix\.os\s*==\s*['"]macos['"]/u.test(condition)) {
    return false;
  }
  if (/matrix\.os\s*==\s*['"]windows['"]/u.test(condition)) {
    return true;
  }
  return jobIncludesWindows;
};

const compositeInstallFlags = (step: Record<string, unknown>) => {
  const inputs = isRecord(step["with"]) ? step["with"] : null;
  const serialized = inputs?.["flags"];
  if (typeof serialized !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((flag) => typeof flag === "string" && flag.trim() !== "")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

type ScopedActionValidation = {
  name: string;
  job: Record<string, unknown>;
  step: Record<string, unknown>;
  windowsInstall: boolean;
};

export const SCOPED_INSTALL_STEP_MINUTES = {
  windows: 5,
  minimum: 2,
  maximum: 10,
} as const;

// Linux full-scope cold restore + install measured 19.331 s in benchmark
// run 38259500894. A 90 s installer cap reserves 30 s inside the 2 minute caller.
export const SCOPED_INSTALL_PHASE_MS = {
  restoreVerify: 15_000,
  cleanup: 15_000,
  e2eInstaller: 90_000,
} as const;

const scopedActionProblems = ({
  name,
  job,
  step,
  windowsInstall,
}: ScopedActionValidation) => {
  const problems: string[] = [];
  const flags = compositeInstallFlags(step);
  if (
    flags === null ||
    !flags.includes("--frozen-lockfile") ||
    !flags.includes("--ignore-scripts")
  ) {
    problems.push(
      `${name}: ci-install action needs ordered frozen install flags`,
    );
  }
  const inputs = isRecord(step["with"]) ? step["with"] : {};
  const logFile = inputs["log-file"];
  if (
    logFile !== undefined &&
    (typeof logFile !== "string" ||
      (logFile !== "" && !logFile.includes("/bun-install/")))
  ) {
    problems.push(`${name}: ci-install action needs a retained failure log`);
  }
  const minimum = windowsInstall
    ? SCOPED_INSTALL_STEP_MINUTES.windows
    : SCOPED_INSTALL_STEP_MINUTES.minimum;
  const maximum = windowsInstall
    ? minimum
    : SCOPED_INSTALL_STEP_MINUTES.maximum;
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
  const requested = inputs["installer-budget-ms"];
  if (requested !== undefined && typeof requested !== "string") {
    problems.push(
      `${name}: installer budget must be a literal millisecond string`,
    );
    return problems;
  }
  let installerMs: number;
  try {
    installerMs = installTimeoutMs(
      windowsInstall ? "win32" : "linux",
      requested,
    );
  } catch {
    problems.push(`${name}: invalid installer budget`);
    return problems;
  }
  const requiredMs =
    SCOPED_INSTALL_PHASE_MS.restoreVerify +
    installerMs +
    SCOPED_INSTALL_PHASE_MS.cleanup;
  if (typeof limit === "number" && limit * 60_000 < requiredMs) {
    problems.push(
      `${name}: caller deadline must cover restore/verify, installer and cleanup`,
    );
  }
  return problems;
};

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
      const windowsInstall = stepRunsOnWindows(step, windows);
      if (isMisownedCiInstallAction(step)) {
        problems.push(`${name}: install bypasses scripts/ci-install.ts`);
        continue;
      }
      if (isCiInstallAction(step)) {
        problems.push(
          ...scopedActionProblems({ name, job, step, windowsInstall }),
        );
        continue;
      }
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
        const minimum =
          Math.ceil(
            installTimeoutMs(windowsInstall ? "win32" : "linux") / 60_000,
          ) + 1;
        const maximum = windowsInstall ? minimum : 10;
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

/** Audit every scoped composite caller, including non-Windows auxiliary jobs. */
export const compositeInstallProblems = (workflow: unknown) => {
  if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
    return boundedInstallProblems(workflow, "all");
  }
  const jobs = new Map<string, unknown>();
  for (const [name, job] of Object.entries(workflow["jobs"])) {
    if (!isRecord(job) || !Array.isArray(job["steps"])) {
      jobs.set(name, job);
      continue;
    }
    const steps = flattenWorkflowSteps(job["steps"]).filter(
      (step) => isCiInstallAction(step) || isMisownedCiInstallAction(step),
    );
    jobs.set(name, { ...job, steps });
  }
  return boundedInstallProblems({ jobs: Object.fromEntries(jobs) }, "all");
};
