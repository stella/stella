import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import { openDesktopEditSessionHandler } from "./open-desktop-edit-session";

describe("open desktop edit session", () => {
  test("refuses a disappeared target after the open transaction foreign-key failure", async () => {
    for (const targetState of ["absent", "present", "probe-failed"] as const) {
      const foreignKeyError = new DatabaseError({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
        cause: { code: PG_ERROR.FOREIGN_KEY_VIOLATION },
        message: "Desktop edit target reference is missing",
      });
      const probeError = new DatabaseRlsError({
        code: "42501",
        message: "Target probe was denied",
      });
      const entityId = toSafeId<"entity">(
        "019e6000-0000-7000-8000-000000000001",
      );
      const propertyId = toSafeId<"property">(
        "019e6000-0000-7000-8000-000000000002",
      );
      const workspaceId = toSafeId<"workspace">(
        "019e6000-0000-7000-8000-000000000005",
      );
      let databaseCalls = 0;
      let probeCalls = 0;
      const probeDatabase = createScopedDbMock({
        select: () => createSelectQueryMock([]),
        query: {
          entities: {
            findFirst: async ({ where }: { where: unknown }) => {
              probeCalls += 1;
              expect(databaseCalls).toBe(3);
              expect(where).toEqual({
                id: { eq: entityId },
                workspaceId: { eq: workspaceId },
              });
              return targetState === "absent"
                ? undefined
                : {
                    id: entityId,
                    currentVersion: {
                      id: toSafeId<"entityVersion">("version-one"),
                      versionNumber: 1,
                      fields: [
                        {
                          propertyId,
                          content: {
                            type: "file",
                            version: 1,
                            id: "file-one",
                            fileName: "Document.docx",
                            mimeType: DOCX_MIME_TYPE,
                            size: 1,
                          },
                        },
                      ],
                    },
                  };
            },
          },
        },
      });
      const safeDb: SafeDb = async (run, retry) => {
        databaseCalls += 1;
        if (databaseCalls === 2) {
          return Result.err(foreignKeyError);
        }
        if (databaseCalls === 3 && targetState === "probe-failed") {
          return Result.err(probeError);
        }
        return await probeDatabase.safeDb(run, retry);
      };
      const result = await Result.gen(() =>
        openDesktopEditSessionHandler({
          body: { entityId, propertyId, force: true },
          organizationId: toSafeId<"organization">(
            "019e6000-0000-7000-8000-000000000003",
          ),
          recordAuditEvent: async () => undefined,
          safeDb,
          userId: toSafeId<"user">("019e6000-0000-7000-8000-000000000004"),
          workspaceId,
        }),
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isOk(result)) {
        return;
      }
      expect(databaseCalls).toBe(3);
      expect(probeCalls).toBe(targetState === "probe-failed" ? 0 : 1);
      if (targetState === "absent") {
        expect(HandlerError.is(result.error)).toBe(true);
        expect(result.error).toMatchObject({
          status: 409,
          code: "entity_transfer_source_changed",
          retryable: true,
        });
      } else {
        expect(result.error).toBe(
          targetState === "present" ? foreignKeyError : probeError,
        );
      }
    }
  });

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
