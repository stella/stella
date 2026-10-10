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
import { removeWaiver, runWaiverProbe } from "./dated-waiver-probes";
import {
  githubRequest,
  publishRemoval,
  validateRemovalModules,
} from "./dated-waiver-publish";
import {
  DAY_MS,
  dueWaivers,
  expiryInstant,
  loadWaivers,
  trackedPolicyFiles,
  type DatedWaiver,
} from "./dated-waivers";

const PROBE_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 24_000;
const root = path.resolve(import.meta.dir, "..");

export class HealingError extends TaggedError("HealingError")<{
  message: string;
}> {}

export type HealingEntry = {
  entry: DatedWaiver;
  outcome:
    | { status: "expired" }
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
};
type HealingActions = {
  openRemoval: (
    record: HealingEntry & {
      outcome: Extract<HealingEntry["outcome"], { evidence: FixEvidence }>;
    },
  ) => Promise<number | undefined>;
  armRemoval: (number: number) => Promise<void>;
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
type ApplyHealingOptions = {
  report: HealingReport;
  actions: HealingActions;
  now: Date;
};
export const applyHealing = async ({
  report,
  actions,
  now,
}: ApplyHealingOptions): Promise<void> => {
  for (const { entry, outcome } of report.entries) {
    const at = Date.parse(expiryInstant(entry.expiresAt));
    // Publishing may cross the owner's deadline after probing. Every stale
    // outcome lapses; only an existing unresolved task may emit the alert.
    if (now.getTime() >= at) {
      const task = await actions.findTask(entry);
      if (task?.state === "open") {
        await actions.alertExpiry(task);
      }
      continue;
    }
    switch (outcome.status) {
      case "green": {
        if (
          outcome.evidence.passed !== entry.probe.attempts ||
          outcome.evidence.attempts !== entry.probe.attempts
        ) {
          panic("Removal requires all declared probes to pass");
        }
        const assessment = await actions.assessRemoval(entry, outcome.evidence);
        if (assessment.status === "blocked") {
          if (
            now.getTime() >= at - DAY_MS &&
            assessment.task.state === "open"
          ) {
            await actions.alertExpiry(assessment.task);
          }
          break;
        }
        const number = await actions.openRemoval({ entry, outcome });
        await actions.resolveFixTask(entry, outcome.evidence);
        if (number !== undefined) {
          await actions.armRemoval(number);
        }
        break;
      }
      case "red": {
        const task = await actions.openFixTask(entry, outcome.evidence);
        if (now.getTime() >= at - DAY_MS && task.state === "open") {
          await actions.alertExpiry(task);
        }
        break;
      }
      case "expired": {
        return panic("Expired waiver evidence precedes its owner deadline");
      }
      default: {
        outcome satisfies never;
        panic("Unhandled healing result");
      }
    }
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
): Promise<string> => {
  const decoder = new TextDecoder();
  let output = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      // Keep the terminal receipt even when a test emits many diagnostics.
      output = (output + decoder.decode(chunk.value, { stream: true })).slice(
        -OUTPUT_LIMIT,
      );
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return output;
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

const probeEntry = async (
  entry: DatedWaiver,
  sha: string,
): Promise<HealingEntry["outcome"]> => {
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
    const secrets = Object.entries(process.env)
      .filter(([name]) =>
        /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL|REDIS_URL/iu.test(name),
      )
      .flatMap(([, value]) => (value ? [value] : []));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(PATH|HOME|TMPDIR|TMP|TEMP|SystemRoot|CI|NODE_ENV|NO_COLOR|GITHUB_REPOSITORY)$/u.test(
          name,
        ),
      ),
    );
    const result = await runWaiverProbe(entry, {
      run: async (command) => {
        const proc = Bun.spawn([...command], {
          cwd: checkout,
          env,
          stdout: "pipe",
          stderr: "pipe",
          timeout: PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        const [stdout, stderr, exit] = await Promise.all([
          boundedOutput(proc.stdout),
          boundedOutput(proc.stderr),
          proc.exited,
        ]);
        return {
          passed: exit === 0,
          output: redactProbeOutput(`${stdout}\n${stderr}`, secrets),
        };
      },
    });
    const evidence = {
      attempts: result.attempts,
      passed: result.passed,
      command: result.command,
      output: result.output,
      runner: process.env["RUNNER_OS"] ?? process.platform,
      sha,
      sourceFingerprint: sourceFingerprint(entry, files, checkout),
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

const reportSchema = v.object({
  sha: v.string(),
  observedAt: v.string(),
  entries: v.array(
    v.object({
      entry: v.object({
        source: v.string(),
        line: v.number(),
        id: v.string(),
        kind: v.string(),
        expiresAt: v.string(),
      }),
      outcome: v.unknown(),
    }),
  ),
});

// Re-bind runner-local evidence to current owner entries. Serialized input never
// decides executable commands, branch names, deadlines, or file paths.
const readReport = async (file: string): Promise<HealingReport> => {
  const parsed = v.parse(reportSchema, JSON.parse(readFileSync(file, "utf-8")));
  const current = await loadWaivers();
  const entries = parsed.entries.map(({ entry, outcome }): HealingEntry => {
    const owner = current.find(
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
        v.object({ status: v.literal("expired") }),
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
            run: v.string(),
          }),
          files: v.record(v.string(), v.string()),
          baseFiles: v.record(v.string(), v.string()),
        }),
      ]),
      outcome,
    );
    if (result.status !== "expired") {
      if (
        JSON.stringify(result.evidence.command) !==
          JSON.stringify(owner.probe.command) ||
        result.evidence.sha !== parsed.sha ||
        result.evidence.sourceFingerprint !==
          sourceFingerprint(owner, result.files, root)
      ) {
        panic("Evidence probe does not match owner");
      }
      if (result.status === "green" || Object.keys(result.files).length > 0) {
        const changes = removeWaiver(owner, (source) =>
          readFileSync(path.join(root, source), "utf-8"),
        );
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
    }
    return { entry: owner, outcome: result };
  });
  if (parsed.sha !== checkedGit(["rev-parse", "HEAD"])) {
    panic("Evidence checkout SHA mismatch");
  }
  return { sha: parsed.sha, observedAt: parsed.observedAt, entries };
};

const runMergeBar = async (number: number): Promise<number> => {
  const proc = Bun.spawn(["bun", "scripts/merge-bar.ts", String(number)], {
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
  const exit = await run(number);
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

const main = async (): Promise<void> => {
  const fileIndex = process.argv.indexOf("--evidence");
  const file = process.argv.at(fileIndex + 1);
  if (fileIndex === -1 || !file) {
    panic("Runner-local --evidence path required");
  }
  if (process.argv.includes("--probe")) {
    const sha = checkedGit(["rev-parse", "HEAD"]);
    const now = new Date();
    const entries: HealingEntry[] = [];
    for (const entry of dueWaivers(await loadWaivers(), now)) {
      const expired =
        now.getTime() >= Date.parse(expiryInstant(entry.expiresAt));
      entries.push({
        entry,
        outcome: expired ? { status: "expired" } : await probeEntry(entry, sha),
      });
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        sha,
        observedAt: now.toISOString(),
        entries,
      } satisfies HealingReport),
      { mode: 0o600 },
    );
    const output = process.env["GITHUB_OUTPUT"];
    if (output) {
      appendFileSync(output, `write_needed=${entries.length > 0}\n`);
    }
    console.log(
      JSON.stringify({
        signal: "dated-waiver-probed",
        entries: entries.length,
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
    actions: {
      ...sink,
      openRemoval: ({ entry, outcome }) =>
        publishRemoval({
          branch: `chore/dated-waiver-${waiverKey(entry)}`,
          baseSha: report.sha,
          baseFiles: outcome.baseFiles,
          files: outcome.files,
          body: renderRemovalEvidence(outcome.evidence),
          repo: process.env["GITHUB_REPOSITORY"],
          request: githubRequest,
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

if (import.meta.main) {
  const result = await Result.tryPromise(main);
  if (Result.isError(result)) {
    console.error("Dated waiver healing failed; diagnostic output withheld.");
    process.exitCode = 1;
  }
}
