import Elysia from "elysia";

import authorizeFolioCollabRoomHandler from "@/api/handlers/folio-collab/authorize";
import heartbeatFolioCollabRoom from "@/api/handlers/folio-collab/heartbeat";
import refreshFolioCollabToken from "@/api/handlers/folio-collab/refresh-token";
import loadFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-load";
import storeFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-store";

export const folioCollabRoute = new Elysia({
  prefix: "/folio-collab-rooms",
})
  .post("/authorize", authorizeFolioCollabRoomHandler.handler, {
    body: authorizeFolioCollabRoomHandler.config.body,
  })
  .post("/refresh-token", refreshFolioCollabToken.handler, {
    body: refreshFolioCollabToken.config.body,
  })
  .post("/heartbeat", heartbeatFolioCollabRoom.handler, {
    body: heartbeatFolioCollabRoom.config.body,
  })
  .post("/snapshot/load", loadFolioCollabSnapshotHandler.handler, {
    body: loadFolioCollabSnapshotHandler.config.body,
  })
  .post("/snapshot/store", storeFolioCollabSnapshotHandler.handler, {
    body: storeFolioCollabSnapshotHandler.config.body,
  });
