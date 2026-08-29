import Elysia from "elysia";

import authorizeFolioCollabRoomHandler from "@/api/handlers/folio-collab/authorize";
import heartbeatFolioCollabRoom from "@/api/handlers/folio-collab/heartbeat";
import refreshFolioCollabToken from "@/api/handlers/folio-collab/refresh-token";
import loadFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-load";
import storeFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-store";

export const folioCollabRoute = new Elysia({
  prefix: "/folio-collab-rooms",
})
  .post(
    "/authorize",
    authorizeFolioCollabRoomHandler.handler,
    authorizeFolioCollabRoomHandler.config,
  )
  .post(
    "/refresh-token",
    refreshFolioCollabToken.handler,
    refreshFolioCollabToken.config,
  )
  .post(
    "/heartbeat",
    heartbeatFolioCollabRoom.handler,
    heartbeatFolioCollabRoom.config,
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
  );
