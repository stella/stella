import { describe, expect, test } from "bun:test";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { liveDesktopEditSessionPredicates } from "@/api/lib/desktop-edit-session-predicates";

describe("liveDesktopEditSessionPredicates", () => {
  test("matches open sessions whose liveness TTL has not lapsed", () => {
    const now = new Date("2026-06-05T13:00:00.000Z");
    const expression = and(...liveDesktopEditSessionPredicates(now));
    if (!expression) {
      throw new Error("expected liveness predicate");
    }

    const compiled = new PgDialect().sqlToQuery(expression);

    expect(compiled.sql).toContain("desktop_edit_sessions");
    expect(compiled.sql).toContain("status");
    expect(compiled.sql).toContain("token_expires_at");
    expect(compiled.sql).toContain(" > ");
    expect(compiled.params).toEqual(["open", now.toISOString()]);
  });
});
