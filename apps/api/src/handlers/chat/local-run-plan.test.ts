import type { RunAgentResumeItem } from "@tanstack/ai";
import { EventType } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { AI_FAILURE_CODES } from "@stll/api-contract/ai-errors";
import {
  CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS,
  CHAT_LOCAL_RUN_REFUSAL,
  type ChatRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_FEATURE_ID,
  DESKTOP_RUNNER_REASONING_EFFORTS,
} from "@stll/api-contract/desktop-runner";

import { approvalDecisionOf } from "@/api/handlers/chat/local-run-chunks";
import {
  resolveChatLocalRun,
  type ResolveChatLocalRunOptions,
} from "@/api/handlers/chat/local-run-plan";
import { toSafeId } from "@/api/lib/branded-types";
import {
  chatRunTargetOf,
  sameChatRunTarget,
  storedChatRunTarget,
} from "@/api/lib/chat/run-target";
import type { PublicStreamChunk } from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  DesktopRunnerControl,
  PickedDesktop,
  StartLocalRunInput,
  StartLocalRunOutcome,
} from "@/api/lib/desktop-runner/control";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const ORGANIZATION_ID = toSafeId<"organization">(
  "00000000-0000-4000-8000-000000000001",
);
const USER_ID = toSafeId<"user">("00000000-0000-4000-8000-000000000002");
const THREAD_ID = toSafeId<"chatThread">(Bun.randomUUIDv7());
const MODEL = "gpt-5-codex";
const LOCAL: ChatRunTarget = {
  kind: "local",
  harness: "codex",
  model: MODEL,
  approvals: "ask",
  reasoningEffort: null,
};

const snapshotWith = (granted: boolean) =>
  createFeatureAccessSnapshot({
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    decisions: new Map([
      [
        DESKTOP_RUNNER_FEATURE_ID,
        decideFeatureAccess({
          registry: FEATURE_REGISTRY,
          featureId: DESKTOP_RUNNER_FEATURE_ID,
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          membership: true,
          user: { email: "member@example.test", emailVerified: true },
          enrolments: granted
            ? [
                {
                  featureId: DESKTOP_RUNNER_FEATURE_ID,
                  organizationId: ORGANIZATION_ID,
                  userId: USER_ID,
                },
              ]
            : [],
          grants: granted
            ? {
                [DESKTOP_RUNNER_FEATURE_ID]: [
                  { type: "organization", organizationId: ORGANIZATION_ID },
                ],
              }
            : {},
        }),
      ],
    ]),
  });

/**
 * A control that picks `picked` and answers a run's insert with `inserted`,
 * recording what each was asked.
 */
const startingControl = (
  picked: PickedDesktop,
  inserted: StartLocalRunOutcome,
) => {
  const picks: unknown[] = [];
  const starts: StartLocalRunInput[] = [];
  const control = asTestRaw<DesktopRunnerControl>({
    pickDesktop: async (options: unknown) => {
      picks.push(options);
      return await Promise.resolve(Result.ok(picked));
    },
    readChatRunSession: async () =>
      await Promise.resolve(Result.ok({ type: "fresh" })),
    startRun: async (input: StartLocalRunInput) => {
      starts.push(input);
      return await Promise.resolve(Result.ok(inserted));
    },
  });
  return { control, picks, starts };
};

const READY: Extract<PickedDesktop, { type: "available" }> = {
  type: "available",
  desktopId: Bun.randomUUIDv7(),
  harness: {
    id: "codex",
    state: "ready",
    version: "0.50.0",
    capabilities: ["approvals", "interrupt"],
    // A harness that offers only Ask.
    approvalModes: ["ask"],
    models: [
      { id: MODEL, label: "GPT-5 Codex", reasoningEfforts: ["low", "high"] },
    ],
  },
  linkedFolders: [],
  approvedFolderIds: [],
};

/** The insert's answer the cases below never reach, or reach to end the turn. */
const TOO_LARGE = { type: "too_large" } as const satisfies StartLocalRunOutcome;

const resolve = async ({
  runTarget,
  picked = READY,
  inserted = TOO_LARGE,
  granted = true,
  agentSandboxRequested = false,
  resumesPausedRun = false,
  readApprovalCeiling = async () =>
    await Promise.resolve(Result.ok(CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS)),
}: {
  /** The send's target; a local one unless the case says otherwise. */
  runTarget?: ChatRunTarget | "none";
  picked?: PickedDesktop;
  inserted?: StartLocalRunOutcome;
  granted?: boolean;
  agentSandboxRequested?: boolean;
  resumesPausedRun?: boolean;
  readApprovalCeiling?: ResolveChatLocalRunOptions["readApprovalCeiling"];
} = {}) => {
  const { control, picks, starts } = startingControl(picked, inserted);
  const resolved = await resolveChatLocalRun({
    runTarget: runTarget === "none" ? undefined : (runTarget ?? LOCAL),
    agentSandboxRequested,
    resumesPausedRun,
    featureAccessSnapshot: snapshotWith(granted),
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    chatThreadId: THREAD_ID,
    workspaceIds: [],
    readApprovalCeiling,
    runtime: { control, runBell: createLocalRunBell() },
  });
  return { resolved, picks, starts };
};

const refusalCodeOf = (
  resolved: Awaited<ReturnType<typeof resolve>>["resolved"],
) => {
  if (resolved.isOk()) {
    return null;
  }
  expect(HandlerError.is(resolved.error)).toBe(true);
  return HandlerError.is(resolved.error) ? resolved.error.code : null;
};

/**
 * The send is accepted and the turn's run starts: the failure the stored
 * turn ends with, and what the pick and the insert were asked.
 */
const start = async (options: Parameters<typeof resolve>[0] = {}) => {
  const { resolved, picks, starts } = await resolve(options);
  const run = resolved.isOk() ? resolved.value : undefined;
  if (run === undefined) {
    return panic("The send was refused before its turn could be stored");
  }
  const chunks: PublicStreamChunk[] = [];
  for await (const chunk of run.stream({
    chatRunId: "chat-run-1",
    chatTurnId: toSafeId<"chatTurn">(Bun.randomUUIDv7()),
    messages: [],
    instructions: "",
    resume: undefined,
    abortSignal: new AbortController().signal,
  })) {
    chunks.push(chunk);
  }
  const failed = chunks.find((chunk) => chunk.type === EventType.RUN_ERROR);
  return {
    // The run is opened before it fails, so the page reads a failed turn.
    types: chunks.map(({ type }) => type),
    failure: failed?.type === EventType.RUN_ERROR ? failed.code : undefined,
    picks,
    starts,
  };
};

describe("a turn in a folder linked on the member's computer", () => {
  const LINK_ID = "0192f3a0-6b1c-7d2e-8f30-0000000000d1";
  const FOLDER = {
    desktopId: READY.desktopId,
    linkId: LINK_ID,
    name: "Smith v Jones",
  };
  const IN_FOLDER: ChatRunTarget = {
    kind: "local",
    harness: "codex",
    model: MODEL,
    approvals: "ask",
    reasoningEffort: null,
    folder: FOLDER,
  };
  const computerWith = (
    state: "available" | "offline",
    approved: boolean,
  ): PickedDesktop => ({
    ...READY,
    linkedFolders: [{ id: LINK_ID, name: FOLDER.name, state }],
    approvedFolderIds: approved ? [LINK_ID] : [],
  });

  test("starts only on the folder's computer and carries the link", async () => {
    const { picks, starts } = await start({
      runTarget: IN_FOLDER,
      picked: computerWith("available", true),
    });
    expect(picks).toEqual([
      expect.objectContaining({ harness: "codex", desktopId: READY.desktopId }),
    ]);
    expect(starts).toEqual([
      expect.objectContaining({
        desktopId: READY.desktopId,
        linkedFolderId: LINK_ID,
      }),
    ]);
  });

  test("fails with its own reason until the member allows the folder, and while it is not available", async () => {
    const pending = await start({
      runTarget: IN_FOLDER,
      picked: computerWith("available", false),
    });
    expect(pending.failure).toBe(
      AI_FAILURE_CODES.local_runner_folder_not_approved,
    );
    const offline = await start({
      runTarget: IN_FOLDER,
      picked: computerWith("offline", true),
    });
    expect(offline.failure).toBe(
      AI_FAILURE_CODES.local_runner_folder_unavailable,
    );
    const away = await start({
      runTarget: IN_FOLDER,
      picked: { type: "no_computer" },
    });
    expect(away.failure).toBe(AI_FAILURE_CODES.local_runner_folder_unavailable);
    for (const { starts } of [pending, offline, away]) {
      expect(starts).toEqual([]);
    }
  });
});

describe("a send for the member's computer, before anything is stored", () => {
  test("a turn without a local target stays on stella's own path", async () => {
    for (const runTarget of ["none", { kind: "cloud" }] as const) {
      const { resolved, picks } = await resolve({ runTarget, granted: false });
      expect(resolved.isOk() && resolved.value).toBeUndefined();
      expect(picks).toEqual([]);
    }
  });

  test("a member without the feature is refused", async () => {
    const { resolved, picks } = await resolve({ granted: false });
    expect(refusalCodeOf(resolved)).toBe(CHAT_LOCAL_RUN_REFUSAL.unavailable);
    expect(picks).toEqual([]);
  });

  test("a turn cannot ask for the agent sandbox and a computer at once", async () => {
    const { resolved } = await resolve({ agentSandboxRequested: true });
    expect(refusalCodeOf(resolved)).toBe(
      CHAT_LOCAL_RUN_REFUSAL.conflictingRunMode,
    );
  });

  test("no computer's state refuses the send: it is accepted without one being picked", async () => {
    const states = [
      { type: "no_computer" },
      {
        type: "harness_unavailable",
        desktopId: Bun.randomUUIDv7(),
        report: { id: "codex", state: "needs_login", version: "0.50.0" },
      },
      READY,
    ] as const satisfies readonly PickedDesktop[];
    for (const picked of states) {
      const { resolved, picks } = await resolve({ picked });
      expect(resolved.isOk() && resolved.value?.harness).toBe("codex");
      expect(picks).toEqual([]);
    }
  });

  test("a resumed turn answers its paused run wherever it is, without rereading the ceiling", async () => {
    let ceilingReads = 0;
    const { resolved, picks } = await resolve({
      resumesPausedRun: true,
      picked: { type: "no_computer" },
      runTarget: { ...LOCAL, approvals: "full_auto" },
      readApprovalCeiling: async () => {
        ceilingReads += 1;
        return await Promise.resolve(Result.ok("ask"));
      },
    });
    expect(resolved.isOk() && resolved.value?.harness).toBe("codex");
    expect(picks).toEqual([]);
    expect(ceilingReads).toBe(0);
  });

  test("a ceiling that cannot be read fails the send", async () => {
    const failure = new DatabaseError({
      message: "settings unavailable",
      cause: undefined,
    });
    const { resolved, picks } = await resolve({
      readApprovalCeiling: async () =>
        await Promise.resolve(Result.err(failure)),
    });
    expect(resolved.isErr() && resolved.error).toBe(failure);
    expect(picks).toEqual([]);
  });
});

describe("an accepted turn whose computer cannot take it", () => {
  test("fails with the reason for what the computer reports, after its run is opened", async () => {
    const cases = [
      [{ type: "no_computer" }, AI_FAILURE_CODES.local_runner_no_computer],
      [
        {
          type: "harness_unavailable",
          desktopId: Bun.randomUUIDv7(),
          report: { id: "codex", state: "needs_login", version: "0.50.0" },
        },
        AI_FAILURE_CODES.local_runner_needs_login,
      ],
      [
        {
          type: "harness_unavailable",
          desktopId: Bun.randomUUIDv7(),
          report: { id: "codex", state: "not_installed" },
        },
        AI_FAILURE_CODES.local_runner_harness_unavailable,
      ],
      [
        {
          type: "harness_unavailable",
          desktopId: Bun.randomUUIDv7(),
          report: null,
        },
        AI_FAILURE_CODES.local_runner_harness_unavailable,
      ],
      [
        {
          ...READY,
          harness: {
            ...READY.harness,
            models: [
              { id: "another-model", label: "Another", reasoningEfforts: [] },
            ],
          },
        },
        AI_FAILURE_CODES.local_runner_model_unavailable,
      ],
    ] as const satisfies readonly (readonly [PickedDesktop, string])[];
    for (const [picked, code] of cases) {
      const { failure, types, starts } = await start({ picked });
      expect(failure).toBe(code);
      expect(types.at(0)).toBe(EventType.RUN_STARTED);
      // Nothing is asked of a computer that cannot take the turn.
      expect(starts).toEqual([]);
    }
  });

  test("an approval mode the computer does not report fails with its own reason", async () => {
    for (const approvals of ["auto", "full_auto"] as const) {
      const { failure } = await start({ runTarget: { ...LOCAL, approvals } });
      expect(failure).toBe(AI_FAILURE_CODES.local_runner_approvals_unavailable);
    }
  });

  test("a reasoning effort the computer does not report for the model fails with its own reason", async () => {
    for (const reasoningEffort of ["max", "medium"] as const) {
      const { failure } = await start({
        runTarget: { ...LOCAL, reasoningEffort },
      });
      expect(failure).toBe(
        AI_FAILURE_CODES.local_runner_reasoning_effort_unavailable,
      );
    }
    for (const reasoningEffort of ["high", null] as const) {
      const { starts } = await start({
        runTarget: { ...LOCAL, reasoningEffort },
      });
      expect(starts).toEqual([expect.objectContaining({ reasoningEffort })]);
    }
  });

  test("a ready computer with the model is asked to start the run as picked", async () => {
    const { picks, starts } = await start();
    expect(picks).toEqual([
      {
        owner: { userId: USER_ID, organizationId: ORGANIZATION_ID },
        harness: "codex",
      },
    ]);
    expect(starts).toEqual([
      expect.objectContaining({
        desktopId: READY.desktopId,
        harness: "codex",
        harnessVersion: READY.harness.version,
        model: MODEL,
        approvals: "ask",
        linkedFolderId: null,
      }),
    ]);
  });

  test("the pick and the run's insert give one cause the same reason", async () => {
    // What the insert finds when the computer changed since the pick.
    const sameCause = [
      [{ type: "no_computer" }, { type: "no_computer" }],
      [
        {
          type: "harness_unavailable",
          desktopId: Bun.randomUUIDv7(),
          report: { id: "codex", state: "needs_login", version: "0.50.0" },
        },
        {
          type: "harness_unavailable",
          report: { id: "codex", state: "needs_login", version: "0.50.0" },
        },
      ],
      [
        { ...READY, harness: { ...READY.harness, models: [] } },
        { type: "model_unavailable" },
      ],
    ] as const satisfies readonly (readonly [
      PickedDesktop,
      StartLocalRunOutcome,
    ])[];
    for (const [picked, inserted] of sameCause) {
      const atPick = await start({ picked });
      const atInsert = await start({ inserted });
      expect(atPick.failure).toBeDefined();
      expect(atInsert.failure).toBe(atPick.failure ?? "");
      expect(atInsert.starts).toHaveLength(1);
    }
    // What only the insert can find.
    for (const [inserted, code] of [
      [{ type: "folder_busy" }, AI_FAILURE_CODES.local_runner_restoring],
      [{ type: "too_large" }, AI_FAILURE_CODES.local_runner_turn_too_large],
      [
        { type: "approvals_unavailable" },
        AI_FAILURE_CODES.local_runner_approvals_unavailable,
      ],
      [
        { type: "reasoning_effort_unavailable" },
        AI_FAILURE_CODES.local_runner_reasoning_effort_unavailable,
      ],
      [
        { type: "folder_unavailable" },
        AI_FAILURE_CODES.local_runner_folder_unavailable,
      ],
    ] as const satisfies readonly (readonly [StartLocalRunOutcome, string])[]) {
      expect((await start({ inserted })).failure).toBe(code);
    }
  });
});

describe("answering a paused run's approval", () => {
  const answers = [
    [{ interruptId: "r", status: "resolved", payload: true }, "approve"],
    [{ interruptId: "r", status: "resolved", payload: false }, "deny"],
    [
      { interruptId: "r", status: "resolved", payload: { approved: true } },
      "approve",
    ],
    [
      {
        interruptId: "r",
        status: "resolved",
        payload: { approved: true, scope: "session" },
      },
      "approve_for_session",
    ],
    [
      {
        interruptId: "r",
        status: "resolved",
        payload: { approved: false, scope: "session" },
      },
      "deny",
    ],
    [{ interruptId: "r", status: "resolved", payload: "yes" }, "deny"],
    [{ interruptId: "r", status: "resolved" }, "deny"],
    [{ interruptId: "r", status: "cancelled" }, "deny"],
  ] as const satisfies readonly (readonly [
    RunAgentResumeItem,
    (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number],
  ])[];

  test("each chat answer maps to one runner decision, and anything unclear denies", () => {
    for (const [item, decision] of answers) {
      expect(approvalDecisionOf(item)).toBe(decision);
    }
  });

  test("every runner decision is reachable from a chat answer", () => {
    expect(new Set(answers.map(([, decision]) => decision)).size).toBe(
      DESKTOP_RUNNER_APPROVAL_DECISIONS.length,
    );
  });
});

describe("a thread's stored run target", () => {
  test("a local target survives the thread column and cloud stores nothing", () => {
    for (const approvals of DESKTOP_RUNNER_APPROVAL_MODES) {
      const target: ChatRunTarget = { ...LOCAL, approvals };
      expect(chatRunTargetOf(storedChatRunTarget(target))).toEqual(target);
    }
    for (const reasoningEffort of DESKTOP_RUNNER_REASONING_EFFORTS) {
      const target: ChatRunTarget = { ...LOCAL, reasoningEffort };
      expect(chatRunTargetOf(storedChatRunTarget(target))).toEqual(target);
    }
    expect(storedChatRunTarget({ kind: "cloud" })).toBeNull();
    expect(chatRunTargetOf(null)).toEqual({ kind: "cloud" });
  });

  test("a send keeps the stored target only when it runs the same way", () => {
    expect(
      sameChatRunTarget(LOCAL, chatRunTargetOf(storedChatRunTarget(LOCAL))),
    ).toBe(true);
    expect(sameChatRunTarget({ kind: "cloud" }, { kind: "cloud" })).toBe(true);
    for (const other of [
      { kind: "cloud" },
      { ...LOCAL, model: `${MODEL}-mini` },
      { ...LOCAL, approvals: "full_auto" },
      { ...LOCAL, reasoningEffort: "high" },
    ] satisfies ChatRunTarget[]) {
      expect(sameChatRunTarget(LOCAL, other)).toBe(false);
      expect(sameChatRunTarget(other, LOCAL)).toBe(false);
    }
  });

  test("a stored value the contract no longer accepts reads as cloud", () => {
    for (const stored of [
      { ...LOCAL, harness: "opencode" },
      { ...LOCAL, model: "" },
      { ...LOCAL, approvals: "bypass" },
      { ...LOCAL, reasoningEffort: "turbo" },
      "codex::gpt-5-codex",
      {},
    ]) {
      expect(chatRunTargetOf(stored)).toEqual({ kind: "cloud" });
    }
  });

  test("a send that names no approval mode asks, and leaves the effort to the harness", () => {
    expect(
      v.parse(chatRunTargetSchema, {
        kind: "local",
        harness: "codex",
        model: MODEL,
      }),
    ).toEqual(LOCAL);
    expect(
      v.safeParse(chatRunTargetSchema, { ...LOCAL, approvals: "bypass" })
        .success,
    ).toBe(false);
  });
});
