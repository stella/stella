import Elysia, { status, t } from "elysia";

import cancelFolioCollabSession from "@/api/handlers/folio-collab/cancel";
import checkpointFolioCollabSession from "@/api/handlers/folio-collab/checkpoint";
import finalizeFolioCollabSession from "@/api/handlers/folio-collab/finalize";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  authorizeFolioCollabSession,
  FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  FOLIO_COLLAB_SNAPSHOT_MAX_BYTES,
  issueFolioCollabToken,
  loadFolioCollabSnapshot,
  storeFolioCollabSnapshot,
} from "@/api/lib/folio-collab-sessions";

const authBodySchema = t.Object({
  sessionId: tSafeId("folioCollabSession"),
  token: t.String({ minLength: 64, maxLength: 64 }),
});

const storeSnapshotBodySchema = t.Object({
  sessionId: tSafeId("folioCollabSession"),
  snapshotBase64: t.String({
    maxLength: FOLIO_COLLAB_SNAPSHOT_MAX_BASE64_LENGTH,
  }),
  token: t.String({ minLength: 64, maxLength: 64 }),
});

const authorizeOrRespond = async ({
  sessionId,
  token,
}: {
  sessionId: SafeId<"folioCollabSession">;
  token: string;
}) => {
  const authorized = await authorizeFolioCollabSession({ sessionId, token });

  if (authorized.status === "missing") {
    return {
      ok: false,
      response: status(404, {
        message: "Collaborative edit session not found.",
      }),
    } as const;
  }
  if (authorized.status === "token-expired") {
    return {
      ok: false,
      response: status(401, { message: "Collaborative edit token expired." }),
    } as const;
  }
  if (authorized.status === "permission-revoked") {
    return {
      ok: false,
      response: status(403, {
        message: "Collaborative edit permission revoked.",
      }),
    } as const;
  }

  return { ok: true, value: authorized.value } as const;
};

export const folioCollabRoute = new Elysia({
  prefix: "/folio-collab-sessions",
})
  .post(
    "/authorize",
    async ({ body }) => {
      const authorized = await authorizeOrRespond(body);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { value } = authorized;

      return {
        canEdit: value.canEdit,
        roomName: value.sessionId,
        sessionId: value.sessionId,
        tokenExpiresAt: value.tokenExpiresAt.toISOString(),
        userId: value.userId,
        workspaceId: value.workspaceId,
      };
    },
    { body: authBodySchema },
  )
  .post(
    "/refresh-token",
    async ({ body }) => {
      const authorized = await authorizeOrRespond(body);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { value } = authorized;

      const { token, tokenExpiresAt } = await value.scopedDb(
        async (tx) =>
          await issueFolioCollabToken({
            permissions: { canEdit: value.canEdit },
            sessionId: value.sessionId,
            tx,
            userId: value.userId,
            workspaceId: value.workspaceId,
          }),
      );

      return {
        token,
        tokenExpiresAt: tokenExpiresAt.toISOString(),
      };
    },
    { body: authBodySchema },
  )
  .post(
    "/snapshot/load",
    async ({ body }) => {
      const authorized = await authorizeOrRespond(body);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { value } = authorized;

      return {
        snapshotBase64: await loadFolioCollabSnapshot(value),
      };
    },
    { body: authBodySchema },
  )
  .post(
    "/snapshot/store",
    async ({ body }) => {
      const authorized = await authorizeOrRespond(body);
      if (!authorized.ok) {
        return authorized.response;
      }
      const { value } = authorized;

      if (!value.canEdit) {
        return status(403, { message: "Collaborative edit is read-only." });
      }

      const snapshotBytes = Buffer.from(body.snapshotBase64, "base64");
      if (snapshotBytes.byteLength > FOLIO_COLLAB_SNAPSHOT_MAX_BYTES) {
        return status(413, { message: "Collaborative snapshot too large." });
      }

      const { storedAt } = await storeFolioCollabSnapshot({
        snapshotBytes,
        value,
      });

      return { storedAt: storedAt.toISOString() };
    },
    { body: storeSnapshotBodySchema },
  )
  .post(
    "/:sessionId/cancel",
    cancelFolioCollabSession.handler,
    cancelFolioCollabSession.config,
  )
  .post(
    "/:sessionId/checkpoint",
    checkpointFolioCollabSession.handler,
    checkpointFolioCollabSession.config,
  )
  .post(
    "/:sessionId/finalize",
    finalizeFolioCollabSession.handler,
    finalizeFolioCollabSession.config,
  );
