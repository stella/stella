import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

const config = {
  description:
    "List the property (column) definitions of a matter. Returns each " +
    "property's id, name, value type (text, single-select, multi-select, " +
    "date, or int), and status. Use the returned property id with " +
    "set_field_value to set a document's value for that property.",
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "list_properties" },
} satisfies HandlerConfig;

const readProperties = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    const propertiesResult = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          orderBy: { createdAt: "asc" },
          limit: LIMITS.propertiesCount,
          with: {
            dependencies: {
              columns: {
                dependsOnPropertyId: true,
                condition: true,
              },
            },
          },
        }),
      ),
    );

    return Result.ok(
      propertiesResult.map(({ dependencies, ...property }) => {
        if (property.tool.type === "ai-model") {
          return {
            id: property.id,
            workspaceId,
            name: property.name,
            status: property.status,
            content: property.content,
            tool: deserializeAITool({
              ...property.tool,
              dependencies,
            }),
            role: property.role,
            createdAt: property.createdAt,
          };
        }
        if (property.tool.type === "manual-input") {
          return {
            id: property.id,
            workspaceId,
            name: property.name,
            status: property.status,
            content: property.content,
            tool: { ...property.tool, dependencies },
            role: property.role,
            createdAt: property.createdAt,
          };
        }
        // The only remaining tool type is the playbook verdict. The web
        // client has first-class read-only support for it, pairing each
        // verdict onto its ASK column via `tool.askPropertyId`; masking it as
        // manual-input would render verdicts as editable single-select
        // columns. The grading inputs (rule/severity/standard) stay
        // server-side. The view-templates and update-by-id masking are
        // separate contracts.
        return {
          id: property.id,
          workspaceId,
          name: property.name,
          status: property.status,
          content: property.content,
          tool: {
            version: property.tool.version,
            type: property.tool.type,
            askPropertyId: property.tool.askPropertyId,
            dependencies,
          },
          role: property.role,
          createdAt: property.createdAt,
        };
      }),
    );
  },
);

export default readProperties;
