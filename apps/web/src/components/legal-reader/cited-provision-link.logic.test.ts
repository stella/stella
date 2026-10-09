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

describe("cited provision click", () => {
  test("a plain primary click peeks at the wording", () => {
    expect(citedProvisionClick(plain)).toBe(CITED_PROVISION_CLICK.peek);
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
      expect(citedProvisionClick(gesture)).toBe(CITED_PROVISION_CLICK.navigate);
    }
  });
});
