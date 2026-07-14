import { describe, expect, test } from "bun:test";

import { resolvePlaybookScrollTop } from "@/routes/_protected.knowledge/-components/playbook-editor.logic";

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
