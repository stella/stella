import { describe, expect, it } from "bun:test";

import { getDisplayName } from "@/lib/get-display-name";
import { getInitials } from "@/lib/get-initials";

describe("team avatar labels", () => {
  it("derives stable initials from names", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(getInitials("  mary   shelley  ")).toBe("MS");
    expect(getInitials("Plato")).toBe("PL");
  });

  it("uses the canonical fallback when an auth user has no display name", () => {
    expect(getInitials(null)).toBe("?");
    expect(getInitials(" ")).toBe("?");
    expect(getDisplayName(null, "ada@example.com")).toBe("ada@example.com");
    expect(getDisplayName("", null)).toBeNull();
  });
});
