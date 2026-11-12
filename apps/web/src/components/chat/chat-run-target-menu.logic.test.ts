import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS,
  CHAT_LOCAL_RUN_HARNESSES,
  type ChatLocalHarnessReadiness,
  type ChatLocalRunnerReadiness,
  type ChatLocalRunReadiness,
} from "@stll/api-contract/chat-run-target";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import {
  CHAT_LOCAL_HARNESS_NAMES,
  type ChatLocalHarnessOption,
  chatLocalHarnessOptions,
  effectiveRunTarget,
  localRunMaxApprovals,
  localRunModelLabel,
  localRunTargetFor,
  localRunTargetState,
  permissionView,
  runTargetValue,
  sameRunTarget,
  withRunFolder,
} from "@/components/chat/chat-run-target-menu.logic";

/** The ceiling of an organization that never lowered it. */
const NO_LIMIT = CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS;

const READY_CODEX: ChatLocalHarnessReadiness = {
  id: "codex",
  state: "ready",
  version: "0.50.0",
  capabilities: ["approvals"],
  approvalModes: ["ask"],
  models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
};

const runner = (
  harnesses: ChatLocalHarnessReadiness[],
  connected = true,
  linkedFolders: ChatLocalRunnerReadiness["linkedFolders"] = [],
): ChatLocalRunnerReadiness => ({
  desktopId: Bun.randomUUIDv7(),
  connected,
  lastSeenAt: "2026-11-03T10:00:00.000Z",
  harnesses,
  linkedFolders,
});

const stateOf = (
  options: ReturnType<typeof chatLocalHarnessOptions>,
  harness: (typeof CHAT_LOCAL_RUN_HARNESSES)[number],
) => options?.find((option) => option.harness === harness)?.state;

describe("the Run on choices", () => {
  test("a member without the feature is offered no Run on choice at all", () => {
    expect(chatLocalHarnessOptions({ status: "hidden" })).toBeNull();
    expect(chatLocalHarnessOptions(undefined)).toBeNull();
  });

  test("every harness a turn can run on is listed, by its product name", () => {
    const options = chatLocalHarnessOptions({
      status: "enabled",
      runners: [runner([READY_CODEX])],
      maxApprovals: NO_LIMIT,
    });
    expect(options?.map(({ harness }) => harness)).toEqual([
      ...CHAT_LOCAL_RUN_HARNESSES,
    ]);
    expect(Object.keys(CHAT_LOCAL_HARNESS_NAMES).toSorted()).toEqual(
      [...CHAT_LOCAL_RUN_HARNESSES].toSorted(),
    );
  });

  test("without a connected computer every harness reads as offline", () => {
    for (const runners of [[], [runner([READY_CODEX], false)]]) {
      const options = chatLocalHarnessOptions({
        status: "enabled",
        runners,
        maxApprovals: NO_LIMIT,
      });
      expect(options?.map(({ state }) => state)).toEqual(
        CHAT_LOCAL_RUN_HARNESSES.map(() => "offline"),
      );
    }
  });

  test("a ready report on any connected computer wins, as the API routes there", () => {
    const options = chatLocalHarnessOptions({
      status: "enabled",
      runners: [
        runner([{ id: "codex", state: "needs_login", version: "0.50.0" }]),
        runner([READY_CODEX]),
      ],
      maxApprovals: NO_LIMIT,
    });
    expect(options?.at(0)).toEqual({
      harness: "codex",
      state: "ready",
      models: READY_CODEX.models,
      approvalModes: ["ask"],
    });
  });

  test("a harness that cannot run says why, and one never reported is not installed", () => {
    const options = chatLocalHarnessOptions({
      status: "enabled",
      runners: [
        runner([
          {
            id: "codex",
            state: "limit_until",
            version: "0.50.0",
            resetsAt: "2026-11-03T12:00:00.000Z",
          },
        ]),
      ],
      maxApprovals: NO_LIMIT,
    });
    expect(options?.at(0)).toEqual({
      harness: "codex",
      state: "limit_until",
      resetsAt: "2026-11-03T12:00:00.000Z",
    });
    expect(stateOf(options, "claude-code")).toBe("not_installed");
  });

  test("a harness its computer could not check reads as unavailable, never as unsupported", () => {
    const options = chatLocalHarnessOptions({
      status: "enabled",
      runners: [
        runner([
          { id: "codex", state: "unavailable", reason: "harness_failed" },
          { id: "claude-code", state: "unsupported", version: "1.0.0" },
        ]),
      ],
      maxApprovals: NO_LIMIT,
    });
    expect(options).toEqual([
      { harness: "codex", state: "unavailable" },
      { harness: "claude-code", state: "unsupported" },
    ]);
  });
});

const LOCAL = {
  kind: "local",
  harness: "codex",
  model: "gpt-5-codex",
  approvals: "ask",
} as const;

/** A Claude Code that cannot sandbox on this computer. */
const READY_CLAUDE: Extract<ChatLocalHarnessOption, { state: "ready" }> = {
  harness: "claude-code",
  state: "ready",
  models: [{ id: "sonnet", label: "Sonnet" }],
  approvalModes: ["ask", "auto"],
};
const CLAUDE = { ...LOCAL, harness: "claude-code", model: "sonnet" } as const;

describe("the permission choice", () => {
  test("is offered only for a local target whose harness is ready", () => {
    expect(
      permissionView({ kind: "cloud" }, [READY_CLAUDE], NO_LIMIT),
    ).toBeNull();
    expect(
      permissionView(
        CLAUDE,
        [{ harness: "claude-code", state: "needs_login" }],
        NO_LIMIT,
      ),
    ).toBeNull();
    expect(permissionView(CLAUDE, [READY_CLAUDE], NO_LIMIT)).toEqual({
      type: "choice",
      modes: [
        { mode: "ask", availability: "available" },
        { mode: "auto", availability: "available" },
        { mode: "full_auto", availability: "computer" },
      ],
    });
  });

  test("a mode above the organization's limit is unavailable for that reason; one the computer cannot run says so first", () => {
    expect(permissionView(CLAUDE, [READY_CLAUDE], "ask")).toEqual({
      type: "choice",
      modes: [
        { mode: "ask", availability: "available" },
        { mode: "auto", availability: "organization" },
        { mode: "full_auto", availability: "computer" },
      ],
    });
    const sandboxing = {
      ...READY_CLAUDE,
      approvalModes: ["ask", "auto", "full_auto"],
    } as const;
    expect(permissionView(CLAUDE, [sandboxing], "auto")).toEqual({
      type: "choice",
      modes: [
        { mode: "ask", availability: "available" },
        { mode: "auto", availability: "available" },
        { mode: "full_auto", availability: "organization" },
      ],
    });
  });

  test("a harness that runs in one mode offers no choice, only its fixed behaviour", () => {
    const [codex] =
      chatLocalHarnessOptions({
        status: "enabled",
        runners: [runner([READY_CODEX])],
        maxApprovals: NO_LIMIT,
      }) ?? [];
    expect(
      codex === undefined ? null : permissionView(LOCAL, [codex], NO_LIMIT),
    ).toEqual({ type: "fixed", harness: "codex" });
  });

  test("a picked model keeps the permission mode the harness supports, else asks", () => {
    const pick = (selected: Parameters<typeof sameRunTarget>[0]) =>
      localRunTargetFor({
        selected,
        option: READY_CLAUDE,
        model: "opus",
        maxApprovals: NO_LIMIT,
      });
    expect(pick({ ...CLAUDE, approvals: "auto" })).toEqual({
      ...CLAUDE,
      model: "opus",
      approvals: "auto",
    });
    expect(pick({ ...CLAUDE, approvals: "full_auto" })).toEqual({
      ...CLAUDE,
      model: "opus",
      approvals: "ask",
    });
    expect(pick({ kind: "cloud" })).toEqual({ ...CLAUDE, model: "opus" });
  });

  test("a picked model never carries a mode above the organization's limit", () => {
    expect(
      localRunTargetFor({
        selected: { ...CLAUDE, approvals: "auto" },
        option: READY_CLAUDE,
        model: "opus",
        maxApprovals: "ask",
      }),
    ).toEqual({ ...CLAUDE, model: "opus", approvals: "ask" });
  });
});

describe("the selected run target", () => {
  test("cloud and each local model have distinct menu values", () => {
    const values = [
      runTargetValue({ kind: "cloud" }),
      runTargetValue({ ...LOCAL, harness: "codex", model: "a" }),
      runTargetValue({ ...LOCAL, harness: "claude-code", model: "a" }),
      runTargetValue({ ...LOCAL, harness: "codex", model: "b" }),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  test("a different permission mode is a different target, under the same model", () => {
    const auto = { ...LOCAL, approvals: "auto" } as const;
    expect(runTargetValue(auto)).toBe(runTargetValue(LOCAL));
    expect(sameRunTarget(auto, LOCAL)).toBe(false);
    expect(sameRunTarget(LOCAL, { ...LOCAL })).toBe(true);
    expect(sameRunTarget({ kind: "cloud" }, LOCAL)).toBe(false);
  });

  test("a thread without a stored target runs in the cloud", () => {
    expect(effectiveRunTarget(undefined)).toEqual({ kind: "cloud" });
  });

  test("a thread whose mode is now above the organization's limit runs its next turn in the highest allowed mode", () => {
    const sandboxingClaude: ChatLocalHarnessReadiness = {
      ...READY_CODEX,
      id: "claude-code",
      approvalModes: ["ask", "auto", "full_auto"],
      models: [{ id: "sonnet", label: "Sonnet" }],
    };
    const readiness = (
      maxApprovals: DesktopRunnerApprovalMode,
      harness: ChatLocalHarnessReadiness = sandboxingClaude,
    ): ChatLocalRunReadiness => ({
      status: "enabled",
      runners: [runner([harness])],
      maxApprovals,
    });
    const stored = { ...CLAUDE, approvals: "full_auto" } as const;
    expect(effectiveRunTarget(stored, readiness("auto"))).toEqual({
      ...stored,
      approvals: "auto",
    });
    expect(effectiveRunTarget(stored, readiness("ask"))).toEqual({
      ...stored,
      approvals: "ask",
    });
    // A computer without the in-between mode falls past it, to Ask.
    expect(
      effectiveRunTarget(
        stored,
        readiness("auto", {
          ...sandboxingClaude,
          approvalModes: ["ask", "full_auto"],
        }),
      ),
    ).toEqual({ ...stored, approvals: "ask" });
    // Within the limit, or before the limit is known, the stored mode stands.
    expect(effectiveRunTarget(stored, readiness(NO_LIMIT))).toBe(stored);
    expect(effectiveRunTarget(stored, undefined)).toBe(stored);
    expect(effectiveRunTarget({ kind: "cloud" }, readiness("ask"))).toEqual({
      kind: "cloud",
    });
    expect(localRunMaxApprovals(readiness("auto"))).toBe("auto");
    expect(localRunMaxApprovals({ status: "hidden" })).toBe(NO_LIMIT);
  });

  test("the composer names a local model as the harness reports it, and only then", () => {
    const target = {
      kind: "local",
      harness: "codex",
      model: "gpt-5-codex",
      approvals: "ask",
    } as const;
    expect(
      localRunModelLabel(
        {
          status: "enabled",
          runners: [runner([READY_CODEX])],
          maxApprovals: NO_LIMIT,
        },
        target,
      ),
    ).toBe("GPT-5 Codex");
    // Another harness offering the same id does not name it.
    expect(
      localRunModelLabel(
        {
          status: "enabled",
          runners: [runner([{ ...READY_CODEX, id: "claude-code" }])],
          maxApprovals: NO_LIMIT,
        },
        target,
      ),
    ).toBeNull();
    expect(localRunModelLabel({ status: "hidden" }, target)).toBeNull();
    expect(localRunModelLabel(undefined, target)).toBeNull();
  });
});

describe("whether the chosen computer can take a turn now", () => {
  const CODEX = {
    kind: "local",
    harness: "codex",
    model: "gpt-5-codex",
    approvals: "ask",
  } as const;
  const enabled = (
    runners: ChatLocalRunnerReadiness[],
  ): ChatLocalRunReadiness => ({
    status: "enabled",
    runners,
    maxApprovals: NO_LIMIT,
  });

  test("a ready harness that offers the model can take it", () => {
    expect(
      localRunTargetState(enabled([runner([READY_CODEX])]), CODEX),
    ).toEqual({ type: "ready" });
  });

  test("a model the ready harness no longer offers cannot", () => {
    expect(
      localRunTargetState(enabled([runner([READY_CODEX])]), {
        ...CODEX,
        model: "gpt-4-codex",
      }),
    ).toEqual({ type: "model_unavailable" });
  });

  test("an offline computer says so, whatever model it last offered", () => {
    expect(
      localRunTargetState(enabled([runner([READY_CODEX], false)]), CODEX),
    ).toEqual({
      type: "harness",
      option: { harness: "codex", state: "offline" },
    });
  });

  test("a member who may not run turns on a computer is told so", () => {
    expect(localRunTargetState({ status: "hidden" }, CODEX)).toEqual({
      type: "not_allowed",
    });
  });
});

describe("a linked folder", () => {
  const LINK_ID = "0192f3a0-6b1c-7d2e-8f30-0000000000d1";
  const computer = (
    state: "available" | "offline" | "moved",
    approval: "approved" | "pending",
    connected = true,
  ) =>
    runner([READY_CODEX], connected, [
      { id: LINK_ID, name: "Smith v Jones", state, approval },
    ]);
  const readiness = (
    linked: ChatLocalRunnerReadiness,
  ): ChatLocalRunReadiness => ({
    status: "enabled",
    runners: [linked],
    maxApprovals: NO_LIMIT,
  });
  const inFolder = (linked: ChatLocalRunnerReadiness) =>
    withRunFolder(LOCAL, {
      desktopId: linked.desktopId,
      linkId: LINK_ID,
      name: "Smith v Jones",
    });

  test("takes a turn once available on a connected computer and allowed", () => {
    const linked = computer("available", "approved");
    expect(localRunTargetState(readiness(linked), inFolder(linked))).toEqual({
      type: "ready",
    });
  });

  test("waits for the member's OK before its first turn", () => {
    const linked = computer("available", "pending");
    expect(localRunTargetState(readiness(linked), inFolder(linked))).toEqual({
      type: "folder_pending",
    });
  });

  test("says why it cannot take a turn: offline, moved, its computer away, unlinked", () => {
    const offline = computer("offline", "approved");
    expect(localRunTargetState(readiness(offline), inFolder(offline))).toEqual({
      type: "folder",
      problem: "offline",
    });
    const moved = computer("moved", "approved");
    expect(localRunTargetState(readiness(moved), inFolder(moved))).toEqual({
      type: "folder",
      problem: "moved",
    });
    const away = computer("available", "approved", false);
    expect(
      localRunTargetState(
        {
          status: "enabled",
          runners: [away, runner([READY_CODEX])],
          maxApprovals: NO_LIMIT,
        },
        inFolder(away),
      ),
    ).toEqual({ type: "folder", problem: "computer_offline" });
    const elsewhere = computer("available", "approved");
    expect(
      localRunTargetState(
        readiness(runner([READY_CODEX])),
        inFolder(elsewhere),
      ),
    ).toEqual({ type: "folder", problem: "unlinked" });
  });

  test("stays with the chat when another model is picked, and differs from the chat's own folder", () => {
    const linked = computer("available", "approved");
    const target = inFolder(linked);
    const picked = localRunTargetFor({
      selected: target,
      option: READY_CLAUDE,
      model: "opus",
      maxApprovals: NO_LIMIT,
    });
    expect(picked.kind === "local" ? picked.folder : null).toEqual(
      target.folder,
    );
    expect(sameRunTarget(target, LOCAL)).toBe(false);
    expect(sameRunTarget(withRunFolder(target, undefined), LOCAL)).toBe(true);
  });
});
