import { describe, expect, test } from "bun:test";

import {
  CHAT_LOCAL_RUN_HARNESSES,
  type ChatLocalHarnessReadiness,
  type ChatLocalRunnerReadiness,
} from "@stll/api-contract/chat-run-target";

import {
  CHAT_LOCAL_HARNESS_NAMES,
  chatLocalHarnessOptions,
  effectiveRunTarget,
  localRunModelLabel,
  runTargetValue,
} from "@/components/chat/chat-run-target-menu.logic";

const READY_CODEX: ChatLocalHarnessReadiness = {
  id: "codex",
  state: "ready",
  version: "0.50.0",
  capabilities: ["approvals"],
  models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }],
};

const runner = (
  harnesses: ChatLocalHarnessReadiness[],
  connected = true,
): ChatLocalRunnerReadiness => ({
  desktopId: Bun.randomUUIDv7(),
  connected,
  lastSeenAt: "2026-11-03T10:00:00.000Z",
  harnesses,
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
      const options = chatLocalHarnessOptions({ status: "enabled", runners });
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
    });
    expect(options?.at(0)).toEqual({
      harness: "codex",
      state: "ready",
      models: READY_CODEX.models,
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
    });
    expect(options?.at(0)).toEqual({
      harness: "codex",
      state: "limit_until",
      resetsAt: "2026-11-03T12:00:00.000Z",
    });
    expect(stateOf(options, "claude-code")).toBe("not_installed");
  });
});

describe("the selected run target", () => {
  test("cloud and each local model have distinct menu values", () => {
    const values = [
      runTargetValue({ kind: "cloud" }),
      runTargetValue({ kind: "local", harness: "codex", model: "a" }),
      runTargetValue({ kind: "local", harness: "claude-code", model: "a" }),
      runTargetValue({ kind: "local", harness: "codex", model: "b" }),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  test("a thread without a stored target runs in the cloud", () => {
    expect(effectiveRunTarget(undefined)).toEqual({ kind: "cloud" });
  });

  test("the composer names a local model as the harness reports it, and only then", () => {
    const target = {
      kind: "local",
      harness: "codex",
      model: "gpt-5-codex",
    } as const;
    expect(
      localRunModelLabel(
        { status: "enabled", runners: [runner([READY_CODEX])] },
        target,
      ),
    ).toBe("GPT-5 Codex");
    // Another harness offering the same id does not name it.
    expect(
      localRunModelLabel(
        {
          status: "enabled",
          runners: [runner([{ ...READY_CODEX, id: "claude-code" }])],
        },
        target,
      ),
    ).toBeNull();
    expect(localRunModelLabel({ status: "hidden" }, target)).toBeNull();
    expect(localRunModelLabel(undefined, target)).toBeNull();
  });
});
