import type { RunAgentResumeItem } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_REFUSAL,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_FEATURE_ID,
} from "@stll/api-contract/desktop-runner";

import { approvalDecisionOf } from "@/api/handlers/chat/local-run-chunks";
import { resolveChatLocalRun } from "@/api/handlers/chat/local-run-plan";
import { toSafeId } from "@/api/lib/branded-types";
import {
  decodeChatRunTarget,
  encodeChatRunTarget,
} from "@/api/lib/chat/run-target";
import type {
  DesktopRunnerControl,
  PickedDesktop,
} from "@/api/lib/desktop-runner/control";
import { createLocalRunBell } from "@/api/lib/desktop-runner/doorbell";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
const LOCAL: ChatRunTarget = { kind: "local", harness: "codex", model: MODEL };

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

/** A control whose only answer is the computer it picks. */
const pickingControl = (picked: PickedDesktop) => {
  const picks: unknown[] = [];
  const control = asTestRaw<DesktopRunnerControl>({
    pickDesktop: async (options: unknown) => {
      picks.push(options);
      return await Promise.resolve(Result.ok(picked));
    },
  });
  return { control, picks };
};

const READY: PickedDesktop = {
  type: "available",
  desktopId: Bun.randomUUIDv7(),
  harness: {
    id: "codex",
    state: "ready",
    version: "0.50.0",
    capabilities: ["approvals", "interrupt"],
    models: [{ id: MODEL, label: "GPT-5 Codex" }],
  },
};

const resolve = async ({
  runTarget,
  picked = READY,
  granted = true,
  agentSandboxRequested = false,
  resumesPausedRun = false,
}: {
  /** The send's target; a local one unless the case says otherwise. */
  runTarget?: ChatRunTarget | "none";
  picked?: PickedDesktop;
  granted?: boolean;
  agentSandboxRequested?: boolean;
  resumesPausedRun?: boolean;
} = {}) => {
  const { control, picks } = pickingControl(picked);
  const resolved = await resolveChatLocalRun({
    runTarget: runTarget === "none" ? undefined : (runTarget ?? LOCAL),
    agentSandboxRequested,
    resumesPausedRun,
    featureAccessSnapshot: snapshotWith(granted),
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    chatThreadId: THREAD_ID,
    workspaceIds: [],
    runtime: { control, runBell: createLocalRunBell() },
  });
  return { resolved, picks };
};

const refusalCodeOf = (
  resolved: Awaited<ReturnType<typeof resolve>>["resolved"],
) => {
  if (resolved.isOk()) {
    return null;
  }
  expect(HandlerError.is(resolved.error)).toBe(true);
  return resolved.error.code;
};

describe("routing a chat turn to the member's computer", () => {
  test("a turn without a local target stays on stella's own path", async () => {
    for (const runTarget of ["none", { kind: "cloud" }] as const) {
      const { resolved, picks } = await resolve({ runTarget, granted: false });
      expect(resolved.isOk() && resolved.value).toBeUndefined();
      expect(picks).toEqual([]);
    }
  });

  test("a member without the feature is refused before any computer is picked", async () => {
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

  test("each computer that cannot take the turn refuses it with its own code, never cloud", async () => {
    const cases = [
      [{ type: "no_computer" }, CHAT_LOCAL_RUN_REFUSAL.noComputer],
      [
        {
          type: "harness_unavailable",
          desktopId: Bun.randomUUIDv7(),
          report: { id: "codex", state: "needs_login", version: "0.50.0" },
        },
        CHAT_LOCAL_RUN_REFUSAL.harnessUnavailable,
      ],
      [
        {
          ...READY,
          harness: {
            ...READY.harness,
            models: [{ id: "another-model", label: "Another" }],
          },
        },
        CHAT_LOCAL_RUN_REFUSAL.modelUnavailable,
      ],
    ] as const satisfies readonly (readonly [PickedDesktop, string])[];
    for (const [picked, code] of cases) {
      const { resolved } = await resolve({ picked });
      expect(refusalCodeOf(resolved)).toBe(code);
    }
  });

  test("a ready computer with the model takes the turn on the chosen harness", async () => {
    const { resolved, picks } = await resolve();
    expect(resolved.isOk() && resolved.value?.harness).toBe("codex");
    expect(picks).toEqual([
      {
        owner: { userId: USER_ID, organizationId: ORGANIZATION_ID },
        harness: "codex",
      },
    ]);
  });

  test("a resumed turn answers its paused run wherever it is, without picking a computer", async () => {
    const { resolved, picks } = await resolve({
      resumesPausedRun: true,
      picked: { type: "no_computer" },
    });
    expect(resolved.isOk() && resolved.value?.harness).toBe("codex");
    expect(picks).toEqual([]);
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
    expect(decodeChatRunTarget(encodeChatRunTarget(LOCAL))).toEqual(LOCAL);
    expect(encodeChatRunTarget({ kind: "cloud" })).toBeNull();
    expect(decodeChatRunTarget(null)).toEqual({ kind: "cloud" });
  });

  test("a stored value no harness accepts reads as cloud", () => {
    for (const stored of ["opencode::m", "codex::", "codex", "::m"]) {
      expect(decodeChatRunTarget(stored)).toEqual({ kind: "cloud" });
    }
  });

  test("a model id may itself contain the separator", () => {
    const target: ChatRunTarget = {
      kind: "local",
      harness: "claude-code",
      model: "vendor::model",
    };
    expect(decodeChatRunTarget(encodeChatRunTarget(target))).toEqual(target);
  });
});
