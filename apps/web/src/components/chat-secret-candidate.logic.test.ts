import { describe, expect, test } from "bun:test";

import { containsCredentialCandidate } from "@/components/chat-secret-candidate.logic";

describe("credential paste detection", () => {
  test("recognizes a synthetic token with a known prefix", () => {
    expect(containsCredentialCandidate(`draft sk-${"a".repeat(32)}`)).toBe(
      true,
    );
  });

  test("leaves ordinary prose alone", () => {
    expect(
      containsCredentialCandidate("Please review this draft before Friday."),
    ).toBe(false);
  });
});
