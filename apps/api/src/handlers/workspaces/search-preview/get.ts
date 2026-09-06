import { Result } from "better-result";

import { readSearchPreviewHandler } from "@/api/handlers/workspaces/read-search-preview.query";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Return bounded task and document highlights for a matter search-result preview.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_matters" },
  access: "read",
} satisfies HandlerConfig;

const readSearchPreview = createSafeHandler(
  config,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () => await readSearchPreviewHandler({ scopedDb, workspaceId }),
      ),
    );
    return Result.ok(response);
  },
);

export default readSearchPreview;
