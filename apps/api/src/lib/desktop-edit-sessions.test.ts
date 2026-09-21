import { describe, expect, test } from "bun:test";

import {
  DESKTOP_EDIT_HANDOFF_TTL_MS,
  DESKTOP_EDIT_SESSION_LIVENESS_REFRESH_INTERVAL_MS,
  SESSION_TOKEN_TTL_MS,
  createDesktopEditHandoffToken,
  hashDesktopEditHandoffToken,
} from "@/api/lib/desktop-edit-sessions";

describe("desktop edit handoff tokens", () => {
  test("uses a short-lived opaque token that can be stored as a hash", () => {
    const token = createDesktopEditHandoffToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashDesktopEditHandoffToken(token)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashDesktopEditHandoffToken(token)).toBe(
      hashDesktopEditHandoffToken(token),
    );
    expect(hashDesktopEditHandoffToken(token)).not.toBe(token);
  });

  test("keeps browser-to-desktop handoffs short-lived", () => {
    expect(DESKTOP_EDIT_HANDOFF_TTL_MS).toBeLessThanOrEqual(2 * 60 * 1000);
  });
});

describe("desktop edit session liveness", () => {
  test("leaves retry margin before session token expiry", () => {
    expect(
      DESKTOP_EDIT_SESSION_LIVENESS_REFRESH_INTERVAL_MS,
    ).toBeLessThanOrEqual(SESSION_TOKEN_TTL_MS / 4);
  });
});
