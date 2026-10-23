import approvePlaybookDefinition from "@/api/handlers/playbooks/approve";
import createPlaybookDefinition from "@/api/handlers/playbooks/create";
import deletePlaybookDefinition from "@/api/handlers/playbooks/delete";
import createPlaybookFromRun from "@/api/handlers/playbooks/from-run/create";
import createPlaybookFromStarter from "@/api/handlers/playbooks/from-starter/create";
import getPlaybookDefinition from "@/api/handlers/playbooks/get";
import listPlaybookDefinitions from "@/api/handlers/playbooks/list";
import listRecentPlaybooks from "@/api/handlers/playbooks/recent/list";
import listStarterPlaybooks from "@/api/handlers/playbooks/starters/list";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update";
import listPlaybookVersions from "@/api/handlers/playbooks/versions/list";
import restorePlaybookVersion from "@/api/handlers/playbooks/versions/restore";
import { routes } from "@/api/http/route";

export const playbooksRoute = routes(
  {
    "/": { GET: listPlaybookDefinitions, POST: createPlaybookDefinition },
    "/starters": { GET: listStarterPlaybooks },
    "/recent": { GET: listRecentPlaybooks },
    "/from-starter": { POST: createPlaybookFromStarter },
    "/from-run": { POST: createPlaybookFromRun },
    "/:playbookId": {
      GET: getPlaybookDefinition,
      PUT: updatePlaybookDefinition,
      DELETE: deletePlaybookDefinition,
    },
    "/:playbookId/approve": { POST: approvePlaybookDefinition },
    "/:playbookId/versions": { GET: listPlaybookVersions },
    "/:playbookId/versions/:version/restore": { POST: restorePlaybookVersion },
  },
  { prefix: "/playbooks" },
);
