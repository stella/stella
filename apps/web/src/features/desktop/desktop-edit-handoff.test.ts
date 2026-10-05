import { describe, expect, test } from "bun:test";

import { DESKTOP_HANDOFF_FAILURE } from "@stll/api-contract/desktop-handoff";
import { Temporal } from "@stll/time";

import { watchDesktopEditHandoff } from "./desktop-edit-handoff";

const expiresAt = () => Temporal.Now.instant().add({ minutes: 2 }).toString();

describe("desktop handoff terminal failures", () => {
  for (const failureReason of Object.values(DESKTOP_HANDOFF_FAILURE)) {
    test(`${failureReason} stops at the first status read`, async () => {
      let reads = 0;
      const watched = watchDesktopEditHandoff({
        expiresAt: expiresAt(),
        readStatus: async () => {
          reads += 1;
          return {
            status: "failed",
            failureReason,
            failedAt: Temporal.Now.instant().toString(),
          };
        },
      });
      const result = await watched;
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          _tag: "DesktopHandoffFailedError",
          failureReason,
        });
      }
      expect(reads).toBe(1);
    });
  }

  test("opened sessions complete and expired sessions stay distinct from recovery failures", async () => {
    expect(
      await watchDesktopEditHandoff({
        expiresAt: expiresAt(),
        readStatus: async () => ({ status: "opened", sessionId: "session" }),
      }),
    ).toMatchObject({ status: "ok", value: "opened" });
    expect(
      await watchDesktopEditHandoff({
        expiresAt: expiresAt(),
        readStatus: async () => ({ status: "expired", expiresAt: expiresAt() }),
      }),
    ).toMatchObject({ status: "ok", value: "expired" });
  });
});
