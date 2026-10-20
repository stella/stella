import Elysia from "elysia";

import authorizeFolioCollabRoomHandler from "@/api/handlers/folio-collab/authorize";
import heartbeatFolioCollabRoom from "@/api/handlers/folio-collab/heartbeat";
import refreshFolioCollabToken from "@/api/handlers/folio-collab/refresh-token";
import loadFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-load";
import acknowledgeFolioCollabSeed from "@/api/handlers/folio-collab/snapshot-seed";
import storeFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-store";

export const folioCollabRoute = new Elysia({
  prefix: "/folio-collab-rooms",
})
  .post(
    "/authorize",
    {
      body: authorizeFolioCollabRoomHandler.config.body,
    },
    authorizeFolioCollabRoomHandler.handler,
  )
  .post(
    "/refresh-token",
    {
      body: refreshFolioCollabToken.config.body,
    },
    refreshFolioCollabToken.handler,
  )
  .post(
    "/heartbeat",
    {
      body: heartbeatFolioCollabRoom.config.body,
    },
    heartbeatFolioCollabRoom.handler,
  )
  .post(
    "/snapshot/load",
    {
      body: loadFolioCollabSnapshotHandler.config.body,
    },
    loadFolioCollabSnapshotHandler.handler,
  )
  .post(
    "/snapshot/seed",
    {
      body: acknowledgeFolioCollabSeed.config.body,
    },
    acknowledgeFolioCollabSeed.handler,
  )
  .post(
    "/snapshot/store",
    {
      body: storeFolioCollabSnapshotHandler.config.body,
    },
    storeFolioCollabSnapshotHandler.handler,
  );
