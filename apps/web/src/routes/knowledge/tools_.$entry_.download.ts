import { createFileRoute } from "@tanstack/react-router";

import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import {
  publicToolDownloadResponse,
  publicToolNotFoundResponse,
} from "@/lib/knowledge/public-tool-download";
import { classifyToolEntry } from "@/lib/knowledge/tool-entry";

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
