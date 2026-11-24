import { describe, expect, test } from "bun:test";

import { deriveScimCredentialHashSecret } from "./scim-provisioning";

describe("deriveScimCredentialHashSecret", () => {
  test("produces a deterministic 64-char hex digest distinct from the base secret", () => {
    const base = "x".repeat(32);
    const derived = deriveScimCredentialHashSecret(base);
    expect(derived).toHaveLength(64);
    expect(derived).not.toBe(base);
    expect(deriveScimCredentialHashSecret(base)).toBe(derived);
    expect(deriveScimCredentialHashSecret("y".repeat(32))).not.toBe(derived);
  });
});
