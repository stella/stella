import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseRlsError } from "@/api/lib/errors/tagged-errors";

import { openDesktopEditSessionHandler } from "./open-desktop-edit-session";

describe("open desktop edit session", () => {
  test("propagates safeDb errors so logs keep the database error type", async () => {
    const rlsError = new DatabaseRlsError({
      code: "42501",
      message: "Database row-level security rejected the request",
    });
    const safeDb: SafeDb = async <T>() => Result.err<T, SafeDbError>(rlsError);
    const recordAuditEvent: AuditRecorder = async () => undefined;

    const result = await Result.gen(() =>
      openDesktopEditSessionHandler({
        body: {
          entityId: toSafeId<"entity">("019e6000-0000-7000-8000-000000000001"),
          propertyId: toSafeId<"property">(
            "019e6000-0000-7000-8000-000000000002",
          ),
        },
        organizationId: toSafeId<"organization">(
          "019e6000-0000-7000-8000-000000000003",
        ),
        recordAuditEvent,
        safeDb,
        userId: toSafeId<"user">("019e6000-0000-7000-8000-000000000004"),
        workspaceId: toSafeId<"workspace">(
          "019e6000-0000-7000-8000-000000000005",
        ),
      }),
    );

    if (Result.isOk(result)) {
      throw new Error("Expected openDesktopEditSessionHandler to fail");
    }

    expect(result.error).toBe(rlsError);
  });
});
