import { describe, expect, test } from "bun:test";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import {
  expiredOwnDesktopEditSessionTargetPredicates,
  liveDesktopEditSessionPredicates,
  liveOwnDesktopEditSessionTargetPredicates,
} from "@/api/lib/desktop-edit-session-predicates";

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

  test("matches the current user's live target session", () => {
    const now = new Date("2026-06-05T13:00:00.000Z");
    const expression = and(
      ...liveOwnDesktopEditSessionTargetPredicates({
        entityId: toSafeId<"entity">("019e6000-0000-7000-8000-000000000001"),
        now,
        propertyId: toSafeId<"property">(
          "019e6000-0000-7000-8000-000000000002",
        ),
        userId: toSafeId<"user">("019e6000-0000-7000-8000-000000000003"),
        workspaceId: toSafeId<"workspace">(
          "019e6000-0000-7000-8000-000000000004",
        ),
      }),
    );
    if (!expression) {
      throw new Error("expected live target predicate");
    }

    const compiled = new PgDialect().sqlToQuery(expression);

    expect(compiled.sql).toContain("created_by");
    expect(compiled.sql).toContain("entity_id");
    expect(compiled.sql).toContain("property_id");
    expect(compiled.sql).toContain("workspace_id");
    expect(compiled.sql).toContain("token_expires_at");
    expect(compiled.sql).toContain(" > ");
    expect(compiled.params).toEqual([
      "019e6000-0000-7000-8000-000000000003",
      "019e6000-0000-7000-8000-000000000001",
      "019e6000-0000-7000-8000-000000000002",
      "019e6000-0000-7000-8000-000000000004",
      "open",
      now.toISOString(),
    ]);
  });

  test("matches the current user's expired open target session", () => {
    const now = new Date("2026-06-05T13:00:00.000Z");
    const expression = and(
      ...expiredOwnDesktopEditSessionTargetPredicates({
        entityId: toSafeId<"entity">("019e6000-0000-7000-8000-000000000001"),
        now,
        propertyId: toSafeId<"property">(
          "019e6000-0000-7000-8000-000000000002",
        ),
        userId: toSafeId<"user">("019e6000-0000-7000-8000-000000000003"),
        workspaceId: toSafeId<"workspace">(
          "019e6000-0000-7000-8000-000000000004",
        ),
      }),
    );
    if (!expression) {
      throw new Error("expected expired target predicate");
    }

    const compiled = new PgDialect().sqlToQuery(expression);

    expect(compiled.sql).toContain("token_expires_at");
    expect(compiled.sql).toContain(" < ");
    expect(compiled.params).toEqual([
      "019e6000-0000-7000-8000-000000000003",
      "019e6000-0000-7000-8000-000000000001",
      "019e6000-0000-7000-8000-000000000002",
      "019e6000-0000-7000-8000-000000000004",
      "open",
      now.toISOString(),
    ]);
  });
});
