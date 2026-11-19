/* oxlint-disable require-contract-domains/require-contract-domains -- Generator bounds size simulated run lists, not an API domain or limit. */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_ACTIVE_RUN_STATE,
  CHAT_TURN_INTERACTION_TYPES,
} from "@stll/api-contract/chat";
import type { ChatActiveRun } from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import {
  matterRunsByWorkspace,
  topMatterRunState,
} from "@/features/chat/active-runs.logic";
import type { ActiveChatRunState } from "@/features/chat/active-runs.logic";

const MATTERS = ["matter_lease", "matter_spa", "matter_dismissal"] as const;
const SINCE = "2026-11-10T09:00:00.000Z";

const waiting = (threadId: string, workspaceId: string | null) =>
  ({
    interaction: "approval",
    since: SINCE,
    state: CHAT_ACTIVE_RUN_STATE.needsYou,
    threadId,
    threadTitle: threadId,
    workspaceId,
  }) satisfies ChatActiveRun;

const working = (threadId: string, workspaceId: string | null) =>
  ({
    since: SINCE,
    state: CHAT_ACTIVE_RUN_STATE.working,
    threadId,
    threadTitle: threadId,
    workspaceId,
  }) satisfies ChatActiveRun;

const runArbitrary = fc
  .record({
    interaction: fc.constantFrom(...CHAT_TURN_INTERACTION_TYPES),
    threadId: fc.uuid(),
    waits: fc.boolean(),
    workspaceId: fc.constantFrom<string | null>(...MATTERS, null),
  })
  .map(({ interaction, threadId, waits, workspaceId }): ChatActiveRun =>
    waits
      ? { ...waiting(threadId, workspaceId), interaction }
      : working(threadId, workspaceId),
  );

describe("matterRunsByWorkspace", () => {
  test("groups each matter's chats by state and leaves chats outside a matter out", () => {
    const runs = matterRunsByWorkspace([
      waiting("spa-question", "matter_spa"),
      working("spa-draft", "matter_spa"),
      working("spa-summary", "matter_spa"),
      working("lease-review", "matter_lease"),
      waiting("loose", null),
    ]);

    const threadIds = (state: "needsYou" | "working", matter: string) =>
      runs.get(matter)?.[state].map(({ threadId }) => threadId);
    expect([...runs.keys()].toSorted()).toEqual(["matter_lease", "matter_spa"]);
    expect(threadIds("needsYou", "matter_spa")).toEqual(["spa-question"]);
    expect(threadIds("working", "matter_spa")).toEqual([
      "spa-draft",
      "spa-summary",
    ]);
    expect(threadIds("needsYou", "matter_lease")).toEqual([]);
    expect(threadIds("working", "matter_lease")).toEqual(["lease-review"]);
  });

  test("a matter with no open chat has no entry", () => {
    expect(matterRunsByWorkspace([]).size).toBe(0);
  });

  test("every chat in a matter is listed exactly once, under its own state, in list order", () => {
    assertProperty(
      "every chat in a matter is listed exactly once, under its own state, in list order",
      fc.property(fc.array(runArbitrary, { maxLength: 40 }), (runs) => {
        const grouped = matterRunsByWorkspace(runs);
        for (const matter of MATTERS) {
          const own = runs.filter(({ workspaceId }) => workspaceId === matter);
          const listed = grouped.get(matter);
          if (own.length === 0) {
            expect(listed).toBeUndefined();
            continue;
          }
          const threadIdsIn = (state: ActiveChatRunState) =>
            own
              .filter((run) => run.state === state)
              .map(({ threadId }) => threadId);
          expect({
            needsYou: listed?.needsYou.map(({ threadId }) => threadId),
            working: listed?.working.map(({ threadId }) => threadId),
          }).toEqual({
            needsYou: threadIdsIn("needs-you"),
            working: threadIdsIn("working"),
          });
        }
        const matters = new Set<string>(MATTERS);
        expect([...grouped.keys()].every((key) => matters.has(key))).toBe(true);
      }),
    );
  });
});

describe("topMatterRunState", () => {
  test("a chat waiting on the reader outranks chats at work", () => {
    expect(
      topMatterRunState({
        needsYou: [waiting("question", "matter_spa")],
        working: [working("draft", "matter_spa")],
      }),
    ).toBe("needs-you");
    expect(
      topMatterRunState({
        needsYou: [],
        working: [working("draft", "matter_spa")],
      }),
    ).toBe("working");
  });

  test("a matter with nothing open shows nothing", () => {
    expect(topMatterRunState(undefined)).toBeNull();
    expect(topMatterRunState({ needsYou: [], working: [] })).toBeNull();
  });
});
