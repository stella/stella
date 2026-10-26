import connectSharepoint from "@/api/handlers/sharepoint/connect";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import listSharepointDriveRoot from "@/api/handlers/sharepoint/list-drive-root";
import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import setSharepointEnablement from "@/api/handlers/sharepoint/set-enablement";
import sharepointConnectionStatus from "@/api/handlers/sharepoint/status";
import { routes } from "@/api/http/route";

export const sharepointRoute = routes(
  {
    "/oauth/callback": { GET: sharepointOAuthCallback },
    "/enablement": { PUT: setSharepointEnablement },
    "/connect": { POST: connectSharepoint },
    "/connection": {
      GET: sharepointConnectionStatus,
      DELETE: disconnectSharepoint,
    },
    "/drive/root": { GET: listSharepointDriveRoot },
  },
  { prefix: "/sharepoint" },
);
