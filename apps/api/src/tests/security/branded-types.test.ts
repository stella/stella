import { describe, expect, test } from "bun:test";

import { toSafeId, type SafeId } from "@/api/lib/branded-types";

describe("branded types", () => {
  describe("toSafeId", () => {
    test("produces a value equal to the input string", () => {
      const raw = "org_abc123";
      const safe = toSafeId<"organization">(raw);
      expect(safe === raw).toBe(true);
    });

    test("produces a workspace SafeId", () => {
      const raw = "ws_xyz789";
      const safe = toSafeId<"workspace">(raw);
      // @ts-expect-error - safe isn't the same type as raw
      expect(safe).toBe(raw);
    });

    test("can be used where SafeId<T> is expected", () => {
      const acceptsOrgId = (id: SafeId<"organization">) => id;
      const safe = toSafeId<"organization">("org_test");
      // Should compile and return the same value
      expect(acceptsOrgId(safe)).toBe(safe);
    });

    test("plain string is not assignable to SafeId (type-level)", () => {
      const acceptsOrgId = (_id: SafeId<"organization">) => _id;
      // @ts-expect-error - plain string should not satisfy SafeId
      acceptsOrgId("raw-string");
    });

    test("SafeId<organization> is not assignable to SafeId<workspace> (type-level)", () => {
      const acceptsWorkspaceId = (_id: SafeId<"workspace">) => _id;
      const orgId = toSafeId<"organization">("org_123");
      // @ts-expect-error - organization SafeId should not satisfy workspace SafeId
      acceptsWorkspaceId(orgId);
    });
  });
});
