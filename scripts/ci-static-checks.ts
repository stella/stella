import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { generatedInputTreeHash } from "../packages/scripts/src/generated-input-identity";
import { createSha256, sha256Hex } from "../packages/sha256/src/bun";
import { CANONICAL_CANCEL_STEP } from "./ci-cancellation-contract";
import {
  CHECK_POOL_JOBS,
  checkPoolResultsPath,
} from "./ci-check-pool-registry";
import {
  completeInstallStoreKey,
  parseGlobalStoreMode,
} from "./ci-install-store";
import {
  isWorkflowBarrier,
  workflowCiInstallFlags,
  workflowJobSteps,
} from "./workflow-steps";

const INPUT_CLOSURE = "tracked-tree+generated-inputs";
const MAX_RECEIPT_BYTES = 65_536;
const MAX_RECEIPT_CANDIDATES = 5;
const RECEIPT_OPERATION_TIMEOUT_MS = 10_000;
export const STATIC_RECEIPT_STEP_NAMES = [
  "Resolve static check receipts",
  "Record static check receipts",
  "Publish static check receipts",
] as const;

class StaticCheckError extends Error {
  override name = "StaticCheckError";
  readonly _tag = "StaticCheckError";
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const staticReuseOutputName = (id: string) => `reuse_${id}`;

export const staticReuseCondition = (id: string) =>
  ` && (github.event_name == 'merge_group' || steps.static_receipts.outputs.${staticReuseOutputName(id)} != 'true')`;

export const classifiedChecks = (workflow: unknown, job: string) => {
  const steps = workflowJobSteps(workflow, job).map((step) => {
    if (step["name"] !== CANONICAL_CANCEL_STEP.name) {
      return step;
    }
    if (
      !record(workflow) ||
      !record(workflow["jobs"]) ||
      !record(workflow["jobs"][job])
    ) {
      throw new StaticCheckError("Missing cancellation partition declaration");
    }
    const env = workflow["jobs"][job]["env"];
    if (
      !record(env) ||
      env["CI_CANCELLATION_KIND"] !== "CONTEXTUAL" ||
      typeof env["CI_CANCELLATION_CONTEXT"] !== "string"
    ) {
      throw new StaticCheckError("Unclassified cancellation task");
    }
    const classified = { ...step };
    classified["env"] = {
      CI_CHECK_KIND: env["CI_CANCELLATION_KIND"],
      CI_CHECK_CONTEXT: env["CI_CANCELLATION_CONTEXT"],
    };
    return classified;
  });
  return steps.filter((step) => {
    if (
      isWorkflowBarrier(step) ||
      STATIC_RECEIPT_STEP_NAMES.some((name) => name === step["name"])
    ) {
      return false;
    }
    const env = step["env"];
    if (
      !record(env) ||
      !["STATIC", "CONTEXTUAL"].includes(String(env["CI_CHECK_KIND"]))
    ) {
      throw new StaticCheckError(
        `Unclassified CI check: ${job}/${String(step["name"])}`,
      );
    }
    if (
      env["CI_CHECK_KIND"] === "STATIC" &&
      (env["CI_CHECK_INPUTS"] !== INPUT_CLOSURE ||
        typeof step["id"] !== "string" ||
        typeof step["run"] !== "string")
    ) {
      throw new StaticCheckError(
        `Static CI check has no input closure or command: ${String(step["name"])}`,
      );
    }
    if (
      env["CI_CHECK_KIND"] === "CONTEXTUAL" &&
      typeof env["CI_CHECK_CONTEXT"] !== "string"
    ) {
      throw new StaticCheckError(
        `Contextual CI check has no reason: ${String(step["name"])}`,
      );
    }
    return true;
  });
};

type StaticKeyOptions = {
  inputHash: string;
  toolchain: unknown;
  definition: unknown;
};
export const staticCheckKey = ({
  inputHash,
  toolchain,
  definition,
}: StaticKeyOptions) =>
  sha256Hex(JSON.stringify({ version: 1, inputHash, toolchain, definition }));

type ReuseOptions = {
  event: string;
  ref: string;
  kind: string;
  key: string;
  runId: number;
  receipt: unknown;
};
export const reusableStaticReceipt = ({
  event,
  ref,
  kind,
  key,
  runId,
  receipt,
}: ReuseOptions) => {
  if (
    kind !== "STATIC" ||
    event === "merge_group" ||
    ref !== "refs/heads/main" ||
    !["schedule", "workflow_dispatch", "workflow_call", "push"].includes(event)
  ) {
    return false;
  }
  return (
    record(receipt) &&
    receipt["key"] === key &&
    receipt["runId"] === runId &&
    receipt["status"] === "passed"
  );
};

type TrustedQueueRunOptions = {
  raw: unknown;
  repository: string;
  runId: number;
};
export const trustedQueueRun = ({
  raw,
  repository,
  runId,
}: TrustedQueueRunOptions) =>
  record(raw) &&
  raw["id"] === runId &&
  raw["event"] === "merge_group" &&
  raw["path"] === ".github/workflows/ci.yml" &&
  raw["status"] === "completed" &&
  raw["conclusion"] === "success" &&
  record(raw["repository"]) &&
  typeof raw["repository"]["id"] === "number" &&
  Number.isSafeInteger(raw["repository"]["id"]) &&
  raw["repository"]["id"] > 0 &&
  raw["repository"]["full_name"] === repository &&
  record(raw["head_repository"]) &&
  raw["head_repository"]["id"] === raw["repository"]["id"];

type PassedStaticChecksOptions = {
  keys: Record<string, string>;
  outcomes: unknown;
  runId: number;
};
export const passedStaticChecks = ({
  keys,
  outcomes,
  runId,
}: PassedStaticChecksOptions) => {
  if (!record(outcomes) || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new StaticCheckError("Invalid static check outcomes");
  }
  return Object.fromEntries(
    Object.entries(keys).flatMap(([id, key]) => {
      const step = outcomes[id];
      return record(step) &&
        step["outcome"] === "success" &&
        step["conclusion"] === "success"
        ? [[id, { status: "passed", key, runId }]]
        : [];
    }),
  );
};

const command = (args: string[]) => {
  const child = Bun.spawnSync(args, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: RECEIPT_OPERATION_TIMEOUT_MS,
  });
  if (child.exitCode !== 0) {
    throw new StaticCheckError(
      `Receipt operation failed: ${String(args.at(0))}`,
    );
  }
  return child.stdout.toString().trim();
};
const toolchainIdentity = () => {
  const image = process.env["ImageOS"];
  const imageVersion = process.env["ImageVersion"];
  if (!image || !imageVersion) {
    throw new StaticCheckError("Unresolved runner image");
  }
  return {
    bun: command(["bun", "--revision"]),
    platform: process.platform,
    arch: process.arch,
    image,
    imageVersion,
    bash: command(["bash", "--version"]),
    git: command(["git", "--version"]),
    python: command(["python3", "--version"]),
    node: command(["node", "--version"]),
    rustfmt: command(["rustfmt", "--version"]),
    cargo: command(["cargo", "--version"]),
    // bun.lock is part of the closure: it records every resolved compiler,
    // native dependency and generator version even before installation.
  };
};

const identity = (root: string, workflow: unknown, job: string) => {
  const checks = classifiedChecks(workflow, job);
  const install = checks.find((step) => step["id"] === "install");
  if (!install) {
    throw new StaticCheckError("Missing shared CI install definition");
  }
  const toolchain = {
    ...toolchainIdentity(),
    installStore: completeInstallStoreKey({
      root,
      flags: workflowCiInstallFlags(install),
      globalStoreMode: parseGlobalStoreMode(
        process.env["BUN_INSTALL_GLOBAL_STORE"],
      ),
    }),
  };
  const inputHash = generatedInputTreeHash({
    root,
    toolchain,
    generatedOutputs: "tracked",
    createHasher: createSha256,
    hashFile: sha256Hex,
    onFailure: (message) => {
      throw new StaticCheckError(message);
    },
  });
  if (
    !record(workflow) ||
    !record(workflow["jobs"]) ||
    !record(workflow["jobs"][job])
  ) {
    throw new StaticCheckError("Missing static check job definition");
  }
  const jobDefinition = workflow["jobs"][job];
  const keys = Object.fromEntries(
    checks.flatMap((step) => {
      const env = step["env"];
      if (!record(env) || env["CI_CHECK_KIND"] !== "STATIC") {
        return [];
      }
      return [
        [
          String(step["id"]),
          staticCheckKey({
            inputHash,
            toolchain,
            definition: {
              step,
              env: workflow["env"],
              defaults: workflow["defaults"],
              jobEnv: jobDefinition["env"],
              runner: jobDefinition["runs-on"],
            },
          }),
        ],
      ];
    }),
  );
  return { inputHash, keys, bundleKey: sha256Hex(JSON.stringify(keys)) };
};

const github = (...args: string[]) =>
  command(["bash", "scripts/gh-retry.sh", ...args]);
const json = (source: string): unknown => JSON.parse(source);

type ResolveStaticReuseOptions = {
  event: string;
  ref: string;
  keys: Record<string, string>;
  bundleKey: string;
  download: () => { runId: number; raw: unknown } | undefined;
};
export const resolveStaticReuse = ({
  event,
  ref,
  keys,
  bundleKey,
  download,
}: ResolveStaticReuseOptions) => {
  if (
    event === "merge_group" ||
    ref !== "refs/heads/main" ||
    !["schedule", "workflow_dispatch", "workflow_call", "push"].includes(event)
  ) {
    return { status: "available", reused: [] } as const;
  }
  // External receipt boundary, used before dependency installation. Fully
  // resolve and validate before publishing any outputs that can skip work.
  try {
    const source = download();
    if (
      !source ||
      !record(source.raw) ||
      source.raw["bundleKey"] !== bundleKey ||
      !record(source.raw["tasks"])
    ) {
      return { status: "available", reused: [] } as const;
    }
    const tasks = source.raw["tasks"];
    const reused = Object.entries(keys).flatMap(([id, key]) =>
      reusableStaticReceipt({
        event,
        ref,
        kind: "STATIC",
        key,
        runId: source.runId,
        receipt: tasks[id],
      })
        ? [{ id, key, runId: source.runId }]
        : [],
    );
    return { status: "available", reused } as const;
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "invalid receipt",
    } as const;
  }
};

// Same transport and provenance contract as completed suite depth: an exact
// artifact name plus a successful producing workflow, never a cache hit alone.
type DownloadReceiptOptions = {
  name: string;
  destination: string;
  repository: string;
  request?: (...args: string[]) => string;
};
export const downloadReceipt = ({
  name,
  destination,
  repository,
  request = github,
}: DownloadReceiptOptions) => {
  const listing = json(
    request(
      "api",
      `repos/${repository}/actions/artifacts?name=${name}&per_page=${MAX_RECEIPT_CANDIDATES}`,
    ),
  );
  if (!record(listing) || !Array.isArray(listing["artifacts"])) {
    return undefined;
  }
  for (const artifact of listing["artifacts"].slice(
    0,
    MAX_RECEIPT_CANDIDATES,
  )) {
    if (
      !record(artifact) ||
      artifact["name"] !== name ||
      artifact["expired"] !== false ||
      typeof artifact["size_in_bytes"] !== "number" ||
      artifact["size_in_bytes"] <= 0 ||
      artifact["size_in_bytes"] > MAX_RECEIPT_BYTES ||
      !record(artifact["workflow_run"])
    ) {
      continue;
    }
    const runId = artifact["workflow_run"]["id"];
    if (
      typeof runId !== "number" ||
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      String(runId) === process.env["GITHUB_RUN_ID"]
    ) {
      continue;
    }
    try {
      const run = json(
        request("api", `repos/${repository}/actions/runs/${runId}`),
      );
      if (!trustedQueueRun({ raw: run, repository, runId })) {
        continue;
      }
      rmSync(destination, { recursive: true, force: true });
      request(
        "run",
        "download",
        String(runId),
        "--repo",
        repository,
        "--name",
        name,
        "--dir",
        destination,
      );
      const raw = json(
        readFileSync(path.join(destination, "receipt.json"), "utf-8"),
      );
      return { runId, raw };
    } catch (error) {
      console.log(
        `Static receipt candidate ${String(runId)} unavailable: ${error instanceof Error ? error.message : "invalid receipt"}`,
      );
      continue;
    }
  }
  return undefined;
};

const output = (contents: string) => {
  const filename = process.env["GITHUB_OUTPUT"];
  if (filename) {
    writeFileSync(filename, contents, { flag: "a" });
  }
};

type PublishStaticReuseOptions = ResolveStaticReuseOptions & {
  readonly writeOutput: (contents: string) => void;
};

export const publishStaticReuse = ({
  writeOutput,
  ...options
}: PublishStaticReuseOptions) => {
  const resolved = resolveStaticReuse(options);
  switch (resolved.status) {
    case "unavailable":
      console.log(`Static check receipt unavailable: ${resolved.message}`);
      return;
    case "available":
      writeOutput(
        resolved.reused
          .map(({ id }) => `${staticReuseOutputName(id)}=true\n`)
          .join(""),
      );
      for (const { key, runId } of resolved.reused) {
        console.log(`reused ${key} from run ${runId}`);
      }
      return;
    default:
      resolved satisfies never;
      throw new StaticCheckError("Unknown receipt resolution");
  }
};

const main = () => {
  const mode = process.argv.at(2);
  const job = process.argv.at(3) ?? "";
  const root = process.cwd();
  const directory = path.join(
    process.env["RUNNER_TEMP"] ?? root,
    `static-checks-${job}`,
  );
  mkdirSync(directory, { recursive: true });
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(".github/workflows/ci.yml", "utf-8"),
  );
  if (mode === "resolve") {
    const expected = identity(root, workflow, job);
    const name = `ci-static-v1-${job}-${expected.bundleKey}`;
    writeFileSync(
      path.join(directory, "identity.json"),
      JSON.stringify(expected),
    );
    output(`artifact_name=${name}\n`);
    const event = process.env["GITHUB_EVENT_NAME"] ?? "";
    const ref = process.env["GITHUB_REF"] ?? "";
    publishStaticReuse({
      writeOutput: output,
      event,
      ref,
      keys: expected.keys,
      bundleKey: expected.bundleKey,
      download: () =>
        downloadReceipt({
          name,
          destination: path.join(directory, "download"),
          repository: process.env["GITHUB_REPOSITORY"] ?? "",
        }),
    });
    return;
  }
  if (mode !== "record") {
    throw new StaticCheckError("Expected resolve or record");
  }
  if (process.env["GITHUB_EVENT_NAME"] !== "merge_group") {
    return;
  }
  const expected = identity(root, workflow, job);
  const before = json(
    readFileSync(path.join(directory, "identity.json"), "utf-8"),
  );
  if (!record(before) || before["bundleKey"] !== expected.bundleKey) {
    throw new StaticCheckError("Static checks changed their input closure");
  }
  const stepOutcomes = json(process.env["CHECK_OUTCOMES"] ?? "{}");
  // Pooled checks are not workflow steps; their pool records the outcomes.
  const pool = CHECK_POOL_JOBS.find((known) => known === job);
  const poolResults =
    pool === undefined
      ? undefined
      : checkPoolResultsPath(pool, process.env["RUNNER_TEMP"] ?? root);
  const poolOutcomes =
    poolResults !== undefined && existsSync(poolResults)
      ? json(readFileSync(poolResults, "utf-8"))
      : {};
  const outcomes =
    record(stepOutcomes) && record(poolOutcomes)
      ? { ...stepOutcomes, ...poolOutcomes }
      : undefined;
  const runId = Number(process.env["GITHUB_RUN_ID"]);
  const tasks = passedStaticChecks({ keys: expected.keys, outcomes, runId });
  const destination = path.join(directory, "upload");
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    path.join(destination, "receipt.json"),
    JSON.stringify({ bundleKey: expected.bundleKey, tasks }),
  );
  output("recorded=true\n");
};

export const runStaticReceiptBoundary = (
  operation: () => void,
  report: (message: string) => void = console.log,
) => {
  // Receipts are an optimization. Any parsing, IO, toolchain or transport
  // failure leaves every check running and publishes no new evidence.
  try {
    operation();
  } catch (error) {
    const message = (error instanceof Error ? error.message : "invalid receipt")
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    report(
      `::warning::Static check receipts disabled; checks run fresh: ${message}`,
    );
  }
};

if (import.meta.main) {
  runStaticReceiptBoundary(main);
}
