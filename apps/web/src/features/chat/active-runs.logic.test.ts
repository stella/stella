/* oxlint-disable require-contract-domains/require-contract-domains -- Generator bounds size simulated run lists, not an API domain or limit. */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_ACTIVE_RUN_STATE } from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import {
  matterRunStatusByWorkspace,
  topMatterRunState,
} from "@/features/chat/active-runs.logic";

const MATTERS = ["matter_lease", "matter_spa", "matter_dismissal"] as const;

const runArbitrary = fc.record({
  state: fc.constantFrom(...Object.values(CHAT_ACTIVE_RUN_STATE)),
  workspaceId: fc.constantFrom<string | null>(...MATTERS, null),
});

describe("matterRunStatusByWorkspace", () => {
  test("counts each matter's chats by state and leaves chats outside a matter out", () => {
    const status = matterRunStatusByWorkspace([
      { state: "needs-you", workspaceId: "matter_spa" },
      { state: "working", workspaceId: "matter_spa" },
      { state: "working", workspaceId: "matter_spa" },
      { state: "working", workspaceId: "matter_lease" },
      { state: "needs-you", workspaceId: null },
    ]);

    expect(Object.fromEntries(status)).toEqual({
      matter_lease: { needsYou: 0, working: 1 },
      matter_spa: { needsYou: 1, working: 2 },
    });
  });

  test("a matter with no open chat has no entry", () => {
    expect(matterRunStatusByWorkspace([]).size).toBe(0);
  });

  test("every chat in a matter is counted exactly once, under its own state", () => {
    assertProperty(
      "every chat in a matter is counted exactly once, under its own state",
      fc.property(fc.array(runArbitrary, { maxLength: 40 }), (runs) => {
        const status = matterRunStatusByWorkspace(runs);
        for (const matter of MATTERS) {
          const own = runs.filter(({ workspaceId }) => workspaceId === matter);
          const counted = status.get(matter);
          if (own.length === 0) {
            expect(counted).toBeUndefined();
            continue;
          }
          expect(counted).toEqual({
            needsYou: own.filter(({ state }) => state === "needs-you").length,
            working: own.filter(({ state }) => state === "working").length,
          });
        }
        const matters = new Set<string>(MATTERS);
        expect([...status.keys()].every((key) => matters.has(key))).toBe(true);
      }),
    );
  });
});

describe("topMatterRunState", () => {
  test("a chat waiting on the reader outranks chats at work", () => {
    expect(topMatterRunState({ needsYou: 1, working: 3 })).toBe("needs-you");
    expect(topMatterRunState({ needsYou: 0, working: 2 })).toBe("working");
  });

  test("a matter with nothing open shows nothing", () => {
    expect(topMatterRunState(undefined)).toBeNull();
    expect(topMatterRunState({ needsYou: 0, working: 0 })).toBeNull();
  });
});
