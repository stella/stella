import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { desktopEditSessions, workspaces } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { desktopEditMimeTypeForFileType } from "@/api/lib/desktop-edit-file-types";
import {
  authorizeDesktopEditSession,
  computeTokenExpiresAt,
  createDesktopEditSessionToken,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { validateDesktopEditFileBuffer } from "@/api/lib/entity-versions/validate-desktop-edit-file-buffer";
import { scanFile } from "@/api/lib/file-scan/scan";
import { createFileKey } from "@/api/lib/files/utils";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import { writeS3ObjectWithRetry } from "@/api/lib/s3";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

export const checkpointDesktopEditSessionParamsSchema = t.Object({
  sessionId: tSafeId("desktopEditSession"),
});

export const checkpointDesktopEditSessionBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
  sessionToken: t.String({ minLength: 64, maxLength: 64 }),
});

type CheckpointDesktopEditSessionHandlerProps = {
  body: Static<typeof checkpointDesktopEditSessionBodySchema>;
  sessionId: SafeId<"desktopEditSession">;
  request: Request;
  server: Parameters<typeof createAuditRecorder>[0]["server"];
};

export const checkpointDesktopEditSessionHandler = async ({
  body: { file, sessionToken },
  sessionId,
  request,
  server,
}: CheckpointDesktopEditSessionHandlerProps) => {
  const authorizedSession = await authorizeDesktopEditSession({
    sessionId,
    sessionToken,
  });

  if (authorizedSession.status === "missing") {
    return status(404, {
      message: "Desktop edit session not found.",
    });
  }

  if (authorizedSession.status === "token-mismatch") {
    return status(409, {
      code: DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
      message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
    });
  }

  if (authorizedSession.status === "token-expired") {
    return status(401, {
      code: "desktop_edit_session_token_expired",
      message:
        "Desktop edit session token has expired. Reopen the file from stella.",
    });
  }

  if (authorizedSession.status === "permission-revoked") {
    return status(403, {
      code: "desktop_edit_session_permission_revoked",
      message:
        "Desktop edit permission was revoked. Reopen the file from stella.",
    });
  }

  const canonicalMimeType = desktopEditMimeTypeForFileType(
    authorizedSession.value.fileType,
  );
  if (file.type !== canonicalMimeType) {
    return status(400, {
      message: `Checkpoint content type must be ${canonicalMimeType}.`,
    });
  }

  const fileName = authorizedSession.value.fileName;
  const buffer = await file.arrayBuffer();
  const sha256Hex = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");

  const validation = await validateDesktopEditFileBuffer({
    buffer,
    fileType: authorizedSession.value.fileType,
  });
  if (!validation.valid) {
    return status(422, {
      message: `File validation failed: ${validation.error}`,
    });
  }

  const scanResult = await scanFile({
    buffer: new Uint8Array(buffer),
    declaredMimeType: canonicalMimeType,
    fileName,
  });

  if (Result.isError(scanResult)) {
    return status(422, {
      message: "File security scan failed.",
    });
  }

  if (scanResult.value.verdict === "reject") {
    const reasons: string[] = [];
    for (const finding of scanResult.value.findings) {
      if (finding.severity === "reject") {
        reasons.push(finding.message);
      }
    }

    return status(422, {
      message: `File rejected: ${reasons.join("; ")}`,
    });
  }

  let scanWarnings: string[] | null = null;
  if (scanResult.value.verdict === "warn") {
    scanWarnings = [];
    for (const finding of scanResult.value.findings) {
      if (finding.severity === "warn") {
        scanWarnings.push(finding.message);
      }
    }
  }

  const recordAuditEvent = createAuditRecorder({
    organizationId: authorizedSession.value.organizationId,
    workspaceId: authorizedSession.value.workspaceId,
    userId: brandPersistedUserId(authorizedSession.value.userId),
    request,
    server,
  });

  const result = await authorizedSession.value.scopedDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${authorizedSession.value.workspaceId}))`,
    );
    const workspaceRows = await tx
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, authorizedSession.value.workspaceId))
      .limit(1)
      .for("update");
    if (workspaceRows.at(0)?.status !== "active") {
      return status(409, { message: "Workspace is not active" });
    }

    const existingSessions = await tx
      .select({
        checkpointFileId: desktopEditSessions.checkpointFileId,
        checkpointSha256Hex: desktopEditSessions.checkpointSha256Hex,
        checkpointSizeBytes: desktopEditSessions.checkpointSizeBytes,
        checkpointUpdatedAt: desktopEditSessions.checkpointUpdatedAt,
        fileName: desktopEditSessions.fileName,
        fileType: desktopEditSessions.fileType,
        id: desktopEditSessions.id,
        sessionTokenHash: desktopEditSessions.sessionTokenHash,
      })
      .from(desktopEditSessions)
      .where(
        and(
          eq(desktopEditSessions.id, sessionId),
          eq(desktopEditSessions.status, "open"),
          eq(
            desktopEditSessions.workspaceId,
            authorizedSession.value.workspaceId,
          ),
        ),
      )
      .limit(1)
      .for("update");
    const existingSession = existingSessions.at(0);

    if (!existingSession) {
      return status(409, {
        message: "Desktop edit session is already closed.",
      });
    }

    if (
      existingSession.sessionTokenHash !==
      hashDesktopEditSessionToken(sessionToken)
    ) {
      return status(409, {
        code: DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
        message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
      });
    }

    if (existingSession.fileType !== authorizedSession.value.fileType) {
      return status(409, {
        message: "Desktop edit session file type changed while checkpointing.",
      });
    }

    if (existingSession.checkpointSha256Hex === sha256Hex) {
      // Extend expiry even on noop to keep the session alive.
      // Pure session token TTL extension; no user-facing content change.
      const nextTokenExpiresAt = computeTokenExpiresAt();
      await tx
        .update(desktopEditSessions)
        .set({ tokenExpiresAt: nextTokenExpiresAt })
        .where(eq(desktopEditSessions.id, existingSession.id));

      return {
        checkpointedAt:
          existingSession.checkpointUpdatedAt?.toISOString() ??
          new Date().toISOString(),
        noop: true,
      };
    }

    const key = createFileKey({
      fileId: existingSession.checkpointFileId,
      mimeType: canonicalMimeType,
      organizationId: authorizedSession.value.organizationId,
      workspaceId: authorizedSession.value.workspaceId,
    });

    // This S3 write stays inside the FOR UPDATE transaction by design (do
    // not hoist it out to shorten the lock): `key` is the fixed per-session
    // checkpoint slot, and the write runs only after the row-locked token
    // check above. Writing before the lock would let a stale or taken-over
    // token-holder overwrite the checkpoint, desyncing the S3 object from
    // the persisted checkpointSha256Hex. The lock is held for one write on
    // a low-frequency, single-session path.
    await writeS3ObjectWithRetry({ data: new Uint8Array(buffer), key });

    const checkpointedAt = new Date();

    // Rotate token on each successful checkpoint
    const nextSessionToken = createDesktopEditSessionToken();
    const nextSessionTokenHash = hashDesktopEditSessionToken(nextSessionToken);
    const nextTokenExpiresAt = computeTokenExpiresAt();

    const updatedSessions = await tx
      .update(desktopEditSessions)
      .set({
        checkpointScanWarnings: scanWarnings,
        checkpointSha256Hex: sha256Hex,
        checkpointSizeBytes: file.size,
        checkpointUpdatedAt: checkpointedAt,
        fileName: existingSession.fileName,
        sessionTokenHash: nextSessionTokenHash,
        tokenExpiresAt: nextTokenExpiresAt,
      })
      .where(
        and(
          eq(desktopEditSessions.id, existingSession.id),
          eq(desktopEditSessions.status, "open"),
          eq(
            desktopEditSessions.sessionTokenHash,
            existingSession.sessionTokenHash,
          ),
        ),
      )
      .returning({ id: desktopEditSessions.id });

    if (!updatedSessions.at(0)) {
      const latestSessions = await tx
        .select({
          sessionTokenHash: desktopEditSessions.sessionTokenHash,
          status: desktopEditSessions.status,
        })
        .from(desktopEditSessions)
        .where(
          and(
            eq(desktopEditSessions.id, existingSession.id),
            eq(
              desktopEditSessions.workspaceId,
              authorizedSession.value.workspaceId,
            ),
          ),
        )
        .limit(1);
      const latestSession = latestSessions.at(0);

      if (latestSession?.status === "open") {
        return status(409, {
          code: DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
          message: DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
        });
      }

      return status(409, {
        message: "Desktop edit session is already closed.",
      });
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
      resourceId: existingSession.id,
      changes: {
        checkpointSha256Hex: {
          old: existingSession.checkpointSha256Hex,
          new: sha256Hex,
        },
        checkpointSizeBytes: {
          old: existingSession.checkpointSizeBytes,
          new: file.size,
        },
      },
      metadata: {
        fileName: existingSession.fileName,
        fileType: existingSession.fileType,
        sizeBytes: file.size,
        sha256Hex,
      },
    });

    return {
      checkpointedAt: checkpointedAt.toISOString(),
      noop: false,
      rotatedSessionToken: nextSessionToken,
    };
  });

  // Only broadcast when a real checkpoint was saved (not on noop/error)
  if ("noop" in result && !result.noop) {
    broadcastWorkspaceResourceUpdated(
      authorizedSession.value.workspaceId,
      resourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: authorizedSession.value.entityId,
      }),
    );
  }

  return result;
};
