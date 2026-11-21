import { describe, expect, test } from "bun:test";

import { matterCardPreviewEnabled } from "./matter-card.logic";

describe("matter card preview admission", () => {
  test("does not enable the overview request for an archived card on hover", () => {
    expect(matterCardPreviewEnabled("archived", true)).toBe(false);
  });

  test("enables the overview request for an active card on hover", () => {
    expect(matterCardPreviewEnabled("active", true)).toBe(true);
  });
});
