import { createPathMatcher } from "@stll/ssr-kit";

import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { publicToolsBasePath } from "@/lib/knowledge/public-tools-path";

// Knowledge readable without an account renders on the server: a published
// entry in full, every other page as the skeleton it shows until the visitor
// is known. The published tools live inside it; until then they have their
// own top-level pages.
export const isPublicSsrPath = createPathMatcher([
  { type: "subtree", path: "/law" },
  {
    type: "subtree",
    path: isPublicKnowledgeEnabled() ? "/knowledge" : publicToolsBasePath(),
  },
]);
