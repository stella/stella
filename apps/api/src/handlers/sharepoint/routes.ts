import connectSharepoint from "@/api/handlers/sharepoint/connect";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import listSharepointDriveItems from "@/api/handlers/sharepoint/drives/items/list";
import listSharepointDrives from "@/api/handlers/sharepoint/drives/list";
import importSharepointFiles from "@/api/handlers/sharepoint/imports/create";
import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import setSharepointCapabilities from "@/api/handlers/sharepoint/set-capabilities";
import setSharepointEnablement from "@/api/handlers/sharepoint/set-enablement";
import listSharepointSites from "@/api/handlers/sharepoint/sites/list";
import sharepointConnectionStatus from "@/api/handlers/sharepoint/status";
import { mount, routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

export const sharepointRoute = mount(
  [
    routes({
      "/oauth/callback": { GET: sharepointOAuthCallback },
      "/enablement": { PUT: setSharepointEnablement },
      "/connect": { POST: connectSharepoint },
      "/connection": {
        GET: sharepointConnectionStatus,
        DELETE: disconnectSharepoint,
      },
    }),
    // Capability policy, browsing and import answer as an absent route while
    // the deployment flag is off; each handler still checks the organization's
    // opt-in. `/enablement` stays the always-available whole-org kill.
    routes(
      {
        "/capabilities": { PUT: setSharepointCapabilities },
        "/sites": { GET: listSharepointSites },
        "/drives": { GET: listSharepointDrives },
        "/drives/:driveId/items/:itemId/children": {
          GET: listSharepointDriveItems,
        },
        "/imports/:workspaceId": { POST: importSharepointFiles },
      },
      { middleware: [deploymentFeatureGate("FEATURE_SHAREPOINT")] },
    ),
  ],
  { prefix: "/sharepoint" },
);
