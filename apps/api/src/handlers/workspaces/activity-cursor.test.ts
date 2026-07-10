import { describe, expect, test } from "bun:test";

import {
  decodeWorkspaceActivityCursor,
  encodeWorkspaceActivityCursor,
} from "@/api/handlers/workspaces/activity-cursor";

const ENTITY_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("workspace activity cursor", () => {
  test("round-trips the full mixed-feed ordering tuple", () => {
    const cursor = {
      activityAt: "2026-07-09T21:05:28.123456",
      id: ENTITY_ID,
      type: "entity" as const,
    };

    expect(
      decodeWorkspaceActivityCursor(encodeWorkspaceActivityCursor(cursor)),
    ).toEqual(cursor);
  });

  test("rejects malformed and incomplete cursors", () => {
    expect(decodeWorkspaceActivityCursor("not-base64-json")).toBeNull();
    expect(
      decodeWorkspaceActivityCursor(
        Buffer.from(
          JSON.stringify(["2026-07-09T21:05:28.123456", ENTITY_ID]),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });

  test("rejects invalid timestamps and activity types", () => {
    const encodeParts = (parts: unknown[]) =>
      Buffer.from(JSON.stringify(parts)).toString("base64url");

    expect(
      decodeWorkspaceActivityCursor(
        encodeParts(["2026-99-09T21:05:28.123456", ENTITY_ID, "entity"]),
      ),
    ).toBeNull();
    expect(
      decodeWorkspaceActivityCursor(
        encodeParts(["2026-07-09T21:05:28.123456", ENTITY_ID, "document"]),
      ),
    ).toBeNull();
  });
});
