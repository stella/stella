import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  completeInstallStoreKey,
  parseGlobalStoreMode,
} from "./ci-install-store";
import { evaluate } from "./github-expression";
import { flattenWorkflowSteps, workflowCiInstallFlags } from "./workflow-steps";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const matrixRows = (matrix: unknown): Record<string, unknown>[] => {
  if (!isRecord(matrix)) {
    return [{}];
  }
  let rows: Record<string, unknown>[] = [{}];
  for (const [axis, rawValues] of Object.entries(matrix)) {
    if (axis === "include" || axis === "exclude") {
      continue;
    }
    // Plan-generated shard axes do not change the store identity. Their
    // callers must restore only; unresolved identity fields still fail below.
    if (typeof rawValues === "string" && rawValues.includes("needs.")) {
      continue;
    }
    const values =
      typeof rawValues === "string"
        ? evaluate(rawValues, { values: { "github.event_name": "push" } })
        : rawValues;
    if (!Array.isArray(values)) {
      panic(`Unsupported matrix axis ${axis}`);
    }
    rows = rows.flatMap((row) =>
      values.map((value) => ({ ...row, [axis]: value })),
    );
  }
  if (Array.isArray(matrix["include"])) {
    // CI's platform matrix uses include without axes. Fail closed when a new
    // hybrid matrix needs GitHub's include-merge semantics.
    if (Object.keys(matrix).some((axis) => axis !== "include")) {
      panic("Store saver census requires an include-only matrix");
    }
    rows = matrix["include"].map((row) => {
      if (!isRecord(row)) {
        panic("Invalid included matrix row");
      }
      return row;
    });
  }
  if (matrix["exclude"] !== undefined) {
    panic("Unsupported store saver matrix exclusions");
  }
  return rows;
};

const resolve = (value: unknown, row: Record<string, unknown>) => {
  if (typeof value !== "string" || !value.includes("${{")) {
    return value;
  }
  const matrixValues = Object.fromEntries(
    Object.entries(row).map(([axis, entry]) => {
      if (
        typeof entry !== "string" &&
        typeof entry !== "number" &&
        typeof entry !== "boolean"
      ) {
        panic(`Unsupported matrix value ${axis}`);
      }
      return [`matrix.${axis}`, entry] as const;
    }),
  );
  const values = {
    ...matrixValues,
    "github.ref": "refs/heads/main",
    "github.event_name": "push",
  };
  return evaluate(value, { values });
};

const canRunOnMain = (condition: unknown, row: Record<string, unknown>) =>
  typeof condition !== "string" ||
  resolve(
    condition.includes("${{") ? condition : `\${{ ${condition} }}`,
    row,
  ) !== false;

const platformIdentity = (runner: unknown) => {
  switch (runner) {
    case "ubuntu-latest":
    case "ubuntu-24.04":
      return { platform: "linux", arch: "x64" };
    case "macos-14":
      return { platform: "darwin", arch: "arm64" };
    case "windows-latest":
      return { platform: "win32", arch: "x64" };
    default:
      return panic(
        `Declare store saver platform and architecture for ${String(runner)}`,
      );
  }
};

type StoreSaverCensusOptions = {
  workflows: Record<string, unknown>;
  root: string;
};

const assertMeasurementSave = (file: string, step: Record<string, unknown>) => {
  const inputs = isRecord(step["with"]) ? step["with"] : {};
  if (
    file !== "manual-checks.yml" ||
    inputs["key"] !==
      `install-store-measurement-\${{ github.run_id }}-\${{ github.run_attempt }}` ||
    step["if"] !== "inputs.check == 'store-cache-save-benchmark'" ||
    step["continue-on-error"] !== true
  ) {
    panic(`${file}: direct store save is reserved for isolated measurements`);
  }
};

type PinnedStoreRuntimeOptions = {
  steps: Record<string, unknown>[];
  step: Record<string, unknown>;
  caller: string;
};
const assertPinnedStoreRuntime = ({
  steps,
  step,
  caller,
}: PinnedStoreRuntimeOptions) => {
  const setups = steps
    .slice(0, steps.indexOf(step))
    .filter((entry) => String(entry["uses"]).startsWith("oven-sh/setup-bun@"));
  // Every setup pins a package.json runtime: the checkout's, or the copy the
  // trusted tooling fetch holds at workflow_sha for steps that run before the
  // checkout. The setup the store caller actually runs under is the
  // checkout's.
  const pinsPackageJson = (entry: Record<string, unknown>, files: string[]) =>
    isRecord(entry["with"]) &&
    files.includes(String(entry["with"]["bun-version-file"])) &&
    entry["with"]["bun-version"] === undefined;
  const pinnedSetup = setups.at(-1);
  if (
    pinnedSetup === undefined ||
    !pinsPackageJson(pinnedSetup, ["package.json"]) ||
    setups.some(
      (entry) =>
        !pinsPackageJson(entry, [
          "package.json",
          ".workflow-tooling/package.json",
        ]),
    )
  ) {
    panic(
      `${caller}: store callers must share the pinned package.json Bun runtime`,
    );
  }
};

const isDynamicMatrix = (matrix: unknown) =>
  typeof matrix === "string" ||
  (isRecord(matrix) &&
    Object.values(matrix).some(
      (axis) => typeof axis === "string" && axis.includes("needs."),
    ));

/** Every declared platform/mode/ordered-flags key has exactly one writer. */
export const storeSaverCensus = ({
  workflows,
  root,
}: StoreSaverCensusOptions) => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf-8"),
  );
  if (!isRecord(manifest) || typeof manifest["packageManager"] !== "string") {
    panic("Missing pinned Bun runtime identity");
  }
  const revision = manifest["packageManager"];
  const groups = new Map<
    string,
    { scope: string; callers: string[]; savers: string[] }
  >();
  for (const [file, workflow] of Object.entries(workflows)) {
    if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
      continue;
    }
    for (const [name, job] of Object.entries(workflow["jobs"])) {
      if (!isRecord(job) || !Array.isArray(job["steps"])) {
        continue;
      }
      const steps = flattenWorkflowSteps(job["steps"]);
      for (const step of steps) {
        if (
          [
            "$/.github/actions/ci-store-save",
            "./.github/actions/ci-store-save",
          ].includes(String(step["uses"]))
        ) {
          assertMeasurementSave(file, step);
          continue;
        }
        if (
          ![
            "$/.github/actions/ci-install",
            "./.github/actions/ci-install",
          ].includes(String(step["uses"]))
        ) {
          continue;
        }
        const inputs = isRecord(step["with"]) ? step["with"] : {};
        assertPinnedStoreRuntime({ steps, step, caller: `${file}/${name}` });
        const strategy = isRecord(job["strategy"]) ? job["strategy"] : {};
        if (
          isDynamicMatrix(strategy["matrix"]) &&
          inputs["cache-write"] !== undefined
        ) {
          panic(`${file}/${name}: dynamic matrices must only restore stores`);
        }
        for (const row of matrixRows(strategy["matrix"])) {
          if (!canRunOnMain(step["if"], row)) {
            continue;
          }
          const { platform, arch } = platformIdentity(
            resolve(job["runs-on"], row),
          );
          const env = {
            ...(isRecord(workflow["env"]) ? workflow["env"] : {}),
            ...(isRecord(job["env"]) ? job["env"] : {}),
            ...(isRecord(step["env"]) ? step["env"] : {}),
          };
          const mode = resolve(env["BUN_INSTALL_GLOBAL_STORE"], row);
          if (mode !== undefined && typeof mode !== "string") {
            panic(`${file}/${name}: unresolved global-store mode`);
          }
          const globalStoreMode = parseGlobalStoreMode(mode);
          const flags = workflowCiInstallFlags(step);
          const key = completeInstallStoreKey({
            root,
            flags,
            platform,
            arch,
            globalStoreMode,
            revision,
          });
          const caller = `${file}/${name}${Object.keys(row).length === 0 ? "" : ` ${JSON.stringify(row)}`}`;
          let group = groups.get(key);
          if (group === undefined) {
            group = {
              scope: `${platform}/${arch}/${globalStoreMode} ${JSON.stringify(flags)}`,
              callers: [],
              savers: [],
            };
            groups.set(key, group);
          }
          group.callers.push(caller);
          const write = resolve(inputs["cache-write"] ?? "restore", row);
          if (write !== "save" && write !== "restore") {
            panic(`${caller}: unresolved cache-write policy`);
          }
          if (write === "save" && canRunOnMain(job["if"], row)) {
            group.savers.push(caller);
          }
        }
      }
    }
  }
  return [...groups.values()];
};
