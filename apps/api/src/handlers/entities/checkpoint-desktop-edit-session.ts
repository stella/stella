import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import { desktopEditSessions } from "@/api/db/schema";
import { createFileKey } from "@/api/handlers/files/utils";
import {
  authorizeDesktopEditSession,
  computeTokenExpiresAt,
  createDesktopEditSessionToken,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE,
  DESKTOP_EDIT_SESSION_TAKEN_OVER_MESSAGE,
  hashDesktopEditSessionToken,
} from "@/api/lib/desktop-edit-sessions";
import { scanFile } from "@/api/lib/file-scan/scan";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { broadcast } from "@/api/lib/sse";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const checkpointDesktopEditSessionParamsSchema = t.Object({
  sessionId: t.String({ format: "uuid" }),
});

export const checkpointDesktopEditSessionBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.document,
  }),
  sessionToken: t.String({ minLength: 64, maxLength: 64 }),
});

type CheckpointDesktopEditSessionHandlerProps = {
  body: Static<typeof checkpointDesktopEditSessionBodySchema>;
  sessionId: string;
};

export const checkpointDesktopEditSessionHandler = async ({
  body: { file, sessionToken },
  sessionId,
}: CheckpointDesktopEditSessionHandlerProps) => {
  if (file.type !== DOCX_MIME_TYPE) {
    return status(400, {
      message: "Desktop checkpoints currently support only DOCX files.",
    });
  }

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
        "Desktop edit session token has expired. Reopen the document from stella.",
    });
  }

  const fileName = sanitizeFilename(file.name);
  const buffer = await file.arrayBuffer();
  const sha256Hex = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");

  const scanResult = await scanFile({
    buffer: new Uint8Array(buffer),
    declaredMimeType: file.type,
    fileName,
  });

  if (Result.isError(scanResult)) {
    return status(422, {
      message: "File security scan failed.",
    });
  }

  if (scanResult.value.verdict === "reject") {
    const reasons = scanResult.value.findings
      .filter((finding) => finding.severity === "reject")
      .map((finding) => finding.message);

    return status(422, {
      message: `File rejected: ${reasons.join("; ")}`,
    });
  }

  const scanWarnings =
    scanResult.value.verdict === "warn"
      ? scanResult.value.findings
          .filter((finding) => finding.severity === "warn")
          .map((finding) => finding.message)
      : null;

  const result = await authorizedSession.value.scopedDb(async (tx) => {
    const existingSessions = await tx
      .select({
        checkpointFileId: desktopEditSessions.checkpointFileId,
        checkpointSha256Hex: desktopEditSessions.checkpointSha256Hex,
        checkpointUpdatedAt: desktopEditSessions.checkpointUpdatedAt,
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

    if (existingSession.checkpointSha256Hex === sha256Hex) {
      // Extend expiry even on noop to keep the session alive
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
      mimeType: DOCX_MIME_TYPE,
      organizationId: authorizedSession.value.organizationId,
      workspaceId: authorizedSession.value.workspaceId,
    });

    await getS3().write(key, new Uint8Array(buffer));

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
        fileName,
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

    return {
      checkpointedAt: checkpointedAt.toISOString(),
      noop: false,
      rotatedSessionToken: nextSessionToken,
    };
  });

  // Only broadcast when a real checkpoint was saved (not on noop/error)
  if ("noop" in result && !result.noop) {
    broadcast(authorizedSession.value.workspaceId, {
      type: "invalidate-query",
      data: ["entities", authorizedSession.value.workspaceId],
    });
  }

  return result;
};
