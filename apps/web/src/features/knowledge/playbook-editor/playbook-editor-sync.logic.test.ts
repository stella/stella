import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { stableStringify } from "@stll/stable-stringify";

import {
  canAutosave,
  draftToAdopt,
  rebasePlaybookDraft,
  resolvePaneSaveStatus,
  resolveServerFollow,
  resolveSavedPlaybookState,
} from "@/features/knowledge/playbook-editor/playbook-editor-sync.logic";
import {
  createPlaybookBaseline,
  hasPlaybookDraftChanges,
} from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import type { PlaybookDraft } from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import { newExtractPosition } from "@/lib/knowledge/playbook-types";
import type { Position } from "@/lib/knowledge/playbook-types";

const position = (sourceId: string, issue: string): Position => ({
  ...newExtractPosition(),
  sourceId,
  issue,
});

const draftOf = (positions: Position[], name = "Playbook"): PlaybookDraft => ({
  name,
  description: "",
  documentTypeKey: null,
  perspective: null,
  trigger: null,
  positions,
});

describe("Following the server's newer version", () => {
  test("a new playbook has nothing to follow", () => {
    expect(
      resolveServerFollow({
        formUpdatedAt: null,
        serverUpdatedAt: null,
        isDirty: false,
      }),
    ).toBe("current");
  });

  test("the form never moves to the same or an older version", () => {
    const instant = fc
      .date({
        min: new Date("2000-01-01T00:00:00.000Z"),
        max: new Date("2100-01-01T00:00:00.000Z"),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString());
    assertProperty(
      "the form never moves to the same or an older version",
      fc.property(instant, instant, fc.boolean(), (form, server, isDirty) => {
        const follow = resolveServerFollow({
          formUpdatedAt: form,
          serverUpdatedAt: server,
          isDirty,
        });
        if (new Date(server) <= new Date(form)) {
          return follow === "current";
        }
        return follow === (isDirty ? "behind" : "reseed");
      }),
    );
  });

  test("a form with edits rebases in the pane and keeps them on the page", () => {
    const drafts = {
      baseline: draftOf([], "Base"),
      local: draftOf([], "Mine"),
      server: draftOf([], "Theirs"),
    };
    expect(
      draftToAdopt({ follow: "behind", whenBehind: "keep", ...drafts }),
    ).toBeNull();
    expect(
      draftToAdopt({ follow: "behind", whenBehind: "rebase", ...drafts })?.name,
    ).toBe("Mine");
    expect(
      draftToAdopt({ follow: "reseed", whenBehind: "keep", ...drafts }),
    ).toBe(drafts.server);
  });
});

describe("Rebasing the user's edits on a newer server version", () => {
  type Edit = "keep" | "edit" | "remove";
  const BASE_IDS = ["b0", "b1", "b2", "b3", "b4", "b5"];
  const edit = fc.constantFrom<Edit>("keep", "edit", "remove");
  const edits = fc.tuple(...BASE_IDS.map(() => edit));
  const added = fc.constantFrom(0, 1, 2);
  // A baseline, then the user's and the server's independent edits to it.
  const scenario = fc
    .record({
      baseIds: fc.subarray(BASE_IDS),
      localEdits: edits,
      serverEdits: edits,
      localAdded: added,
      serverAdded: added,
      localShuffle: fc.boolean(),
      localName: fc.boolean(),
      serverName: fc.boolean(),
    })
    .map((input) => {
      const base = input.baseIds.map((id) => position(id, `base ${id}`));
      const apply = (
        side: "local" | "server",
        sideEdits: readonly Edit[],
        addedCount: number,
      ) => {
        const kept: Position[] = [];
        for (const [index, item] of base.entries()) {
          const change = sideEdits[index];
          if (change === "edit") {
            kept.push({ ...item, issue: `${item.issue} (${side})` });
          } else if (change === "keep") {
            kept.push(item);
          }
        }
        for (let index = 0; index < addedCount; index += 1) {
          kept.splice(
            index % (kept.length + 1),
            0,
            position(`${side}-new-${index}`, `${side} new ${index}`),
          );
        }
        return kept;
      };
      const localPositions = apply("local", input.localEdits, input.localAdded);
      return {
        baseline: draftOf(base),
        local: draftOf(
          input.localShuffle ? localPositions.toReversed() : localPositions,
          input.localName ? "Renamed by user" : "Playbook",
        ),
        server: draftOf(
          apply("server", input.serverEdits, input.serverAdded),
          input.serverName ? "Renamed by model" : "Playbook",
        ),
      };
    });

  test("without edits the result is the server's version", () => {
    assertProperty(
      "without edits the result is the server's version",
      fc.property(
        scenario,
        ({ baseline, server }) =>
          stableStringify(
            rebasePlaybookDraft({ baseline, local: baseline, server }),
          ) === stableStringify(server),
      ),
    );
  });

  test("without a server change the result is the user's draft", () => {
    assertProperty(
      "without a server change the result is the user's draft",
      fc.property(
        scenario,
        ({ baseline, local }) =>
          stableStringify(
            rebasePlaybookDraft({ baseline, local, server: baseline }),
          ) === stableStringify(local),
      ),
    );
  });

  test("every position the user added or changed survives as they left it", () => {
    assertProperty(
      "every position the user added or changed survives as they left it",
      fc.property(scenario, ({ baseline, local, server }) => {
        const result = rebasePlaybookDraft({ baseline, local, server });
        const baseIssues = new Map(
          baseline.positions.map((item) => [item.sourceId, item.issue]),
        );
        return local.positions
          .filter((item) => baseIssues.get(item.sourceId) !== item.issue)
          .every((item) =>
            result.positions.some(
              (kept) =>
                kept.sourceId === item.sourceId && kept.issue === item.issue,
            ),
          );
      }),
    );
  });

  test("a position the user removed stays removed", () => {
    const a = position("a", "A");
    const b = position("b", "B");
    const result = rebasePlaybookDraft({
      baseline: draftOf([a, b]),
      local: draftOf([a]),
      server: draftOf([a, b, position("c", "C")]),
    });
    expect(result.positions.map(({ sourceId }) => sourceId)).toEqual([
      "a",
      "c",
    ]);
  });

  test("the model's new position and the user's rename both survive", () => {
    const a = position("a", "A");
    const result = rebasePlaybookDraft({
      baseline: draftOf([a]),
      local: draftOf([a], "Supplier DPAs"),
      server: draftOf([a, position("m", "Audit rights")]),
    });
    expect(result.name).toBe("Supplier DPAs");
    expect(result.positions.map(({ issue }) => issue)).toEqual([
      "A",
      "Audit rights",
    ]);
  });
});

describe("Autosave", () => {
  test("only the pane autosaves, and only a draft the user may update", () => {
    const pane = { host: "pane", exists: true, canUpdate: true } as const;
    expect(canAutosave({ ...pane, status: "draft" })).toBe(true);
    expect(canAutosave({ ...pane, status: "approved" })).toBe(false);
    expect(canAutosave({ ...pane, status: "draft", canUpdate: false })).toBe(
      false,
    );
    expect(canAutosave({ ...pane, status: "draft", host: "page" })).toBe(false);
  });

  const valid = { nameMissing: false, invalidPositions: 0 };

  test("the status never reads as saved while edits are not persisted", () => {
    expect(
      resolvePaneSaveStatus({ isDirty: true, request: "idle", ...valid }),
    ).toEqual({ type: "saving" });
    expect(
      resolvePaneSaveStatus({ isDirty: true, request: "failed", ...valid }),
    ).toEqual({ type: "failed" });
    const invalid = { nameMissing: false, invalidPositions: 2 };
    expect(
      resolvePaneSaveStatus({ isDirty: true, request: "idle", ...invalid }),
    ).toEqual({ type: "needs-attention", ...invalid });
  });

  test("the status reads as saved once the draft matches the server", () => {
    expect(
      resolvePaneSaveStatus({ isDirty: false, request: "idle", ...valid }),
    ).toEqual({ type: "saved" });
    expect(
      resolvePaneSaveStatus({ isDirty: false, request: "in-flight", ...valid }),
    ).toEqual({ type: "saving" });
  });
});

describe("Recording saved playbook baselines", () => {
  test("creating a playbook adopts its first returned token and clears the saved draft", () => {
    const initial = draftOf([], "New playbook");
    const savedDraft = draftOf([], "Created playbook");
    const savedAt = "2026-10-08T08:00:00.000Z";
    const current = {
      updatedAt: null,
      baseline: createPlaybookBaseline(initial),
    };
    expect(
      hasPlaybookDraftChanges({
        baseline: current.baseline,
        current: savedDraft,
      }),
    ).toBe(true);
    const persisted = resolveSavedPlaybookState({
      current,
      savedAt,
      savedDraft,
    });
    expect(persisted.updatedAt).toBe(savedAt);
    expect(
      hasPlaybookDraftChanges({
        baseline: persisted.baseline,
        current: savedDraft,
      }),
    ).toBe(false);
  });

  test("a late save response preserves the newer baseline already adopted", () => {
    const draft = draftOf([], "Newer server content");
    const current = {
      updatedAt: "2026-10-08T08:02:00.000Z",
      baseline: createPlaybookBaseline(draft),
    };
    for (const savedAt of [
      null,
      "2026-10-08T08:01:00.000Z",
      current.updatedAt,
    ]) {
      expect(
        resolveSavedPlaybookState({
          current,
          savedAt,
          savedDraft: draftOf([], "Old save"),
        }),
      ).toBe(current);
    }
  });
});
