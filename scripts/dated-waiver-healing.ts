import { panic, Result, TaggedError } from "better-result";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  createPrivateTaskSink,
  probeSourceFingerprint,
  waiverKey,
  type FixEvidence,
  type RemovalAssessment,
} from "./dated-waiver-fix-task";
import {
  createProbeBudget,
  PROBE_TIMEOUT_MS,
  removeWaiver,
  runWaiverProbe,
} from "./dated-waiver-probes";
import {
  githubRequest,
  listRemovalProposals,
  orphanRemovalProposals,
  type RemovalProposal,
  publishRemoval,
  retireRemoval,
  validateRemovalModules,
} from "./dated-waiver-publish";
import { trackedPolicyFiles } from "./dated-waiver-tracked-files";
import {
  DAY_MS,
  dueWaivers,
  expiryInstant,
  loadWaivers,
  type DatedWaiver,
} from "./dated-waivers";

const OUTPUT_LIMIT = 24_000;
const root = path.resolve(import.meta.dir, "..");

export class HealingError extends TaggedError("HealingError")<{
  message: string;
}> {}

export type HealingEntry = {
  entry: DatedWaiver;
  outcome:
    | { status: "expired" | "unavailable" }
    | {
        status: "green" | "red";
        evidence: FixEvidence;
        files: Record<string, string>;
        baseFiles: Record<string, string>;
      };
};
type HealingReport = {
  sha: string;
  observedAt: string;
  entries: HealingEntry[];
  failures: HealingFailureSummary[];
};
export type HealingActions = {
  openRemoval: (
    record: HealingEntry & {
      outcome: Extract<HealingEntry["outcome"], { evidence: FixEvidence }>;
    },
  ) => Promise<number | undefined>;
  armRemoval: (number: number) => Promise<void>;
  retireRemoval: (entry: DatedWaiver) => Promise<void>;
  assessRemoval: (
    entry: DatedWaiver,
    evidence: FixEvidence,
  ) => Promise<RemovalAssessment>;
  resolveFixTask: (entry: DatedWaiver, evidence: FixEvidence) => Promise<void>;
  openFixTask: (
    entry: DatedWaiver,
    evidence: FixEvidence,
  ) => Promise<{ number: number; state: "open" | "closed" }>;
  findTask: (
    entry: DatedWaiver,
  ) => Promise<{ number: number; state: "open" | "closed" } | undefined>;
  alertExpiry: (task: {
    number: number;
    state: "open" | "closed";
  }) => Promise<void>;
};
const FAILURE_STAGES = {
  probe: "probe",
  evidence: "evidence",
  openFixTask: "openFixTask",
  findTask: "findTask",
  alertExpiry: "alertExpiry",
  retireRemoval: "retireRemoval",
  assessRemoval: "assessRemoval",
  openRemoval: "openRemoval",
  resolveFixTask: "resolveFixTask",
  armRemoval: "armRemoval",
} as const satisfies Record<
  keyof HealingActions | "probe" | "evidence",
  string
>;
export type HealingFailure = {
  key: string;
  stage: keyof typeof FAILURE_STAGES;
  cause: unknown;
};
type HealingFailureSummary = Pick<HealingFailure, "key" | "stage">;
export class HealingRunError extends TaggedError("HealingRunError")<{
  message: string;
  failures: HealingFailure[];
}> {}

type HealEntryOptions = {
  record: HealingEntry;
  actions: HealingActions;
  now: Date;
  failures: HealingFailure[];
};
const healEntry = async ({
  record: { entry, outcome },
  actions,
  now,
  failures,
}: HealEntryOptions): Promise<void> => {
  const attempt = async <T>(
    stage: HealingFailure["stage"],
    action: () => T | Promise<T>,
  ) => {
    const result = await Result.tryPromise({
      try: async () => await action(),
      catch: (cause) => cause,
    });
    if (Result.isError(result)) {
      failures.push({ key: waiverKey(entry), stage, cause: result.error });
    }
    return result;
  };
  // A side effect whose failure `attempt` has already recorded; healing goes on,
  // so callers may ignore whether it succeeded.
  const effect = async (
    stage: HealingFailure["stage"],
    action: () => unknown,
  ): Promise<boolean> => Result.isOk(await attempt(stage, action));
  const checked = await attempt("evidence", () => {
    const at = Date.parse(expiryInstant(entry.expiresAt));
    if (now.getTime() < at && outcome.status === "expired") {
      panic("Expired waiver evidence precedes its owner deadline");
    }
    if (
      now.getTime() < at &&
      outcome.status === "green" &&
      (outcome.evidence.passed !== entry.probe.attempts ||
        outcome.evidence.attempts !== entry.probe.attempts)
    ) {
      panic("Removal requires all declared probes to pass");
    }
    return at;
  });
  if (Result.isError(checked)) {
    await effect("retireRemoval", async () => actions.retireRemoval(entry));
    return;
  }
  const at = checked.value;
  const alert = async (
    task: { number: number; state: "open" | "closed" } | undefined,
  ) => {
    if (task?.state === "open" && now.getTime() >= at - DAY_MS) {
      await effect("alertExpiry", async () => actions.alertExpiry(task));
    }
  };
  const findAndAlert = async () => {
    const task = await attempt("findTask", async () => actions.findTask(entry));
    if (Result.isOk(task)) {
      await alert(task.value);
    }
  };
  // A lapsed entry may only use an existing task; it cannot create a renewal.
  if (now.getTime() >= at) {
    await findAndAlert();
    await effect("retireRemoval", async () => actions.retireRemoval(entry));
    return;
  }
  switch (outcome.status) {
    case "red": {
      const task = await attempt("openFixTask", async () =>
        actions.openFixTask(entry, outcome.evidence),
      );
      await effect("retireRemoval", async () => actions.retireRemoval(entry));
      if (Result.isOk(task)) {
        await alert(task.value);
      } else {
        await findAndAlert();
      }
      return;
    }
    case "green": {
      const assessment = await attempt("assessRemoval", async () =>
        actions.assessRemoval(entry, outcome.evidence),
      );
      if (Result.isError(assessment)) {
        await findAndAlert();
        await effect("retireRemoval", async () => actions.retireRemoval(entry));
        return;
      }
      if (assessment.value.status === "blocked") {
        await alert(assessment.value.task);
        await effect("retireRemoval", async () => actions.retireRemoval(entry));
        return;
      }
      const proposal = await attempt("openRemoval", async () =>
        actions.openRemoval({ entry, outcome }),
      );
      if (Result.isError(proposal)) {
        await effect("retireRemoval", async () => actions.retireRemoval(entry));
        return;
      }
      const resolved = await attempt("resolveFixTask", async () =>
        actions.resolveFixTask(entry, outcome.evidence),
      );
      if (Result.isError(resolved)) {
        await effect("retireRemoval", async () => actions.retireRemoval(entry));
        return;
      }
      const number = proposal.value;
      if (number !== undefined) {
        const armed = await attempt("armRemoval", async () =>
          actions.armRemoval(number),
        );
        if (Result.isError(armed)) {
          await effect("retireRemoval", async () =>
            actions.retireRemoval(entry),
          );
        }
      }
      return;
    }
    case "unavailable":
      await findAndAlert();
      await effect("retireRemoval", async () => actions.retireRemoval(entry));
      return;
    case "expired":
      return;
    default:
      outcome satisfies never;
      return panic("Unhandled healing result");
  }
};

type ApplyHealingOptions = {
  report: HealingReport;
  actions: HealingActions;
  now: Date;
  reconciliation?: {
    discover: () => Promise<readonly RemovalProposal[]>;
    retire: (proposal: RemovalProposal) => Promise<void>;
  };
};
export const applyHealing = async ({
  report,
  actions,
  now,
  reconciliation,
}: ApplyHealingOptions): Promise<void> => {
  const failures: HealingFailure[] = report.failures.map((failure) => ({
    ...failure,
    cause: new HealingError({
      message: "Recorded waiver operation failed; diagnostic output withheld.",
    }),
  }));
  // Preserve every red entry's evidence before considering green publication.
  const pending: HealingEntry[] = [];
  const green: HealingEntry[] = [];
  for (const record of report.entries) {
    const { outcome } = record;
    switch (outcome.status) {
      case "expired":
      case "unavailable":
      case "red":
        pending.push(record);
        break;
      case "green":
        green.push(record);
        break;
      default:
        outcome satisfies never;
        panic("Unhandled healing result");
    }
  }
  const records = [...pending, ...green];
  for (const record of records) {
    const completed = await Result.tryPromise(async () =>
      healEntry({ record, actions, now, failures }),
    );
    if (Result.isError(completed)) {
      failures.push({
        key: waiverKey(record.entry),
        stage: "evidence",
        cause: completed.error,
      });
    }
  }
  if (reconciliation) {
    const discovered = await Result.tryPromise(reconciliation.discover);
    if (Result.isError(discovered)) {
      failures.push({
        key: "evidence-0",
        stage: "evidence",
        cause: discovered.error,
      });
    } else {
      for (const proposal of discovered.value) {
        const retired = await Result.tryPromise(async () =>
          reconciliation.retire(proposal),
        );
        if (Result.isError(retired)) {
          failures.push({
            key: proposal.key,
            stage: "retireRemoval",
            cause: retired.error,
          });
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new HealingRunError({
      message: "Dated waiver operations failed; diagnostic output withheld.",
      failures,
    });
  }
};

export const renderRemovalEvidence = (evidence: FixEvidence): string =>
  [
    "Remove a dated maintenance entry after its declared probe passed.",
    "",
    `Passed: ${evidence.passed}/${evidence.attempts}.`,
    `Command: ${JSON.stringify(evidence.command)}.`,
    `Runner: ${evidence.runner}.`,
    `Commit: ${evidence.sha}.`,
    `Evidence: ${evidence.run}.`,
  ].join("\n");

export const redactProbeOutput = (
  output: string,
  secrets: readonly string[],
): string => {
  let redacted = output;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  return redacted
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/gu,
      "[REDACTED]",
    )
    .slice(0, OUTPUT_LIMIT);
};

const probeSecrets = () =>
  Object.entries(process.env)
    .filter(([name]) =>
      /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL|REDIS_URL/iu.test(name),
    )
    .flatMap(([, value]) => (value ? [value] : []));

const checkedGit = (args: readonly string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new HealingError({
      message: "Isolated probe checkout operation failed; output withheld.",
    });
  }
  return proc.stdout.toString().trim();
};

const boundedOutput = async (
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> => {
  const decoder = new TextDecoder();
  let output = "";
  const drained = await Result.tryPromise(async () =>
    stream.pipeTo(
      new WritableStream({
        write: (chunk) => {
          output = (output + decoder.decode(chunk, { stream: true })).slice(
            -OUTPUT_LIMIT,
          );
        },
      }),
      signal ? { signal } : {},
    ),
  );
  // Cancellation returns the bounded partial diagnostic to the caller, which
  // records timeout as red. pipeTo cancels the stream and releases its lock.
  if (Result.isError(drained) && !signal?.aborted) {
    throw drained.error;
  }
  return output;
};

type ExecuteProbeCommandOptions = {
  command: readonly string[];
  timeoutMs: number;
  cwd: string;
  env: Record<string, string | undefined>;
  secrets: readonly string[];
};
export const executeProbeCommand = async ({
  command,
  timeoutMs,
  cwd,
  env,
  secrets,
}: ExecuteProbeCommandOptions) => {
  const controller = new AbortController();
  const proc = Bun.spawn([...command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  // Bound inherited output pipes as well as the process. Descendants can
  // retain them after the direct command exits.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      boundedOutput(proc.stdout, controller.signal),
      boundedOutput(proc.stderr, controller.signal),
      proc.exited,
    ]);
    const timedOut = controller.signal.aborted || proc.signalCode === "SIGKILL";
    return {
      passed: exit === 0 && !timedOut,
      output: redactProbeOutput(
        `${timedOut ? "Probe attempt timed out.\n" : ""}${stdout}\n${stderr}`,
        secrets,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
};

// Hash the sources actually edited for the probe plus pinned dependencies.
// The target waiver is already removed, so changing its deadline is no fix.
const sourceFingerprint = (
  entry: DatedWaiver,
  files: Record<string, string>,
  checkout: string,
): string => {
  const inputs =
    Object.keys(files).length > 0
      ? { ...files }
      : {
          [entry.source]: readFileSync(
            path.join(checkout, entry.source),
            "utf-8",
          ),
        };
  const dependencies = entry.kind === "no-llms-txt" ? [] : trackedPolicyFiles();
  for (const source of dependencies.filter(
    (candidate) => path.basename(candidate) === "bun.lock",
  )) {
    inputs[source] = readFileSync(path.join(checkout, source), "utf-8");
  }
  return probeSourceFingerprint(inputs);
};

type ProbeEntryOptions = {
  entry: DatedWaiver;
  sha: string;
  budget: ReturnType<typeof createProbeBudget>;
};
const probeEntry = async ({
  entry,
  sha,
  budget,
}: ProbeEntryOptions): Promise<HealingEntry["outcome"]> => {
  const temporary = mkdtempSync(path.join(tmpdir(), "dated-waiver-"));
  const checkout = path.join(temporary, "checkout");
  checkedGit(["worktree", "add", "--detach", checkout, sha]);
  try {
    // Dependencies are read-only shared inputs; every source edit is isolated.
    if (existsSync(path.join(root, "node_modules"))) {
      symlinkSync(
        path.join(root, "node_modules"),
        path.join(checkout, "node_modules"),
        "dir",
      );
    }
    const prepared = Result.try(() =>
      removeWaiver(entry, (source) =>
        readFileSync(path.join(checkout, source), "utf-8"),
      ),
    );
    if (Result.isError(prepared)) {
      return {
        status: "red",
        evidence: {
          attempts: 0,
          passed: 0,
          command: entry.probe.command,
          output:
            "The declared waiver cannot be safely removed for probing. Fix its owner declaration; no probe was run.",
          runner: process.env["RUNNER_OS"] ?? process.platform,
          sha,
          sourceFingerprint: sourceFingerprint(entry, {}, checkout),
          observedAt: new Date().toISOString(),
          run: process.env["GITHUB_RUN_ID"]
            ? `https://github.com/stella/stella/actions/runs/${process.env["GITHUB_RUN_ID"]}`
            : "local",
        },
        files: {},
        baseFiles: {},
      };
    }
    const changes = prepared.value;
    const files = Object.fromEntries(
      changes.map(({ source, after }) => [source, after]),
    );
    const baseFiles = Object.fromEntries(
      changes.map(({ source, before }) => [source, before]),
    );
    validateRemovalModules(files);
    for (const { source, after } of changes) {
      writeFileSync(path.join(checkout, source), after);
    }
    const secrets = probeSecrets();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(PATH|HOME|TMPDIR|TMP|TEMP|SystemRoot|CI|NODE_ENV|NO_COLOR|GITHUB_REPOSITORY)$/u.test(
          name,
        ),
      ),
    );
    const result = await runWaiverProbe(entry, {
      run: async (command) =>
        budget.run(command, async ({ command: executable, timeoutMs }) =>
          executeProbeCommand({
            command: executable,
            timeoutMs,
            cwd: checkout,
            env,
            secrets,
          }),
        ),
    });
    const evidence = {
      attempts: result.attempts,
      passed: result.passed,
      command: result.command,
      output: result.output,
      runner: process.env["RUNNER_OS"] ?? process.platform,
      sha,
      sourceFingerprint: sourceFingerprint(entry, files, checkout),
      observedAt: new Date().toISOString(),
      run: process.env["GITHUB_RUN_ID"]
        ? `https://github.com/stella/stella/actions/runs/${process.env["GITHUB_RUN_ID"]}`
        : "local",
    };
    return { status: result.status, evidence, files, baseFiles };
  } finally {
    checkedGit(["worktree", "remove", "--force", checkout]);
    rmSync(temporary, { recursive: true, force: true });
  }
};

type CollectProbeOptions = {
  due: readonly DatedWaiver[];
  sha: string;
  now: Date;
  probe: (entry: DatedWaiver) => Promise<HealingEntry["outcome"]>;
  failedProbe: (entry: DatedWaiver, cause: unknown) => HealingEntry["outcome"];
};
export const collectProbeReport = async ({
  due,
  sha,
  now,
  probe,
  failedProbe,
}: CollectProbeOptions): Promise<HealingReport> => {
  const entries: HealingEntry[] = [];
  const failures: HealingFailureSummary[] = [];
  for (const entry of due) {
    const outcome = await Result.tryPromise(async () =>
      now.getTime() >= Date.parse(expiryInstant(entry.expiresAt))
        ? { status: "expired" as const }
        : probe(entry),
    );
    if (Result.isOk(outcome)) {
      entries.push({ entry, outcome: outcome.value });
      continue;
    }
    failures.push({ key: waiverKey(entry), stage: "probe" });
    const fallback = Result.try(() => failedProbe(entry, outcome.error));
    if (Result.isError(fallback)) {
      failures.push({ key: waiverKey(entry), stage: "evidence" });
      entries.push({ entry, outcome: { status: "unavailable" } });
    } else {
      entries.push({ entry, outcome: fallback.value });
    }
  }
  return { sha, observedAt: now.toISOString(), entries, failures };
};

const failureSchema = v.object({
  key: v.pipe(v.string(), v.regex(/^(?:[a-f0-9]{24}|evidence-[0-9]+)$/u)),
  stage: v.picklist(Object.values(FAILURE_STAGES)),
});
const reportSchema = v.object({
  sha: v.string(),
  observedAt: v.string(),
  failures: v.array(failureSchema),
  entries: v.array(v.unknown()),
});
const entrySchema = v.object({
  entry: v.object({
    source: v.string(),
    line: v.number(),
    id: v.string(),
    kind: v.string(),
    expiresAt: v.string(),
  }),
  outcome: v.unknown(),
});

type ReportAuthorities = {
  loadInventory: () => Promise<readonly DatedWaiver[]>;
  checkoutSha: () => string;
  readOwner: (source: string) => string;
  fingerprint: (entry: DatedWaiver, files: Record<string, string>) => string;
};
const REPORT_AUTHORITIES = {
  loadInventory: loadWaivers,
  checkoutSha: () => checkedGit(["rev-parse", "HEAD"]),
  readOwner: (source) => readFileSync(path.join(root, source), "utf-8"),
  fingerprint: (entry, files) => sourceFingerprint(entry, files, root),
} satisfies ReportAuthorities;

// Re-bind runner-local evidence to current owner entries. Serialized input never
// decides executable commands, branch names, deadlines, or file paths.
export const readReport = async (
  file: string,
  authorities: ReportAuthorities = REPORT_AUTHORITIES,
): Promise<HealingReport> => {
  const parsed = v.parse(reportSchema, JSON.parse(readFileSync(file, "utf-8")));
  const current = await authorities.loadInventory();
  if (parsed.sha !== authorities.checkoutSha()) {
    panic("Evidence checkout SHA mismatch");
  }
  const entries: HealingEntry[] = [];
  const failures = [...parsed.failures];
  for (const [index, raw] of parsed.entries.entries()) {
    let owner: DatedWaiver | undefined;
    const checked = Result.try((): HealingEntry => {
      const { entry, outcome } = v.parse(entrySchema, raw);
      owner = current.find(
        (candidate) =>
          candidate.source === entry.source &&
          candidate.kind === entry.kind &&
          candidate.id === entry.id,
      );
      if (!owner || owner.expiresAt !== entry.expiresAt) {
        panic("Waiver evidence no longer matches owner");
      }
      const result = v.parse(
        v.variant("status", [
          v.object({ status: v.picklist(["expired", "unavailable"]) }),
          v.object({
            status: v.picklist(["green", "red"]),
            evidence: v.object({
              attempts: v.number(),
              passed: v.number(),
              command: v.array(v.string()),
              output: v.string(),
              runner: v.string(),
              sha: v.string(),
              sourceFingerprint: v.string(),
              observedAt: v.pipe(v.string(), v.isoTimestamp()),
              run: v.string(),
            }),
            files: v.record(v.string(), v.string()),
            baseFiles: v.record(v.string(), v.string()),
          }),
        ]),
        outcome,
      );
      switch (result.status) {
        case "expired":
        case "unavailable":
          return { entry: owner, outcome: result };
        case "green":
        case "red":
          break;
        default:
          result satisfies never;
          return panic("Unhandled healing result");
      }
      if (
        JSON.stringify(result.evidence.command) !==
          JSON.stringify(owner.probe.command) ||
        result.evidence.sha !== parsed.sha ||
        result.evidence.sourceFingerprint !==
          authorities.fingerprint(owner, result.files)
      ) {
        panic("Evidence probe does not match owner");
      }
      if (result.status === "green" || Object.keys(result.files).length > 0) {
        const changes = removeWaiver(owner, authorities.readOwner);
        if (
          JSON.stringify(result.files) !==
            JSON.stringify(
              Object.fromEntries(
                changes.map(({ source, after }) => [source, after]),
              ),
            ) ||
          JSON.stringify(result.baseFiles) !==
            JSON.stringify(
              Object.fromEntries(
                changes.map(({ source, before }) => [source, before]),
              ),
            )
        ) {
          panic("Removal evidence does not match owner edit");
        }
      }
      return { entry: owner, outcome: result };
    });
    if (Result.isError(checked)) {
      failures.push({
        key: owner ? waiverKey(owner) : `evidence-${index}`,
        stage: "evidence",
      });
      if (owner) {
        entries.push({ entry: owner, outcome: { status: "unavailable" } });
      }
    } else {
      entries.push(checked.value);
      if (
        checked.value.outcome.status === "unavailable" &&
        !failures.some(({ key }) => key === waiverKey(checked.value.entry))
      ) {
        failures.push({
          key: waiverKey(checked.value.entry),
          stage: "evidence",
        });
      }
    }
  }
  return { sha: parsed.sha, observedAt: parsed.observedAt, entries, failures };
};

const runMergeBar = async (
  number: number,
  mode: "arm" | "disarm",
): Promise<number> => {
  const command = ["bun", "scripts/merge-bar.ts", "--repo", "stella/stella"];
  if (mode === "disarm") {
    command.push("--disarm");
  }
  command.push(String(number));
  const proc = Bun.spawn(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const execution = await Promise.all([
    boundedOutput(proc.stdout),
    boundedOutput(proc.stderr),
    proc.exited,
  ]);
  return execution[2];
};

export const armRemovalThroughBar = async (
  number: number,
  run = runMergeBar,
) => {
  const exit = await run(number, "arm");
  // The ordinary bar permits pending checks. Every nonzero exit is a real
  // refusal or failure, and must fail the scheduled publication boundary.
  if (exit !== 0) {
    throw new HealingError({
      message:
        "Removal merge bar refused or failed; diagnostic output withheld.",
    });
  }
  return { signal: "dated-waiver-armed", pr: number } as const;
};

export const disarmRemovalThroughBar = async (
  number: number,
  run = runMergeBar,
): Promise<void> => {
  if ((await run(number, "disarm")) !== 0) {
    throw new HealingError({
      message: "Removal disarm refused or failed; diagnostic output withheld.",
    });
  }
};

export const renderHealingFailureSignal = (error: HealingRunError) => ({
  signal: "dated-waiver-failed",
  failures: error.failures.map(({ key, stage }) => ({ key, stage })),
});

export const healingWriteNeeded = (
  report: HealingReport,
  orphanProposals: readonly RemovalProposal[] = [],
) =>
  report.entries.length > 0 ||
  report.failures.length > 0 ||
  orphanProposals.length > 0;

const discoverOrphanRemovals = async (inventory: readonly DatedWaiver[]) =>
  orphanRemovalProposals(
    inventory,
    await listRemovalProposals({
      repo: "stella/stella",
      request: githubRequest,
    }),
  );

const main = async (): Promise<void> => {
  const fileIndex = process.argv.indexOf("--evidence");
  const file = process.argv.at(fileIndex + 1);
  if (fileIndex === -1 || !file) {
    panic("Runner-local --evidence path required");
  }
  if (process.argv.includes("--probe")) {
    const sha = checkedGit(["rev-parse", "HEAD"]);
    const now = new Date();
    const inventory = loadWaivers(trackedPolicyFiles());
    const due = dueWaivers(inventory, now);
    const budget = createProbeBudget({
      attempts: due
        .filter(
          (entry) => now.getTime() < Date.parse(expiryInstant(entry.expiresAt)),
        )
        .reduce((count, entry) => count + entry.probe.attempts, 0),
    });
    const report = await collectProbeReport({
      due,
      sha,
      now,
      probe: async (entry) => probeEntry({ entry, sha, budget }),
      failedProbe: (entry, cause) => ({
        status: "red",
        evidence: {
          attempts: 0,
          passed: 0,
          command: entry.probe.command,
          output: redactProbeOutput(
            `Probe setup or cleanup failed; no complete successful probe was recorded.\n${String(cause)}`,
            probeSecrets(),
          ),
          runner: process.env["RUNNER_OS"] ?? process.platform,
          sha,
          sourceFingerprint: sourceFingerprint(entry, {}, root),
          observedAt: new Date().toISOString(),
          run: process.env["GITHUB_RUN_ID"]
            ? `https://github.com/stella/stella/actions/runs/${process.env["GITHUB_RUN_ID"]}`
            : "local",
        },
        files: {},
        baseFiles: {},
      }),
    });
    // Discovery uses the read-only workflow token and the full inventory, even
    // when no entries are due. A failed discovery remains a recorded run failure.
    const discovered = await Result.tryPromise(async () =>
      discoverOrphanRemovals(inventory),
    );
    if (Result.isError(discovered)) {
      report.failures.push({ key: "evidence-0", stage: "evidence" });
    }
    const orphans = Result.isOk(discovered) ? discovered.value : [];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report), { mode: 0o600 });
    const output = process.env["GITHUB_OUTPUT"];
    if (output) {
      appendFileSync(
        output,
        `write_needed=${healingWriteNeeded(report, orphans)}\n`,
      );
    }
    console.log(
      JSON.stringify({
        signal: "dated-waiver-probed",
        entries: report.entries.length,
      }),
    );
    return;
  }
  if (
    !process.argv.includes("--publish") ||
    process.env["GITHUB_REPOSITORY"] !== "stella/stella"
  ) {
    panic("Publishing requires the scheduled repository workflow");
  }
  const report = await readReport(file);
  const inventory = loadWaivers(trackedPolicyFiles());
  // Re-read proposals on the write path: runner evidence never supplies branch
  // names or authority to retire a proposal.
  const discovered = await Result.tryPromise(async () =>
    discoverOrphanRemovals(inventory),
  );
  if (
    Result.isOk(discovered) &&
    !healingWriteNeeded(report, discovered.value)
  ) {
    return;
  }
  const privateRepo = process.env["DATED_WAIVER_FIX_REPO"];
  if (!privateRepo) {
    panic("Private fix task repository required");
  }
  const sink = await createPrivateTaskSink({
    repo: privateRepo,
    request: githubRequest,
  });
  await applyHealing({
    report,
    now: new Date(),
    reconciliation: {
      discover: async () =>
        await (Result.isError(discovered)
          ? Promise.reject(discovered.error)
          : Promise.resolve(discovered.value)),
      retire: async ({ branch }) =>
        retireRemoval({
          branch,
          repo: "stella/stella",
          request: githubRequest,
          disarm: disarmRemovalThroughBar,
        }),
    },
    actions: {
      ...sink,
      openRemoval: async ({ entry, outcome }) =>
        publishRemoval({
          branch: `chore/dated-waiver-${waiverKey(entry)}`,
          baseSha: report.sha,
          baseFiles: outcome.baseFiles,
          files: outcome.files,
          body: renderRemovalEvidence(outcome.evidence),
          repo: process.env["GITHUB_REPOSITORY"],
          request: githubRequest,
        }),
      retireRemoval: async (entry) =>
        retireRemoval({
          branch: `chore/dated-waiver-${waiverKey(entry)}`,
          repo: "stella/stella",
          request: githubRequest,
          disarm: disarmRemovalThroughBar,
        }),
      armRemoval: async (number) => {
        if (process.env["MERGE_HOLD"]) {
          return;
        }
        console.log(JSON.stringify(await armRemovalThroughBar(number)));
      },
    },
  });
};

export const runHealingBoundary = async (run: () => Promise<void>) => {
  const result = await Result.tryPromise({ try: run, catch: (cause) => cause });
  if (Result.isOk(result)) {
    return { status: "complete", exitCode: 0 } as const;
  }
  return {
    status: "failed",
    exitCode: 1,
    output:
      result.error instanceof HealingRunError
        ? JSON.stringify(renderHealingFailureSignal(result.error))
        : "Dated waiver healing failed; diagnostic output withheld.",
  } as const;
};

if (import.meta.main) {
  const completed = await runHealingBoundary(main);
  process.exitCode = completed.exitCode;
  if (completed.status === "failed") {
    console.error(completed.output);
  }
}
