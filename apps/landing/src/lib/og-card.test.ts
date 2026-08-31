import { describe, expect, test } from "bun:test";

import { renderOgCard } from "./og-card";

// A card whose unsupported background was discarded encoded below 14 kB.
const MINIMUM_GRADIENT_CARD_BYTES = 25_000;

describe("Open Graph card rendering", () => {
  test("includes the detailed brand gradient", async () => {
    const card = await renderOgCard({
      headline: "Legal workspace. Open source.",
    });

    expect(card.byteLength).toBeGreaterThan(MINIMUM_GRADIENT_CARD_BYTES);
  });
});
