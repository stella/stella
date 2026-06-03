import { describe, expect, it } from "bun:test";

import { getDisplayName, getInitials } from "./team-avatars";

describe("team avatar labels", () => {
  it("derives stable initials from names", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(getInitials("  mary   shelley  ")).toBe("MS");
    expect(getInitials("Plato")).toBe("PL");
  });

  it("falls back when an auth user has no display name", () => {
    expect(getInitials(null)).toBe("?");
    expect(getInitials(undefined)).toBe("?");
    expect(getInitials(" ")).toBe("?");
    expect(getDisplayName(null, "user_123")).toBe("user_123");
    expect(getDisplayName("", "user_123")).toBe("user_123");
  });
});
