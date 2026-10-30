import readUserFileContent from "@/api/handlers/user-files/read-content";
import readUserFileThumbnail from "@/api/handlers/user-files/read-thumbnail";
import readUserFileVisual from "@/api/handlers/user-files/read-visual";
import { routes } from "@/api/http/route";

export const userFilesRoute = routes(
  {
    "/:fileId/visual": { GET: readUserFileVisual },
    "/:fileId/content": { GET: readUserFileContent },
    "/:fileId/thumbnail": { GET: readUserFileThumbnail },
  },
  { prefix: "/user-files" },
);
