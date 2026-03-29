import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const readProperties = createHandler(
  config,
  async ({ scopedDb, workspaceId }) => {
    const propertiesResult = await scopedDb((tx) =>
      tx.query.properties.findMany({
        where: { workspaceId: { eq: workspaceId } },
        orderBy: { createdAt: "asc" },
        with: {
          dependencies: {
            columns: {
              dependsOnPropertyId: true,
              condition: true,
            },
          },
        },
      }),
    );

    return propertiesResult.map(({ dependencies, ...property }) => ({
      id: property.id,
      workspaceId,
      name: property.name,
      status: property.status,
      content: property.content,
      tool:
        property.tool.type === "ai-model"
          ? deserializeAITool({
              ...property.tool,
              dependencies,
            })
          : property.tool,
      createdAt: property.createdAt,
    }));
  },
);

export default readProperties;
