import { expect, test } from "bun:test";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createPrivateTaskSink,
  DATED_WAIVER_AUTOFIX_LABEL,
  FIX_TASK_IDENTITY_LABEL,
  EXPIRY_ALERT_LABEL,
  probeSourceFingerprint,
  waiverKey,
} from "./dated-waiver-fix-task";
import type { FixEvidence } from "./dated-waiver-fix-task";
import {
  applyHealing,
  armRemovalThroughBar,
  executeProbeCommand,
  redactProbeOutput,
  renderRemovalEvidence,
  type HealingEntry,
} from "./dated-waiver-healing";
import {
  createProbeBudget,
  PROBE_PHASE_BUDGET_MS,
  runWaiverProbe,
} from "./dated-waiver-probes";
import type { DatedWaiver } from "./dated-waivers";

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
    run: (now: string) =>
      applyHealing({
        report: { sha: "base", observedAt: "2026-10-10", entries: records },
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
      message:
        "Removal merge bar refused or failed; diagnostic output withheld.",
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
    message: "Removal merge bar refused or failed; diagnostic output withheld.",
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
      message: expect.stringContaining(
        "Removal requires all declared probes to pass",
      ),
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
    run: (command) =>
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
    run: (command) => {
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
    message: expect.stringContaining(
      "Expired waiver evidence precedes its owner deadline",
    ),
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
  const task = await sink.openFixTask(entry, evidence);
  await sink.resolveFixTask(entry, {
    ...evidence,
    sha: "resolved-head",
    sourceFingerprint: "fixed-source",
  });
  expect(fake.tasks.at(0)?.state).toBe("closed");
  const writes = fake.writes.length;
  await sink.resolveFixTask(entry, {
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

const resolutionScenario = async () => {
  const fake = taskFixture();
  const sink = await createPrivateTaskSink({
    repo: "stella/companion",
    request: fake.request,
    ensureLabel: fake.ensureLabel,
  });
  const effects: string[] = [];
  let now = "2026-10-12T00:00:00Z";
  const actions = {
    ...sink,
    openRemoval: async () => {
      effects.push("remove");
      return 42;
    },
    resolveFixTask: async (owner: DatedWaiver, proof: FixEvidence) => {
      await sink.resolveFixTask(owner, proof);
      effects.push("resolve");
    },
    armRemoval: async () => {
      effects.push("arm");
    },
  };
  const run = (status: "red" | "green", proof: FixEvidence) =>
    applyHealing({
      now: new Date(now),
      actions,
      report: {
        sha: proof.sha,
        observedAt: "2026-10-12",
        entries: [{ entry, outcome: { ...green, status, evidence: proof } }],
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
