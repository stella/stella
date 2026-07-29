import { describe, expect, test } from "bun:test";

import {
  createShareInvitationSecret,
  hashShareInvitationSecret,
} from "@/api/handlers/share-spaces/token";

describe("Share Space invitation secrets", () => {
  test("generates independent 256-bit URL-safe secrets and fixed SHA-256 digests", () => {
    const first = createShareInvitationSecret();
    const second = createShareInvitationSecret();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(hashShareInvitationSecret(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashShareInvitationSecret(first)).not.toContain(first);
  });
});
