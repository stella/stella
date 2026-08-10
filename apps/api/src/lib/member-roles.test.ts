import { describe, expect, test } from "bun:test";

import { isMemberRole } from "@/api/lib/member-roles";

describe("isMemberRole", () => {
  test("only accepts role keys owned by the permissions map", () => {
    expect(isMemberRole("owner")).toBe(true);
    expect(isMemberRole("toString")).toBe(false);
    expect(isMemberRole("constructor")).toBe(false);
    expect(isMemberRole("custom")).toBe(false);
  });
});
