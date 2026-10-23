import authorizeFolioCollabRoomHandler from "@/api/handlers/folio-collab/authorize";
import heartbeatFolioCollabRoom from "@/api/handlers/folio-collab/heartbeat";
import refreshFolioCollabToken from "@/api/handlers/folio-collab/refresh-token";
import loadFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-load";
import acknowledgeFolioCollabSeed from "@/api/handlers/folio-collab/snapshot-seed";
import storeFolioCollabSnapshotHandler from "@/api/handlers/folio-collab/snapshot-store";
import { routes } from "@/api/http/route";
import { folioCollabBudget } from "@/api/lib/rate-limit/dedicated-budgets";

export const folioCollabRoute = routes(
  {
    "/authorize": { POST: authorizeFolioCollabRoomHandler },
    "/refresh-token": { POST: refreshFolioCollabToken },
    "/heartbeat": { POST: heartbeatFolioCollabRoom },
    "/snapshot/load": { POST: loadFolioCollabSnapshotHandler },
    "/snapshot/seed": { POST: acknowledgeFolioCollabSeed },
    "/snapshot/store": { POST: storeFolioCollabSnapshotHandler },
  },
  { prefix: "/folio-collab-rooms", middleware: [folioCollabBudget] },
);
