import { describe, expect, test } from "bun:test";

import {
  citedDecisionClick,
  CITED_DECISION_CLICK,
} from "@/components/legal-reader/cited-decision-link.logic";

const plain = {
  altKey: false,
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("citedDecisionClick", () => {
  // Keyboard activation dispatches an unmodified primary click, so Enter on
  // the citation takes this same path into the preview.
  test("a plain click asks about the citation rather than leaving", () => {
    expect(citedDecisionClick(plain)).toBe(CITED_DECISION_CLICK.preview);
  });

  test("every browser navigation gesture keeps its meaning", () => {
    const gestures = [
      { ...plain, button: 1 },
      { ...plain, ctrlKey: true },
      { ...plain, metaKey: true },
      { ...plain, shiftKey: true },
      { ...plain, altKey: true },
    ];

    for (const gesture of gestures) {
      expect(citedDecisionClick(gesture)).toBe(CITED_DECISION_CLICK.navigate);
    }
  });
});
