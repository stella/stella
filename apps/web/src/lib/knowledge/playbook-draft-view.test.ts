import { describe, expect, test } from "bun:test";

import {
  isPlaybookDraftViewPayload,
  playbookDraftTabId,
  projectPlaybookDraftViewPayload,
} from "@/lib/knowledge/playbook-draft-view";

describe("The playbook pane's inspector payload", () => {
  test("accepts a playbook id and nothing else", () => {
    expect(
      isPlaybookDraftViewPayload({ type: "playbook", playbookId: "p-1" }),
    ).toBe(true);
    for (const payload of [
      null,
      "p-1",
      { playbookId: "p-1" },
      { type: "empty" },
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

  test("gives each chat thread one pane", () => {
    expect(playbookDraftTabId("thread-a")).not.toBe(
      playbookDraftTabId("thread-b"),
    );
    expect(playbookDraftTabId("thread-a")).toBe(playbookDraftTabId("thread-a"));
  });
});
