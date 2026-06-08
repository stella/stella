import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db";
import { LIMITS } from "@/api/lib/limits";

const LIST_TEMPLATES_TOOL_NAME = "list_templates" as const;

type CreateTemplateToolsArgs = {
  scopedDb: ScopedDb;
};

/**
 * Chat tools for the document-template library. `list_templates` lets the
 * model discover which templates exist (and their ids) before it describes
 * or fills one. Org-scoped via RLS on `scopedDb`, so it only ever returns the
 * caller's own templates.
 */
export const createTemplateTools = ({ scopedDb }: CreateTemplateToolsArgs) => ({
  [LIST_TEMPLATES_TOOL_NAME]: tool({
    description:
      "List the document templates in this workspace (NDAs, powers of " +
      "attorney, leases, and so on). Returns each template's id, name and " +
      "number of fillable fields. Call this first so you know which " +
      "templates exist and their ids before filling one.",
    inputSchema: valibotSchema(v.strictObject({})),
    execute: async () => {
      const rows = await scopedDb((tx) =>
        tx.query.templates.findMany({
          columns: { id: true, name: true, fieldCount: true },
          orderBy: { createdAt: "desc" },
          limit: LIMITS.templatesCount,
        }),
      );
      return { templates: rows };
    },
  }),
});

export { LIST_TEMPLATES_TOOL_NAME };
