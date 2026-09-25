import { describe, expect, test } from "bun:test";

import { parseSmokePrincipal } from "@/api/lib/smoke-session/store";

describe("parseSmokePrincipal", () => {
  test("defaults to the plain smoke organization", () => {
    expect(parseSmokePrincipal(null)).toBe("default");
    expect(parseSmokePrincipal("default")).toBe("default");
  });

  test("selects the AI smoke organization by name only", () => {
    expect(parseSmokePrincipal("ai")).toBe("ai");
    expect(parseSmokePrincipal("AI")).toBeNull();
    expect(parseSmokePrincipal("")).toBeNull();
  });
});
