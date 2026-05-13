import { describe, expect, test } from "bun:test";

import {
  DESKTOP_EDIT_HANDOFF_TTL_MS,
  canUseDesktopEditSession,
  createDesktopEditHandoffToken,
  hashDesktopEditHandoffToken,
} from "@/api/lib/desktop-edit-sessions";

describe("canUseDesktopEditSession", () => {
  test("requires current workspace access for non-admin edit roles", () => {
    expect(
      canUseDesktopEditSession({
        organizationRole: "member",
        workspaceMemberId: null,
      }),
    ).toBe(false);

    expect(
      canUseDesktopEditSession({
        organizationRole: "member",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(true);
  });

  test("allows owner and admin roles without a workspace membership row", () => {
    expect(
      canUseDesktopEditSession({
        organizationRole: "owner",
        workspaceMemberId: null,
      }),
    ).toBe(true);

    expect(
      canUseDesktopEditSession({
        organizationRole: "admin",
        workspaceMemberId: null,
      }),
    ).toBe(true);
  });

  test("rejects roles without entity update permission", () => {
    expect(
      canUseDesktopEditSession({
        organizationRole: "intern",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canUseDesktopEditSession({
        organizationRole: "external",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);
  });

  test("rejects missing or unknown organization roles", () => {
    expect(
      canUseDesktopEditSession({
        organizationRole: null,
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canUseDesktopEditSession({
        organizationRole: "custom",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);

    expect(
      canUseDesktopEditSession({
        organizationRole: "toString",
        workspaceMemberId: "workspace_member_test",
      }),
    ).toBe(false);
  });
});

describe("desktop edit handoff tokens", () => {
  test("uses a short-lived opaque token that can be stored as a hash", () => {
    const token = createDesktopEditHandoffToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDesktopEditHandoffToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDesktopEditHandoffToken(token)).toBe(
      hashDesktopEditHandoffToken(token),
    );
    expect(hashDesktopEditHandoffToken(token)).not.toBe(token);
  });

  test("keeps browser-to-desktop handoffs short-lived", () => {
    expect(DESKTOP_EDIT_HANDOFF_TTL_MS).toBeLessThanOrEqual(2 * 60 * 1000);
  });
});
