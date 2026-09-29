import { createFileRoute } from "@tanstack/react-router";

import {
  publicToolDownloadResponse,
  publicToolNotFoundResponse,
} from "@/lib/public-tool-download";
import { legacyToolsRoutesServed } from "@/lib/public-tools-path";

// Goes once the Knowledge flag is permanent: the download then lives only at
// `/knowledge/tools/$entry/download`.
export const Route = createFileRoute("/tools/$slug_/download")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!legacyToolsRoutesServed()) {
          return publicToolNotFoundResponse();
        }
        return await publicToolDownloadResponse(params.slug);
      },
    },
  },
});
