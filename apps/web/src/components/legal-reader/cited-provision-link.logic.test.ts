import { describe, expect, test } from "bun:test";

import {
  citedProvisionClick,
  CITED_PROVISION_CLICK,
} from "@/components/legal-reader/cited-provision-link.logic";

const plain = {
  altKey: false,
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

describe("citedProvisionClick", () => {
  // Keyboard activation dispatches an unmodified primary click, so Enter on
  // the citation unfolds and folds the wording the same way a pointer does.
  test("a plain click toggles the wording under the citation", () => {
    expect(
      citedProvisionClick({
        expanded: false,
        expandsInPlace: true,
        gesture: plain,
      }),
    ).toBe(CITED_PROVISION_CLICK.expand);
    expect(
      citedProvisionClick({
        expanded: true,
        expandsInPlace: true,
        gesture: plain,
      }),
    ).toBe(CITED_PROVISION_CLICK.collapse);
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
      expect(
        citedProvisionClick({ expanded: false, expandsInPlace: true, gesture }),
      ).toBe(CITED_PROVISION_CLICK.navigate);
      // Folding away is not a reason to swallow a gesture either.
      expect(
        citedProvisionClick({ expanded: true, expandsInPlace: true, gesture }),
      ).toBe(CITED_PROVISION_CLICK.navigate);
    }
  });

  test("where nothing can unfold, the citation is a plain link", () => {
    expect(
      citedProvisionClick({
        expanded: false,
        expandsInPlace: false,
        gesture: plain,
      }),
    ).toBe(CITED_PROVISION_CLICK.navigate);
  });
});
