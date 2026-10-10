import { expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createPrivateTaskSink,
  DATED_WAIVER_AUTOFIX_LABEL,
  FIX_TASK_IDENTITY_LABEL,
  EXPIRY_ALERT_LABEL,
  probeSourceFingerprint,
  RESOLUTION_POLICY,
  waiverKey,
} from "./dated-waiver-fix-task";
import type { FixEvidence } from "./dated-waiver-fix-task";
import {
  applyHealing,
  armRemovalThroughBar,
  disarmRemovalThroughBar,
  collectProbeReport,
  readReport,
  renderHealingFailureSignal,
  runHealingBoundary,
  executeProbeCommand,
  redactProbeOutput,
  renderRemovalEvidence,
  type HealingEntry,
  HealingRunError,
  HealingError,
  type HealingFailure,
  type HealingActions,
} from "./dated-waiver-healing";
import {
  createProbeBudget,
  PROBE_PHASE_BUDGET_MS,
  runWaiverProbe,
} from "./dated-waiver-probes";
import { retireRemoval } from "./dated-waiver-publish";
import {
  loadWaivers,
  collectWaivers,
  RECHECK_INSTRUCTIONS,
  type DatedWaiver,
} from "./dated-waivers";

const entry = {
  source: "bunfig.toml",
  line: 1,
  id: "example",
  kind: "release-age-exclusion",
  expiresAt: "2026-10-15T00:00:00.000Z",
  probe: { command: ["bun", "probe"], attempts: 3 },
} as const satisfies DatedWaiver;
const evidence = {
  attempts: 3,
  passed: 3,
  command: entry.probe.command,
  output: "PRIVATE FAILURE",
  runner: "Linux",
  sha: "base",
  sourceFingerprint: "failure-source",
  observedAt: "2026-10-12T00:00:00.000Z",
  run: "run-link",
};
const green = {
  status: "green",
  evidence,
  files: { "bunfig.toml": "after" },
  baseFiles: { "bunfig.toml": "before" },
} as const;
const scenario = (records: HealingEntry[]) => {
  const effects: string[] = [];
  let taskState: "open" | "closed" = "open";
  let removalNumber: number | undefined = 42;
  const actions = {
    retireRemoval: async () => {},
    assessRemoval: async () => ({ status: "eligible" as const }),
    resolveFixTask: async () => {
      effects.push("resolve");
    },
    openRemoval: async () => {
      effects.push("remove");
      return removalNumber;
    },
    armRemoval: async (number: number) => {
      effects.push(`arm:${number}`);
    },
    openFixTask: async () => {
      effects.push("fix");
      return { number: 7, state: taskState };
    },
    findTask: async () => {
      effects.push("find");
      return { number: 7, state: taskState };
    },
    alertExpiry: async () => {
      effects.push("alert");
    },
  };
  return {
    actions,
    effects,
    closeTask: () => {
      taskState = "closed";
    },
    alreadyRemoved: () => {
      removalNumber = undefined;
    },
    run: async (now: string) =>
      applyHealing({
        report: {
          failures: [],
          sha: "base",
          observedAt: "2026-10-10",
          entries: records,
        },
        actions,
        now: new Date(now),
      }),
  };
};

test("merge bar refusals fail publication instead of reporting a pending arm", async () => {
  const calls: number[] = [];
  const armed = await armRemovalThroughBar(42, async (number) => {
    calls.push(number);
    return 0;
  });
  expect(armed).toEqual({ signal: "dated-waiver-armed", pr: 42 });
  expect(calls).toEqual([42]);
  for (const exit of [1, 2, 137]) {
    const run = scenario([{ entry, outcome: green }]);
    run.actions.armRemoval = async (number) => {
      await armRemovalThroughBar(number, async () => exit);
    };
    expect(await rejectionOf(run.run("2026-10-10T00:00:00Z"))).toMatchObject({
      message: "Dated waiver operations failed; diagnostic output withheld.",
      failures: [{ key: waiverKey(entry), stage: "armRemoval" }],
    });
    expect(run.effects).toEqual(["remove", "resolve"]);
  }
});

test("recorded failures publish before an earlier removal's merge bar can refuse", async () => {
  const run = scenario([
    { entry, outcome: green },
    {
      entry: { ...entry, id: "later" },
      outcome: {
        ...green,
        status: "red",
        evidence: { ...evidence, passed: 2 },
      },
    },
  ]);
  run.actions.armRemoval = async (number) => {
    await armRemovalThroughBar(number, async () => 1);
  };
  expect(await rejectionOf(run.run("2026-10-10T00:00:00Z"))).toMatchObject({
    message: "Dated waiver operations failed; diagnostic output withheld.",
    failures: [{ key: waiverKey(entry), stage: "armRemoval" }],
  });
  expect(run.effects).toEqual(["fix", "remove", "resolve"]);
});

test("N/N green removes through the sanctioned arm collaborator; main no-op never arms", async () => {
  const fresh = scenario([{ entry, outcome: green }]);
  await fresh.run("2026-10-10T00:00:00Z");
  expect(fresh.effects).toEqual(["remove", "resolve", "arm:42"]);
  const merged = scenario([{ entry, outcome: green }]);
  merged.alreadyRemoved();
  await merged.run("2026-10-10T00:00:00Z");
  expect(merged.effects).toEqual(["remove", "resolve"]);
});

test("partial and zero-sample greens cannot publish", async () => {
  for (const passed of [0, 1, 2]) {
    const run = scenario([
      { entry, outcome: { ...green, evidence: { ...evidence, passed } } },
    ]);
    expect(await rejectionOf(run.run("2026-10-10T00:00:00Z"))).toMatchObject({
      message: "Dated waiver operations failed; diagnostic output withheld.",
      failures: [{ key: waiverKey(entry), stage: "evidence" }],
    });
    expect(run.effects).toEqual([]);
  }
});

test("red opens one root-cause task and only signals expiry at T-1", async () => {
  const records: HealingEntry[] = [
    {
      entry,
      outcome: {
        ...green,
        status: "red",
        evidence: { ...evidence, passed: 2 },
      },
    },
  ];
  const before = scenario(records);
  await before.run("2026-10-13T23:59:59Z");
  expect(before.effects).toEqual(["fix"]);
  const due = scenario(records);
  await due.run("2026-10-14T00:00:00Z");
  expect(due.effects).toEqual(["fix", "alert"]);
});

test("twenty timed-out samples still publish one private fix task within the phase budget", async () => {
  let clock = 0;
  const timeoutEntry = {
    ...entry,
    probe: { command: entry.probe.command, attempts: 20 },
  };
  const budget = createProbeBudget({ attempts: 20, now: () => clock });
  const result = await runWaiverProbe(timeoutEntry, {
    run: async (command) =>
      budget.run(command, async ({ timeoutMs }) => {
        clock += timeoutMs;
        return { passed: false, output: "Probe attempt timed out." };
      }),
  });
  expect(result.status).toBe("red");
  expect(result.attempts).toBe(20);
  expect(result.passed).toBe(0);
  expect(clock).toBeLessThanOrEqual(PROBE_PHASE_BUDGET_MS);
  const fixture = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fixture.request,
    ensureLabel: fixture.ensureLabel,
  });
  const lifecycle = scenario([]);
  await applyHealing({
    now: new Date("2026-10-10T00:00:00Z"),
    report: {
      failures: [],
      sha: evidence.sha,
      observedAt: "2026-10-10",
      entries: [
        {
          entry: timeoutEntry,
          outcome: {
            ...green,
            status: "red",
            evidence: { ...evidence, ...result },
          },
        },
      ],
    },
    actions: { ...lifecycle.actions, ...sink },
  });
  expect(fixture.tasks).toHaveLength(1);
  expect(fixture.tasks.at(0)?.body).toContain("Probe attempt timed out.");
  expect(fixture.tasks.at(0)?.body).toContain('"attempts": 20');
  expect(lifecycle.effects).toEqual([]);
  expect(timeoutEntry.expiresAt).toBe(entry.expiresAt);
});

test("twenty hanging Bun commands become recorded timeout failures", async () => {
  const hanging = {
    ...entry,
    probe: {
      attempts: 20,
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    },
  };
  let launched = 0;
  const result = await runWaiverProbe(hanging, {
    run: async (command) => {
      launched += 1;
      return executeProbeCommand({
        command,
        timeoutMs: 10,
        cwd: import.meta.dir,
        env: {},
        secrets: [],
      });
    },
  });
  expect(launched).toBe(20);
  expect(result.status).toBe("red");
  expect(result.attempts).toBe(20);
  expect(result.passed).toBe(0);
  expect(result.output.match(/Probe attempt timed out\./gu)).toHaveLength(20);
});

test("expiry lapses without probing, removal, renewal or duplicate fix creation", async () => {
  const expired = scenario([{ entry, outcome: { status: "expired" } }]);
  await expired.run("2026-10-15T00:00:00Z");
  expect(expired.effects).toEqual(["find", "alert"]);
  const fixed = scenario([{ entry, outcome: { status: "expired" } }]);
  fixed.closeTask();
  await fixed.run("2026-10-16T00:00:00Z");
  expect(fixed.effects).toEqual(["find"]);
  const staleGreen = scenario([{ entry, outcome: green }]);
  await staleGreen.run("2026-10-15T00:00:00Z");
  expect(staleGreen.effects).toEqual(["find", "alert"]);
  const staleRed = scenario([
    {
      entry,
      outcome: {
        ...green,
        status: "red",
        evidence: { ...evidence, passed: 2 },
      },
    },
  ]);
  await staleRed.run("2026-10-15T00:00:00Z");
  expect(staleRed.effects).toEqual(["find", "alert"]);
  expect(entry.expiresAt).toBe("2026-10-15T00:00:00.000Z");
});

test("premature expired evidence cannot alert before the owner deadline", async () => {
  const expired = scenario([{ entry, outcome: { status: "expired" } }]);
  expect(await rejectionOf(expired.run("2026-10-10T00:00:00Z"))).toMatchObject({
    message: "Dated waiver operations failed; diagnostic output withheld.",
    failures: [{ key: waiverKey(entry), stage: "evidence" }],
  });
  expect(expired.effects).toEqual([]);
});

test("public evidence contains counts and provenance, never captured failures", () => {
  const body = renderRemovalEvidence(evidence);
  expect(body).not.toContain(evidence.output);
  for (const value of ["3/3", "bun", "Linux", "base", "run-link"]) {
    expect(body).toContain(value);
  }
  expect(
    redactProbeOutput("Bearer abc ghp_123secret credential123", [
      "credential123",
    ]),
  ).toBe("Bearer [REDACTED] [REDACTED] [REDACTED]");
  expect(redactProbeOutput("x".repeat(100_000), [])).toHaveLength(24_000);
});

const issueInput = v.looseObject({
  title: v.string(),
  body: v.string(),
  labels: v.array(v.string()),
});
type TaskFixtureOptions = { privateRepo?: boolean; missingLabels?: boolean };
const taskFixture = ({
  privateRepo = true,
  missingLabels = false,
}: TaskFixtureOptions = {}) => {
  const labels = missingLabels
    ? []
    : [DATED_WAIVER_AUTOFIX_LABEL, EXPIRY_ALERT_LABEL, FIX_TASK_IDENTITY_LABEL];
  const tasks: {
    number: number;
    body: string;
    state: "open" | "closed";
    labels: { name: string }[];
  }[] = [];
  const writes: unknown[] = [];
  let mergedResolution: "none" | "merged" | "unmerged" | "not-included" =
    "none";
  const ensuredLabels: string[] = [];
  const ensureLabel = async (repo: string, label: string): Promise<void> => {
    expect(repo).toBe("stella/companion");
    ensuredLabels.push(label);
    if (!labels.includes(label)) {
      labels.push(label);
      writes.push({ label });
    }
  };
  const request = async (
    args: readonly string[],
    input?: unknown,
  ): Promise<unknown> => {
    const endpoint = args.at(0);
    if (endpoint === "repos/stella/companion") {
      return { private: privateRepo };
    }
    if (endpoint === "repos/stella/companion/issues" && input === undefined) {
      return tasks;
    }
    if (endpoint === "repos/stella/companion/issues/1" && input === undefined) {
      return tasks.at(0);
    }
    if (endpoint === "repos/stella/companion/issues/1/timeline") {
      return mergedResolution !== "none"
        ? [
            {
              event: "cross-referenced",
              source: {
                issue: {
                  number: 55,
                  repository_url: "https://api.github.com/repos/stella/stella",
                  pull_request: {
                    url: "https://api.github.com/repos/stella/stella/pulls/55",
                  },
                },
              },
            },
          ]
        : [];
    }
    if (endpoint === "repos/stella/stella/pulls/55") {
      return {
        merged_at:
          mergedResolution === "unmerged" ? null : "2026-10-11T00:00:00Z",
        merge_commit_sha: "root-cause-fix",
      };
    }
    if (endpoint === "repos/stella/stella/compare/base...root-cause-fix") {
      return { status: "ahead" };
    }
    if (
      endpoint === "repos/stella/stella/compare/root-cause-fix...resolved-head"
    ) {
      return {
        status: mergedResolution === "not-included" ? "diverged" : "ahead",
      };
    }
    writes.push(input);
    if (v.is(v.object({ state: v.literal("closed") }), input)) {
      const task = tasks.at(0);
      if (!task) {
        throw new TypeError("Task fixture missing");
      }
      task.state = "closed";
      return task;
    }
    if (endpoint === "repos/stella/companion/issues/1/labels") {
      const addedLabels = v.parse(
        v.object({ labels: v.array(v.string()) }),
        input,
      ).labels;
      const task = tasks.at(0);
      if (!task) {
        throw new TypeError("Task fixture missing");
      }
      task.labels.push(...addedLabels.map((name) => ({ name })));
      return task.labels;
    }
    const parsed = v.parse(issueInput, input);
    const task = {
      number: 1,
      body: parsed.body,
      state: "open" as const,
      labels: parsed.labels.map((name) => ({ name })),
    };
    if (tasks.length === 0) {
      tasks.push(task);
    } else {
      tasks.splice(0, tasks.length, task);
    }
    return task;
  };
  return {
    tasks,
    writes,
    request,
    labels,
    ensureLabel,
    ensuredLabels,
    linkMergedResolution: (
      mode: "merged" | "unmerged" | "not-included" = "merged",
    ) => {
      mergedResolution = mode;
    },
  };
};

test("failing evidence is refused before any public issue write", async () => {
  const fake = taskFixture({ privateRepo: false });
  expect(
    await rejectionOf(
      createPrivateTaskSink({
        repo: "stella/companion",
        request: fake.request,
        ensureLabel: fake.ensureLabel,
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining("Fix tasks require a private repository"),
  });
  expect(fake.writes).toEqual([]);
  expect(fake.ensuredLabels).toEqual([]);
  expect(
    await rejectionOf(
      createPrivateTaskSink({
        repo: "stella/stella",
        request: fake.request,
        ensureLabel: fake.ensureLabel,
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining(
      "Fix tasks require a separate private companion repository",
    ),
  });
});

test("red replay refreshes exactly one private task, reopens it, and alerts once", async () => {
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  const first = await sink.openFixTask(entry, evidence);
  expect(fake.tasks).toHaveLength(1);
  expect(first.body).toContain("PRIVATE FAILURE");
  expect(first.body).toContain("Fix the root cause");
  expect(first.labels).toEqual([
    { name: FIX_TASK_IDENTITY_LABEL },
    { name: DATED_WAIVER_AUTOFIX_LABEL },
  ]);
  const task = fake.tasks.at(0);
  if (!task) {
    throw new TypeError("Task fixture missing");
  }
  task.state = "closed";
  const next = await sink.openFixTask(entry, evidence);
  expect(next.number).toBe(first.number);
  expect(next.state).toBe("open");
  expect(fake.tasks).toHaveLength(1);
  await sink.alertExpiry(next);
  const writes = fake.writes.length;
  await sink.alertExpiry(next);
  expect(fake.writes).toHaveLength(writes);
  expect(fake.tasks.at(0)?.labels).toContainEqual({ name: EXPIRY_ALERT_LABEL });
  expect(waiverKey({ ...entry, expiresAt: "2026-12-01" })).toBe(
    waiverKey(entry),
  );
});

test("closed task at T-1 never emits the expiry signal", async () => {
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  const task = await sink.openFixTask(entry, evidence);
  const current = fake.tasks.at(0);
  if (!current) {
    throw new TypeError("Task fixture missing");
  }
  current.state = "closed";
  const before = fake.writes.length;
  await sink.alertExpiry(task);
  expect(fake.writes).toHaveLength(before);
});

test("successful removal evidence resolves a prior fix task so expiry cannot emit a stale alert", async () => {
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  const task = await sink.openFixTask(repositoryEntry, evidence);
  await sink.resolveFixTask(repositoryEntry, {
    ...evidence,
    sha: "resolved-head",
    sourceFingerprint: "fixed-source",
  });
  expect(fake.tasks.at(0)?.state).toBe("closed");
  const writes = fake.writes.length;
  await sink.resolveFixTask(repositoryEntry, {
    ...evidence,
    sha: "resolved-head",
    sourceFingerprint: "fixed-source",
  });
  await sink.alertExpiry(task);
  expect(fake.writes).toHaveLength(writes);
});

test("all consumer, identity and alert labels exist before a task is created", async () => {
  const fake = taskFixture({ missingLabels: true });
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  expect(fake.labels.toSorted()).toEqual(
    [
      DATED_WAIVER_AUTOFIX_LABEL,
      EXPIRY_ALERT_LABEL,
      FIX_TASK_IDENTITY_LABEL,
    ].toSorted(),
  );
  expect(fake.tasks).toEqual([]);
  expect(fake.ensuredLabels).toEqual([
    DATED_WAIVER_AUTOFIX_LABEL,
    EXPIRY_ALERT_LABEL,
    FIX_TASK_IDENTITY_LABEL,
  ]);
  const writes = fake.writes.length;
  await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  expect(fake.writes).toHaveLength(writes);
  expect(fake.ensuredLabels).toHaveLength(6);
  const task = await sink.openFixTask(entry, evidence);
  expect(task.labels).toContainEqual({ name: FIX_TASK_IDENTITY_LABEL });
  expect(task.labels).toContainEqual({ name: DATED_WAIVER_AUTOFIX_LABEL });
});

test("label provisioning failure blocks task publication", async () => {
  const fake = taskFixture();
  expect(
    await rejectionOf(
      createPrivateTaskSink({
        repo: "stella/companion",
        request: fake.request,
        ensureLabel: async () => {
          throw new TypeError("Label provisioning unavailable");
        },
      }),
    ),
  ).toMatchObject({
    message: expect.stringContaining("Label provisioning unavailable"),
  });
  expect(fake.tasks).toEqual([]);
  expect(fake.writes).toEqual([]);
});

test("task identity comes from its published header", async () => {
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  const own = await sink.openFixTask(entry, evidence);
  expect(own.body.split("\n").at(0)).toBe(
    `<!-- dated-waiver:${waiverKey(entry)} -->`,
  );
  expect(await sink.findTask({ ...entry, id: "other" })).toBeUndefined();
  expect((await sink.findTask(entry))?.number).toBe(own.number);
});

const repositoryEntry = { ...entry, kind: "quarantined-test" } as const;

const resolutionScenario = async (
  kind: DatedWaiver["kind"] = "quarantined-test",
) => {
  const owner = { ...repositoryEntry, kind };
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  const effects: string[] = [];
  let now = "2026-10-12T00:00:00Z";
  const actions = {
    retireRemoval: async () => {},
    ...sink,
    openRemoval: async () => {
      effects.push("remove");
      return 42;
    },
    resolveFixTask: async (taskOwner: DatedWaiver, proof: FixEvidence) => {
      await sink.resolveFixTask(taskOwner, proof);
      effects.push("resolve");
    },
    armRemoval: async () => {
      effects.push("arm");
    },
  };
  const run = async (status: "red" | "green", proof: FixEvidence) =>
    applyHealing({
      now: new Date(now),
      actions,
      report: {
        failures: [],
        sha: proof.sha,
        observedAt: "2026-10-12",
        entries: [
          { entry: owner, outcome: { ...green, status, evidence: proof } },
        ],
      },
    });
  await run("red", { ...evidence, passed: 2 });
  return {
    fake,
    effects,
    run,
    sink,
    advanceToWarning: () => {
      now = "2026-10-14T00:00:00Z";
    },
  };
};

test("green on the failed commit cannot remove the waiver or close its task", async () => {
  const healing = await resolutionScenario();
  const writes = healing.fake.writes.length;
  await healing.run("green", evidence);
  expect(healing.effects).toEqual([]);
  expect(healing.fake.writes).toHaveLength(writes);
  expect(healing.fake.tasks.at(0)?.state).toBe("open");
});

test("a changed commit and changed probe source permits removal and task closure", async () => {
  const healing = await resolutionScenario();
  await healing.run("green", {
    ...evidence,
    sha: "resolved-head",
    sourceFingerprint: "fixed-source",
  });
  expect(healing.effects).toEqual(["remove", "resolve", "arm"]);
  expect(healing.fake.tasks.at(0)?.state).toBe("closed");
});

test("an unrelated commit with unchanged probe source remains blocked", async () => {
  const healing = await resolutionScenario();
  await healing.run("green", { ...evidence, sha: "unrelated-head" });
  expect(healing.effects).toEqual([]);
  expect(healing.fake.tasks.at(0)?.state).toBe("open");
});

test("a closed task's merged resolution included in the probe commit permits removal", async () => {
  const healing = await resolutionScenario();
  const task = healing.fake.tasks.at(0);
  if (!task) {
    throw new TypeError("Task fixture missing");
  }
  task.state = "closed";
  healing.fake.linkMergedResolution();
  await healing.run("green", { ...evidence, sha: "resolved-head" });
  expect(healing.effects).toEqual(["remove", "resolve", "arm"]);
  expect(task.state).toBe("closed");
});

test("missing failure source metadata blocks automatic resolution", async () => {
  const healing = await resolutionScenario();
  const task = healing.fake.tasks.at(0);
  if (!task) {
    throw new TypeError("Task fixture missing");
  }
  task.body = task.body
    .split("\n")
    .filter((line) => !line.startsWith("<!-- failure-source:"))
    .join("\n");
  await healing.run("green", {
    ...evidence,
    sha: "resolved-head",
    sourceFingerprint: "fixed-source",
  });
  expect(healing.effects).toEqual([]);
  expect(task.state).toBe("open");
});

test("source fingerprints ignore input order and change with probe contents", () => {
  const baseline = {
    "bun.lock": "dependencies",
    "bunfig.toml": "without waiver",
  };
  expect(
    probeSourceFingerprint({
      "bunfig.toml": "without waiver",
      "bun.lock": "dependencies",
    }),
  ).toBe(probeSourceFingerprint(baseline));
  for (const file of Object.keys(baseline)) {
    expect(
      probeSourceFingerprint({ ...baseline, [file]: "changed probe input" }),
    ).not.toBe(probeSourceFingerprint(baseline));
  }
});

test("the failed commit remains blocked even if fingerprint metadata differs", async () => {
  const healing = await resolutionScenario();
  await healing.run("green", {
    ...evidence,
    sourceFingerprint: "fixed-source",
  });
  expect(healing.effects).toEqual([]);
  expect(healing.fake.tasks.at(0)?.state).toBe("open");
});

test("blocked green evidence signals an unresolved task at T-1", async () => {
  const healing = await resolutionScenario();
  healing.advanceToWarning();
  await healing.run("green", evidence);
  expect(healing.effects).toEqual([]);
  expect(healing.fake.tasks.at(0)?.state).toBe("open");
  expect(healing.fake.tasks.at(0)?.labels).toContainEqual({
    name: EXPIRY_ALERT_LABEL,
  });
});

test("closed tasks require a merged resolution included in the probe commit", async () => {
  for (const mode of ["no-link", "unmerged", "not-included"] as const) {
    const healing = await resolutionScenario();
    const task = healing.fake.tasks.at(0);
    if (!task) {
      throw new TypeError("Task fixture missing");
    }
    task.state = "closed";
    if (mode !== "no-link") {
      healing.fake.linkMergedResolution(mode);
    }
    await healing.run("green", { ...evidence, sha: "resolved-head" });
    expect(healing.effects).toEqual([]);
    expect(task.state).toBe("closed");
  }
});

const recoveryCases = {
  "no-llms-txt": "later-green",
  "release-age-exclusion": "later-green",
  "release-age-exception": "later-green",
  "dependency-audit": "later-green",
  "suppression-waiver": "changed-source",
  "quarantined-test": "changed-source",
} as const satisfies Record<
  DatedWaiver["kind"],
  "later-green" | "changed-source"
>;

test("every inventory kind has an exercised resolution policy", () => {
  expect(Object.keys(RESOLUTION_POLICY).toSorted()).toEqual(
    Object.keys(RECHECK_INSTRUCTIONS).toSorted(),
  );
  expect(Object.keys(recoveryCases).toSorted()).toEqual(
    Object.keys(RECHECK_INSTRUCTIONS).toSorted(),
  );
});

for (const [kind, recovery] of Object.entries(recoveryCases)) {
  test(`${kind} requires its declared recovery evidence`, async () => {
    const isProbeKind = (candidate: string): candidate is DatedWaiver["kind"] =>
      candidate in RECHECK_INSTRUCTIONS;
    if (!isProbeKind(kind)) {
      throw new TypeError("Unknown probe fixture");
    }
    const owner = { ...entry, kind };
    const fake = taskFixture();
    const sink = await createPrivateTaskSink({
      repo: "stella/companion",
      request: fake.request,
      ensureLabel: fake.ensureLabel,
    });
    await sink.openFixTask(owner, { ...evidence, passed: 2 });
    const later = { ...evidence, observedAt: "2026-10-13T00:00:00.000Z" };
    for (const observedAt of [
      evidence.observedAt,
      "2026-10-11T00:00:00.000Z",
      "invalid",
    ]) {
      expect(
        (await sink.assessRemoval(owner, { ...evidence, observedAt })).status,
      ).toBe("blocked");
    }
    expect((await sink.assessRemoval(owner, later)).status).toBe(
      recovery === "later-green" ? "eligible" : "blocked",
    );
    expect(
      (await sink.assessRemoval(owner, { ...later, passed: 2 })).status,
    ).toBe("blocked");
    expect(
      (await sink.assessRemoval(owner, { ...later, attempts: 2 })).status,
    ).toBe("blocked");
    const resolved = {
      ...later,
      sha: "resolved-head",
      sourceFingerprint: "fixed-source",
    };
    expect((await sink.assessRemoval(owner, resolved)).status).toBe("eligible");
    await sink.resolveFixTask(
      owner,
      recovery === "later-green" ? later : resolved,
    );
    expect(fake.tasks.at(0)?.state).toBe("closed");
  });
}

test("later full-green external recovery removes and closes the same-source task", async () => {
  const healing = await resolutionScenario("no-llms-txt");
  await healing.run("green", {
    ...evidence,
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  expect(healing.effects).toEqual(["remove", "resolve", "arm"]);
  expect(healing.fake.tasks.at(0)?.state).toBe("closed");
});

const lifecycleOwner = {
  ...entry,
  kind: "no-llms-txt",
} as const satisfies DatedWaiver;
const proposalLifecycle = async (owner: DatedWaiver = lifecycleOwner) => {
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  let proposal:
    | { number: number; status: "armed" | "unarmed" | "closed"; body: string }
    | undefined;
  let created = 0;
  let disarmExit = 0;
  const effects: string[] = [];
  const request = async (
    args: readonly string[],
    input?: unknown,
  ): Promise<unknown> => {
    const endpoint = args.at(0);
    if (endpoint === "repos/stella/stella/pulls" && input === undefined) {
      expect(args).toContain(
        `head=stella:chore/dated-waiver-${waiverKey(owner)}`,
      );
      if (!proposal) {
        return [];
      }
      switch (proposal.status) {
        case "closed":
          return [];
        case "armed":
        case "unarmed":
          return [
            { ...proposal, title: "chore: remove verified dated waiver" },
          ];
        default:
          proposal.status satisfies never;
          throw new TypeError("Unhandled proposal status");
      }
    }
    if (
      endpoint === `repos/stella/stella/pulls/${proposal?.number}` &&
      input !== undefined &&
      proposal
    ) {
      const close = v.parse(
        v.object({ state: v.literal("closed"), body: v.string() }),
        input,
      );
      expect(proposal.status).toBe("unarmed");
      proposal.status = "closed";
      proposal.body = close.body;
      effects.push("close");
      return proposal;
    }
    throw new TypeError(`Unexpected proposal fixture endpoint: ${endpoint}`);
  };
  const actions = {
    ...sink,
    openRemoval: async () => {
      if (!proposal || proposal.status === "closed") {
        proposal = {
          number: ++created,
          status: "unarmed",
          body: renderRemovalEvidence(evidence),
        };
        effects.push("publish");
      }
      return proposal.number;
    },
    armRemoval: async (number: number) => {
      await armRemovalThroughBar(number, async (pr, mode) => {
        expect(mode).toBe("arm");
        if (!proposal) {
          throw new TypeError("Proposal fixture missing");
        }
        expect(pr).toBe(proposal.number);
        proposal.status = "armed";
        effects.push("arm");
        return 0;
      });
    },
    retireRemoval: async (waiver: DatedWaiver) =>
      retireRemoval({
        branch: `chore/dated-waiver-${waiverKey(waiver)}`,
        repo: "stella/stella",
        request,
        disarm: async (number) =>
          disarmRemovalThroughBar(number, async (pr, mode) => {
            expect(mode).toBe("disarm");
            if (!proposal) {
              throw new TypeError("Proposal fixture missing");
            }
            expect(pr).toBe(proposal.number);
            effects.push("disarm");
            if (disarmExit === 0) {
              proposal.status = "unarmed";
            }
            return disarmExit;
          }),
      }),
  };
  const run = async (status: "green" | "red", proof: FixEvidence = evidence) =>
    applyHealing({
      actions,
      now: new Date(proof.observedAt),
      report: {
        failures: [],
        sha: proof.sha,
        observedAt: proof.observedAt,
        entries: [
          { entry: owner, outcome: { ...green, status, evidence: proof } },
        ],
      },
    });
  return {
    fake,
    effects,
    actions,
    run,
    proposal: () => proposal,
    refuseDisarm: (exit: number) => {
      disarmExit = exit;
    },
  };
};

test("shifted exceptions reconcile their failed task and armed proposal before accepting recovery", async () => {
  const annotation = `# release-age-quarantine-exception: ${entry.expiresAt}`;
  const earlier = `command: bun install --minimum-release-age 0\n${annotation}`;
  const covered = `command: bun install --production --minimum-release-age 0\n${annotation}`;
  const inventory = (contents: string) =>
    collectWaivers({
      read: () => '{"waivers":[]}',
      docs: [],
      audit: [],
      bunfigs: [],
      releaseAgeSources: { "docker-compose.yml": contents },
    });
  const owner = inventory(`${earlier}\n${covered}`).find(
    ({ line }) => line === 4,
  );
  const shifted = inventory(`\n${covered}`).at(0);
  if (!owner || !shifted) {
    throw new TypeError("Exception lifecycle fixture missing");
  }
  expect(shifted.line).not.toBe(owner.line);
  const proof = { ...evidence, command: owner.probe.command };
  const lifecycle = await proposalLifecycle(owner);
  await lifecycle.run("green", proof);
  lifecycle.refuseDisarm(1);
  expect(
    await rejectionOf(lifecycle.run("red", { ...proof, passed: 2 })),
  ).toBeInstanceOf(HealingRunError);
  expect(lifecycle.proposal()?.status).toBe("armed");
  expect(lifecycle.fake.tasks).toHaveLength(1);
  lifecycle.refuseDisarm(0);
  const runShifted = async (status: "green" | "red", observedAt: string) =>
    applyHealing({
      actions: lifecycle.actions,
      now: new Date(observedAt),
      report: {
        sha: proof.sha,
        observedAt,
        failures: [],
        entries: [
          {
            entry: shifted,
            outcome: {
              ...green,
              status,
              evidence: {
                ...proof,
                observedAt,
                passed: status === "red" ? 2 : 3,
              },
            },
          },
        ],
      },
    });
  await runShifted("green", proof.observedAt);
  expect(lifecycle.proposal()?.status).toBe("closed");
  expect(lifecycle.proposal()?.number).toBe(1);
  expect(lifecycle.fake.tasks).toHaveLength(1);
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("open");
  await runShifted("red", proof.observedAt);
  expect(lifecycle.fake.tasks).toHaveLength(1);
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("open");
  await runShifted("green", "2026-10-13T00:00:00.000Z");
  expect(lifecycle.proposal()?.number).toBe(2);
  expect(lifecycle.proposal()?.status).toBe("armed");
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("closed");
});

test("green then red disarms and closes the proposal while preserving one open fix task", async () => {
  const lifecycle = await proposalLifecycle();
  await lifecycle.run("green");
  expect(lifecycle.proposal()?.status).toBe("armed");
  await lifecycle.run("red", { ...evidence, passed: 2 });
  expect(lifecycle.effects).toEqual(["publish", "arm", "disarm", "close"]);
  expect(lifecycle.proposal()?.status).toBe("closed");
  expect(lifecycle.proposal()?.body).not.toContain("PRIVATE FAILURE");
  expect(lifecycle.fake.tasks).toHaveLength(1);
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("open");
  await lifecycle.run("red", { ...evidence, passed: 2 });
  expect(lifecycle.effects).toHaveLength(4);
  await lifecycle.run("green", {
    ...evidence,
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  expect(lifecycle.proposal()?.number).toBe(2);
  expect(lifecycle.proposal()?.status).toBe("armed");
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("closed");
});

test("blocked repository resolution retires an earlier armed proposal", async () => {
  const lifecycle = await proposalLifecycle({
    ...entry,
    kind: "quarantined-test",
  });
  await lifecycle.run("green");
  await lifecycle.actions.openFixTask(repositoryEntry, {
    ...evidence,
    passed: 2,
  });
  await lifecycle.run("green");
  expect(lifecycle.proposal()?.status).toBe("closed");
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("open");
  expect(lifecycle.effects).toEqual(["publish", "arm", "disarm", "close"]);
});

test("disarm refusals fail the lifecycle and retain the recorded private task", async () => {
  for (const exit of [1, 2, 137]) {
    const lifecycle = await proposalLifecycle();
    await lifecycle.run("green");
    lifecycle.refuseDisarm(exit);
    expect(
      await rejectionOf(lifecycle.run("red", { ...evidence, passed: 2 })),
    ).toMatchObject({
      message: "Dated waiver operations failed; diagnostic output withheld.",
      failures: [
        {
          key: waiverKey({ ...entry, kind: "no-llms-txt" }),
          stage: "retireRemoval",
        },
      ],
    });
    expect(lifecycle.fake.tasks.at(0)?.state).toBe("open");
    expect(lifecycle.proposal()?.status).toBe("armed");
    expect(lifecycle.effects).toEqual(["publish", "arm", "disarm"]);
  }
});

test("private task publication failure still retires the pending removal", async () => {
  const lifecycle = await proposalLifecycle();
  await lifecycle.run("green");
  lifecycle.actions.openFixTask = async () => {
    throw new TypeError("Private task unavailable");
  };
  expect(
    await rejectionOf(lifecycle.run("red", { ...evidence, passed: 2 })),
  ).toMatchObject({
    message: "Dated waiver operations failed; diagnostic output withheld.",
    failures: [
      {
        key: waiverKey({ ...entry, kind: "no-llms-txt" }),
        stage: "openFixTask",
      },
    ],
  });
  expect(lifecycle.proposal()?.status).toBe("closed");
});

test("expiry retires a pending proposal without creating a replacement fix task", async () => {
  const lifecycle = await proposalLifecycle();
  await lifecycle.run("green");
  await lifecycle.actions.openFixTask(entry, { ...evidence, passed: 2 });
  await lifecycle.run("red", {
    ...evidence,
    passed: 2,
    observedAt: "2026-10-15T00:00:00.000Z",
  });
  expect(lifecycle.proposal()?.status).toBe("closed");
  expect(lifecycle.fake.tasks).toHaveLength(1);
  expect(lifecycle.fake.tasks.at(0)?.state).toBe("open");
  expect(lifecycle.effects).toEqual(["publish", "arm", "disarm", "close"]);
});

const RED_FAILURE_PROPERTY =
  "dated healing preserves every red task across side-effect failure subsets";
test(RED_FAILURE_PROPERTY, async () => {
  await assertProperty(
    RED_FAILURE_PROPERTY,
    fc.asyncProperty(
      fc.array(
        fc.subarray(["openFixTask", "retireRemoval", "alertExpiry"] as const),
        { minLength: 1, maxLength: 8 },
      ),
      async (subsets) => {
        const owners = subsets.map((_, index) => ({
          ...entry,
          id: `waiver-${index}`,
        }));
        const tasks = new Map<string, { number: number; state: "open" }>();
        const alerts = new Set<number>();
        const retired = new Set<string>();
        const expected: Pick<HealingFailure, "key" | "stage">[] = [];
        const fail = (
          owner: DatedWaiver,
          stage: "openFixTask" | "retireRemoval" | "alertExpiry",
        ) => {
          const subset = subsets.at(
            owners.findIndex(({ id }) => id === owner.id),
          );
          if (!subset) {
            throw new TypeError("Failure subset fixture missing");
          }
          if (subset.includes(stage)) {
            expected.push({ key: waiverKey(owner), stage });
            throw new HealingError({ message: "PRIVATE FAILURE" });
          }
        };
        const actions = {
          ...scenario([]).actions,
          openFixTask: async (owner: DatedWaiver) => {
            // A response can fail after durable task creation. Never retry it.
            const task = { number: tasks.size + 1, state: "open" as const };
            tasks.set(owner.id, task);
            fail(owner, "openFixTask");
            return task;
          },
          findTask: async (owner: DatedWaiver) => tasks.get(owner.id),
          retireRemoval: async (owner: DatedWaiver) => {
            retired.add(owner.id);
            fail(owner, "retireRemoval");
          },
          alertExpiry: async (task: {
            number: number;
            state: "open" | "closed";
          }) => {
            alerts.add(task.number);
            const owner = owners.find(
              ({ id }) => tasks.get(id)?.number === task.number,
            );
            if (!owner) {
              throw new TypeError("Alert fixture missing");
            }
            fail(owner, "alertExpiry");
          },
        };
        const run = applyHealing({
          actions,
          now: new Date("2026-10-14T00:00:00Z"),
          report: {
            sha: "base",
            observedAt: evidence.observedAt,
            failures: [],
            entries: owners.map((owner) => ({
              entry: owner,
              outcome: {
                ...green,
                status: "red",
                evidence: { ...evidence, passed: 2 },
              },
            })),
          },
        });
        if (subsets.some((subset) => subset.length > 0)) {
          const error = await rejectionOf(run);
          if (!(error instanceof HealingRunError)) {
            throw new TypeError("Expected typed healing aggregate");
          }
          expect(
            error.failures.map(({ key, stage }) => ({ key, stage })),
          ).toEqual(expected);
          expect(
            JSON.stringify(renderHealingFailureSignal(error)),
          ).not.toContain("PRIVATE FAILURE");
          expect(
            error.failures.every(({ cause }) => cause instanceof Error),
          ).toBe(true);
        } else {
          await run;
        }
        expect(tasks.size).toBe(owners.length);
        expect(alerts.size).toBe(owners.length);
        expect(retired.size).toBe(owners.length);
      },
    ),
    { seed: 261_017, numRuns: 100 },
  );
});

test("two red entries both publish tasks and expiry alerts when the first retirement fails", async () => {
  const first = { ...entry, id: "first" };
  const second = { ...entry, id: "second" };
  const tasks: string[] = [];
  const alerts: number[] = [];
  const run = scenario([]);
  const error = await rejectionOf(
    applyHealing({
      now: new Date("2026-10-14T00:00:00Z"),
      report: {
        sha: "base",
        observedAt: evidence.observedAt,
        failures: [],
        entries: [first, second].map((owner) => ({
          entry: owner,
          outcome: {
            ...green,
            status: "red",
            evidence: { ...evidence, passed: 2 },
          },
        })),
      },
      actions: {
        ...run.actions,
        openFixTask: async (owner) => {
          tasks.push(owner.id);
          return { number: tasks.length, state: "open" };
        },
        retireRemoval: async (owner) => {
          if (owner.id === first.id) {
            throw new HealingError({ message: "Retirement unavailable" });
          }
        },
        alertExpiry: async ({ number }) => {
          alerts.push(number);
        },
      },
    }),
  );
  expect(tasks).toEqual(["first", "second"]);
  expect(alerts).toEqual([1, 2]);
  expect(error).toMatchObject({
    failures: [{ key: waiverKey(first), stage: "retireRemoval" }],
  });
});

const GREEN_FAILURE_PROPERTY =
  "dated healing completes sibling green entries after publication failures";
test(GREEN_FAILURE_PROPERTY, async () => {
  await assertProperty(
    GREEN_FAILURE_PROPERTY,
    fc.asyncProperty(
      fc.array(
        fc.record({
          stage: fc.constantFrom(
            "none",
            "assessRemoval",
            "openRemoval",
            "resolveFixTask",
            "armRemoval",
          ),
          retirement: fc.boolean(),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      async (cases) => {
        const owners = cases.map((_, index) => ({
          ...entry,
          id: `green-${index}`,
        }));
        const published = new Set<string>();
        const resolved = new Set<string>();
        const armed = new Set<string>();
        const expected: Pick<HealingFailure, "key" | "stage">[] = [];
        const fail = (owner: DatedWaiver, stage: HealingFailure["stage"]) => {
          const config = cases.at(
            owners.findIndex(({ id }) => id === owner.id),
          );
          if (!config) {
            throw new TypeError("Green fixture missing");
          }
          if (
            config.stage === stage ||
            (stage === "retireRemoval" && config.retirement)
          ) {
            expected.push({ key: waiverKey(owner), stage });
            throw new HealingError({
              message: "Private operation unavailable",
            });
          }
        };
        const actions = {
          ...scenario([]).actions,
          assessRemoval: async (owner: DatedWaiver) => {
            fail(owner, "assessRemoval");
            return { status: "eligible" as const };
          },
          openRemoval: async ({ entry: owner }: HealingEntry) => {
            published.add(owner.id);
            fail(owner, "openRemoval");
            return owners.findIndex(({ id }) => id === owner.id) + 1;
          },
          resolveFixTask: async (owner: DatedWaiver) => {
            expect(published.has(owner.id)).toBe(true);
            fail(owner, "resolveFixTask");
            resolved.add(owner.id);
          },
          armRemoval: async (number: number) => {
            const owner = owners.at(number - 1);
            if (!owner) {
              throw new TypeError("Proposal fixture missing");
            }
            expect(resolved.has(owner.id)).toBe(true);
            fail(owner, "armRemoval");
            armed.add(owner.id);
          },
          retireRemoval: async (owner: DatedWaiver) => {
            fail(owner, "retireRemoval");
          },
        };
        const run = applyHealing({
          actions,
          now: new Date("2026-10-12"),
          report: {
            sha: "base",
            observedAt: evidence.observedAt,
            failures: [],
            entries: owners.map((owner) => ({ entry: owner, outcome: green })),
          },
        });
        if (cases.some(({ stage }) => stage !== "none")) {
          const error = await rejectionOf(run);
          if (!(error instanceof HealingRunError)) {
            throw new TypeError("Expected typed green aggregate");
          }
          expect(
            error.failures.map(({ key, stage }) => ({ key, stage })),
          ).toEqual(expected);
        } else {
          await run;
        }
        expect([...armed]).toEqual(
          owners
            .filter((_, index) => cases.at(index)?.stage === "none")
            .map(({ id }) => id),
        );
      },
    ),
    { seed: 261_018, numRuns: 100 },
  );
});

test("blocked and lapsed entries still alert and retire independently", async () => {
  const blocked = { ...entry, id: "blocked" };
  const expired = {
    ...entry,
    id: "expired",
    expiresAt: "2026-10-13T00:00:00.000Z",
  };
  const alerts: number[] = [];
  const retired: string[] = [];
  const actions = {
    ...scenario([]).actions,
    findTask: async () => ({ number: 1, state: "open" as const }),
    assessRemoval: async () => ({
      status: "blocked" as const,
      task: { number: 2, state: "open" as const },
    }),
    alertExpiry: async ({ number }: { number: number }) => {
      alerts.push(number);
      throw new HealingError({ message: "Alert unavailable" });
    },
    retireRemoval: async (owner: DatedWaiver) => {
      retired.push(owner.id);
      throw new HealingError({ message: "Retirement unavailable" });
    },
  };
  const error = await rejectionOf(
    applyHealing({
      actions,
      now: new Date("2026-10-14"),
      report: {
        sha: "base",
        observedAt: evidence.observedAt,
        failures: [],
        entries: [
          { entry: blocked, outcome: green },
          { entry: expired, outcome: { status: "expired" } },
        ],
      },
    }),
  );
  expect(alerts).toEqual([1, 2]);
  expect(retired).toEqual(["expired", "blocked"]);
  expect(error).toMatchObject({
    failures: [
      { key: waiverKey(expired), stage: "alertExpiry" },
      { key: waiverKey(expired), stage: "retireRemoval" },
      { key: waiverKey(blocked), stage: "alertExpiry" },
      { key: waiverKey(blocked), stage: "retireRemoval" },
    ],
  });
});

const PROBE_FAILURE_PROPERTY =
  "dated probe batches preserve every sibling result across setup failures";
test(PROBE_FAILURE_PROPERTY, async () => {
  await assertProperty(
    PROBE_FAILURE_PROPERTY,
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
      async (cases) => {
        const owners = cases.map((_, index) => ({
          ...entry,
          id: `probe-${index}`,
        }));
        const attempted: string[] = [];
        const report = await collectProbeReport({
          due: owners,
          sha: "base",
          now: new Date("2026-10-12"),
          probe: async (owner) => {
            attempted.push(owner.id);
            if (cases.at(owners.findIndex(({ id }) => id === owner.id))) {
              throw new HealingError({ message: "Setup unavailable" });
            }
            return green;
          },
          failedProbe: () => ({
            ...green,
            status: "red",
            evidence: { ...evidence, attempts: 0, passed: 0 },
          }),
        });
        expect(attempted).toEqual(owners.map(({ id }) => id));
        expect(report.entries).toHaveLength(owners.length);
        expect(report.failures).toEqual(
          owners
            .filter((_, index) => cases.at(index))
            .map((owner) => ({ key: waiverKey(owner), stage: "probe" })),
        );
        const tasks: string[] = [];
        const actions = {
          ...scenario([]).actions,
          openFixTask: async (owner: DatedWaiver) => {
            tasks.push(owner.id);
            return { number: tasks.length, state: "open" as const };
          },
        };
        if (report.failures.length > 0) {
          expect(
            await rejectionOf(
              applyHealing({ report, actions, now: new Date("2026-10-12") }),
            ),
          ).toMatchObject({ failures: report.failures });
        } else {
          await applyHealing({ report, actions, now: new Date("2026-10-12") });
        }
        expect(tasks).toEqual(
          owners.filter((_, index) => cases.at(index)).map(({ id }) => id),
        );
      },
    ),
    { seed: 261_019, numRuns: 100 },
  );
});

test("report binding keeps valid siblings and carries every malformed entry to publication failure", async () => {
  const owner = (await loadWaivers()).at(0);
  if (!owner) {
    throw new TypeError("Committed inventory fixture missing");
  }
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(git.exitCode).toBe(0);
  const sha = new TextDecoder().decode(git.stdout).trim();
  const directory = mkdtempSync(path.join(tmpdir(), "waiver-report-"));
  const file = path.join(directory, "report.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        sha,
        observedAt: evidence.observedAt,
        failures: [],
        entries: [
          null,
          { entry: owner, outcome: { status: "expired" } },
          { entry: null },
          { entry: owner, outcome: { status: "expired" } },
          { entry: owner, outcome: { status: "unavailable" } },
        ],
      }),
    );
    const report = await readReport(file);
    expect(report.entries).toHaveLength(3);
    expect(report.failures).toEqual([
      { key: "evidence-0", stage: "evidence" },
      { key: "evidence-2", stage: "evidence" },
      { key: waiverKey(owner), stage: "evidence" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unavailable report round trips preserve exactly the recorded failures", async () => {
  const owner = (await loadWaivers()).at(0);
  if (!owner) {
    throw new TypeError("Committed inventory fixture missing");
  }
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(git.exitCode).toBe(0);
  const report = {
    sha: new TextDecoder().decode(git.stdout).trim(),
    observedAt: evidence.observedAt,
    failures: [
      { key: waiverKey(owner), stage: "probe" },
      { key: waiverKey(owner), stage: "evidence" },
    ],
    entries: [{ entry: owner, outcome: { status: "unavailable" } }],
  } satisfies Parameters<typeof applyHealing>[0]["report"];
  const directory = mkdtempSync(path.join(tmpdir(), "waiver-report-"));
  const file = path.join(directory, "report.json");
  try {
    writeFileSync(file, JSON.stringify(report));
    for (let round = 0; round < 2; round++) {
      const restored = await readReport(file);
      expect(restored).toEqual(report);
      writeFileSync(file, JSON.stringify(restored));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const effectCases = {
  openFixTask: { stage: "openFixTask", outcome: "red" },
  findTask: { stage: "findTask", outcome: "expired" },
  alertExpiry: { stage: "alertExpiry", outcome: "red" },
  retireRemoval: { stage: "retireRemoval", outcome: "red" },
  assessRemoval: { stage: "assessRemoval", outcome: "green" },
  openRemoval: { stage: "openRemoval", outcome: "green" },
  resolveFixTask: { stage: "resolveFixTask", outcome: "green" },
  armRemoval: { stage: "armRemoval", outcome: "green" },
} as const satisfies {
  [Stage in keyof HealingActions]: {
    stage: Stage;
    outcome: "green" | "red" | "expired";
  };
};

for (const { stage, outcome } of Object.values(effectCases)) {
  test(`${stage} failures are collected independently for every entry`, async () => {
    const owners = ["first", "second"].map((id) => ({
      ...entry,
      id,
      expiresAt:
        outcome === "expired" ? "2026-10-13T00:00:00.000Z" : entry.expiresAt,
    }));
    const actions: HealingActions = { ...scenario([]).actions };
    actions[stage] = async () => {
      throw new HealingError({ message: "Operation unavailable" });
    };
    const error = await rejectionOf(
      applyHealing({
        actions,
        now: new Date("2026-10-14"),
        report: {
          sha: "base",
          observedAt: evidence.observedAt,
          failures: [],
          entries: owners.map((owner) => ({
            entry: owner,
            outcome:
              outcome === "expired"
                ? { status: "expired" }
                : {
                    ...green,
                    status: outcome,
                    evidence: {
                      ...evidence,
                      passed: outcome === "red" ? 2 : 3,
                    },
                  },
          })),
        },
      }),
    );
    expect(error).toMatchObject({
      failures: owners.map((owner) => ({ key: waiverKey(owner), stage })),
    });
  });
}

test("unavailable probe evidence retains its owner for safe retirement while siblings complete", async () => {
  const failed = { ...entry, id: "failed" };
  const expired = {
    ...entry,
    id: "expired",
    expiresAt: "2026-10-11T00:00:00.000Z",
  };
  const healthy = { ...entry, id: "healthy" };
  const attempted: string[] = [];
  const report = await collectProbeReport({
    due: [expired, failed, healthy],
    sha: "base",
    now: new Date("2026-10-12"),
    probe: async (owner) => {
      attempted.push(owner.id);
      if (owner.id === failed.id) {
        throw new HealingError({ message: "Probe unavailable" });
      }
      return green;
    },
    failedProbe: () => {
      throw new HealingError({ message: "Evidence unavailable" });
    },
  });
  expect(attempted).toEqual(["failed", "healthy"]);
  expect(report.entries.map(({ outcome }) => outcome.status)).toEqual([
    "expired",
    "unavailable",
    "green",
  ]);
  const retired: string[] = [];
  const actions = {
    ...scenario([]).actions,
    retireRemoval: async (owner: DatedWaiver) => {
      retired.push(owner.id);
    },
  };
  const error = await rejectionOf(
    applyHealing({ report, actions, now: new Date("2026-10-12") }),
  );
  expect(retired).toEqual(["expired", "failed"]);
  expect(error).toMatchObject({
    failures: [
      { key: waiverKey(failed), stage: "probe" },
      { key: waiverKey(failed), stage: "evidence" },
    ],
  });
});

test("the job boundary emits every aggregate failure without private causes", async () => {
  const failures = ["first", "second"].map((id) => ({
    key: waiverKey({ ...entry, id }),
    stage: "retireRemoval" as const,
    cause: new HealingError({ message: "PRIVATE FAILURE" }),
  }));
  const completed = await runHealingBoundary(async () => {
    throw new HealingRunError({ message: "PRIVATE FAILURE", failures });
  });
  expect(completed.status).toBe("failed");
  switch (completed.status) {
    case "complete":
      throw new TypeError("Expected failed boundary");
    case "failed":
      break;
    default:
      completed satisfies never;
      throw new TypeError("Unhandled boundary status");
  }
  expect(JSON.parse(completed.output)).toEqual({
    signal: "dated-waiver-failed",
    failures: failures.map(({ key, stage }) => ({ key, stage })),
  });
  expect(completed.output).not.toContain("PRIVATE FAILURE");
  expect(await runHealingBoundary(async () => {})).toEqual({
    status: "complete",
  });
  const unknown = await runHealingBoundary(async () => {
    throw new TypeError("PRIVATE FAILURE");
  });
  expect(unknown).toEqual({
    status: "failed",
    output: "Dated waiver healing failed; diagnostic output withheld.",
  });
});
