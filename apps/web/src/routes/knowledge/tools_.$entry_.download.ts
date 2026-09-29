import { createFileRoute } from "@tanstack/react-router";

import { classifyToolEntry } from "@/lib/knowledge/tool-entry";
import { isPublicKnowledgeEnabled } from "@/lib/public-knowledge-launch";
import {
  publicToolDownloadResponse,
  publicToolNotFoundResponse,
} from "@/lib/public-tool-download";

// A published skill's zip. Only catalogue slugs are served: an organization's
// skill id is never looked up here.
export const Route = createFileRoute("/knowledge/tools_/$entry_/download")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (
          !isPublicKnowledgeEnabled() ||
          classifyToolEntry(params.entry) !== "catalogue"
        ) {
          return publicToolNotFoundResponse();
        }
        return await publicToolDownloadResponse(params.entry);
      },
    },
  },
});
