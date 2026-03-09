import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

type ReadPropertiesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
};

export const readPropertiesHandler = async ({
  scopedDb,
  workspaceId,
}: ReadPropertiesHandlerProps) => {
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
};
