import { describe, expect, test } from "bun:test";

import {
  isPlaybookDraftViewPayload,
  projectPlaybookDraftViewPayload,
} from "@/lib/knowledge/playbook-draft-view";

describe("The playbook pane's inspector payload", () => {
  test("accepts a pending pane, a playbook id, and nothing else", () => {
    expect(isPlaybookDraftViewPayload({ type: "pending" })).toBe(true);
    expect(
      isPlaybookDraftViewPayload({ type: "playbook", playbookId: "p-1" }),
    ).toBe(true);
    for (const payload of [
      null,
      "p-1",
      "pending",
      { playbookId: "p-1" },
      { type: "empty" },
      { type: "playbook" },
      { type: "playbook", playbookId: "" },
      { type: "playbook", playbookId: 7 },
    ]) {
      expect(isPlaybookDraftViewPayload(payload)).toBe(false);
    }
  });

  test("persists only the playbook id", () => {
    const payload = { type: "playbook" as const, playbookId: "p-1" };
    const stored = projectPlaybookDraftViewPayload({
      ...payload,
      // A field a later version might carry must not reach storage.
      ...{ draft: "unsaved text" },
    });
    expect(stored).toEqual(payload);
    expect(isPlaybookDraftViewPayload(stored)).toBe(true);
  });

  test("persists a pending pane as pending, without a stale playbook id", () => {
    const stored = projectPlaybookDraftViewPayload({
      type: "pending" as const,
      ...{ playbookId: "p-1" },
    });
    expect(stored).toEqual({ type: "pending" });
  });
});
