import { describe, expect, test } from "bun:test";

import { newExtractPosition } from "@/lib/knowledge/playbook-types";
import {
  hasPlaybookDraftChanges,
  resolvePlaybookScrollTop,
} from "@/routes/_protected.knowledge/-components/playbook-editor.logic";

describe("Playbook outline navigation", () => {
  test("calculates a pane-local target without moving ancestor scroll containers", () => {
    expect(
      resolvePlaybookScrollTop({
        containerScrollTop: 320,
        containerTop: 64,
        targetTop: 464,
        topOffset: 24,
      }),
    ).toBe(696);
  });

  test("does not scroll before the start of the Playbook pane", () => {
    expect(
      resolvePlaybookScrollTop({
        containerScrollTop: 10,
        containerTop: 64,
        targetTop: 40,
        topOffset: 24,
      }),
    ).toBe(0);
  });
});

describe("Playbook draft state", () => {
  const position = newExtractPosition();
  const initial = {
    name: "NDA review",
    description: "Review the mutual NDA",
    documentTypeKey: "nda",
    positions: [position],
  };

  test("treats the persisted draft as clean", () => {
    expect(
      hasPlaybookDraftChanges({
        initial,
        current: initial,
      }),
    ).toBe(false);
  });

  test("detects every editable field that would change the saved definition", () => {
    const changedDrafts = [
      { ...initial, name: "DPA review" },
      { ...initial, description: "Review the processor terms" },
      { ...initial, documentTypeKey: "dpa" },
      {
        ...initial,
        positions: [{ ...position, issue: "Governing law" }],
      },
    ];

    for (const current of changedDrafts) {
      expect(hasPlaybookDraftChanges({ initial, current })).toBe(true);
    }
  });

  test("ignores whitespace that the save boundary normalizes", () => {
    expect(
      hasPlaybookDraftChanges({
        initial,
        current: {
          ...initial,
          name: ` ${initial.name} `,
          description: ` ${initial.description} `,
          positions: [{ ...position, issue: "  " }],
        },
      }),
    ).toBe(false);
  });
});
