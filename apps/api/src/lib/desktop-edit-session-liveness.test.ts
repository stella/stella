import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

let refreshPredicate: SQL | null = null;

const returningMock = mock(async () => [{ id: "desktop_edit_session_test" }]);
const whereMock = mock((predicate: SQL) => {
  refreshPredicate = predicate;
  return { returning: returningMock };
});
const setMock = mock(() => ({ where: whereMock }));
const updateMock = mock(() => ({ set: setMock }));

void mock.module("@/api/db/root", () => ({
  rootDb: { update: updateMock },
}));

const { hashDesktopEditSessionToken, refreshDesktopEditSessionLiveness } =
  await import("@/api/lib/desktop-edit-sessions");

describe("refreshDesktopEditSessionLiveness", () => {
  test("requires the current session token hash before extending liveness", async () => {
    const sessionId = toSafeId<"desktopEditSession">(
      "019aa0bc-d957-7bb3-9234-9c2440377225",
    );
    const userId = toSafeId<"user">("019aa0bc-d957-7bb3-9234-9c2440377226");
    const sessionToken = "a".repeat(64);

    const refreshed = await refreshDesktopEditSessionLiveness({
      sessionId,
      sessionToken,
      userId,
    });

    expect(refreshed).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);

    if (refreshPredicate === null) {
      throw new Error("Expected refresh predicate to be captured.");
    }

    const compiled = new PgDialect().sqlToQuery(refreshPredicate);

    expect(compiled.sql).toContain("session_token_hash");
    expect(compiled.sql).toContain("token_expires_at");
    expect(compiled.params).toContain(sessionId);
    expect(compiled.params).toContain(userId);
    expect(compiled.params).toContain(hashDesktopEditSessionToken(sessionToken));
    expect(compiled.params).toContain("open");
  });
});
