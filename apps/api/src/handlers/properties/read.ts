import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

const config = {
  permissions: { workspace: ["read"] },
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
            createdAt: property.createdAt,
          };
        }

        return {
          id: property.id,
          workspaceId,
          name: property.name,
          status: property.status,
          content: property.content,
          tool: property.tool,
          createdAt: property.createdAt,
        };
      }),
    );
  },
);

export default readProperties;
