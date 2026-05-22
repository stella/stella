import Elysia from "elysia";

import authorizeFolioCollabSessionHandler from "@/api/handlers/folio-collab/authorize";
import cancelFolioCollabSession from "@/api/handlers/folio-collab/cancel";
import checkpointFolioCollabSession from "@/api/handlers/folio-collab/checkpoint";
import finalizeFolioCollabSession from "@/api/handlers/folio-collab/finalize";
import refreshFolioCollabToken from "@/api/handlers/folio-collab/refresh-token";
import loadFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-load";
import storeFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-store";

export const folioCollabRoute = new Elysia({
  prefix: "/folio-collab-sessions",
})
  .post(
    "/authorize",
    authorizeFolioCollabSessionHandler.handler,
    authorizeFolioCollabSessionHandler.config,
  )
  .post(
    "/refresh-token",
    refreshFolioCollabToken.handler,
    refreshFolioCollabToken.config,
  )
  .post(
    "/snapshot/load",
    loadFolioCollabSnapshotHandler.handler,
    loadFolioCollabSnapshotHandler.config,
  )
  .post(
    "/snapshot/store",
    storeFolioCollabSnapshotHandler.handler,
    storeFolioCollabSnapshotHandler.config,
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
