import { Result } from "better-result";

import type { properties, propertyDependencies } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { deserializeAITool } from "@/api/lib/markdown/ai-tool";

type PropertyRow = typeof properties.$inferSelect;

type PropertyDependencyProjection = Pick<
  typeof propertyDependencies.$inferSelect,
  "dependsOnPropertyId" | "condition"
>;

// Columns intentionally not sent to the client. A new schema column must
// either be projected by `toPropertyListItem` below or added here with a
// reason, or the totality check further down fails to typecheck. This guard
// exists because `kinds` once shipped on the table with no branch here
// projecting it, so the web client silently had no way to scope properties
// by entity kind.
const UNPROJECTED_PROPERTY_COLUMNS = [
  // Internal bookkeeping flag; not part of the client-facing contract.
  "system",
  // Playbook provenance: server-only correlation ids the client never reads.
  "playbookSourceId",
  "playbookDefinitionId",
] as const satisfies readonly (keyof PropertyRow)[];

type UnprojectedPropertyColumn = (typeof UNPROJECTED_PROPERTY_COLUMNS)[number];

const toPropertyListItem = (
  property: PropertyRow,
  dependencies: PropertyDependencyProjection[],
) => {
  const projected = {
    id: property.id,
    workspaceId: property.workspaceId,
    name: property.name,
    status: property.status,
    content: property.content,
    kinds: property.kinds,
    role: property.role,
    createdAt: property.createdAt,
  };

  if (property.tool.type === "ai-model") {
    return {
      ...projected,
      tool: deserializeAITool({ ...property.tool, dependencies }),
    };
  }

  if (property.tool.type === "manual-input") {
    return { ...projected, tool: { ...property.tool, dependencies } };
  }

  // The only remaining tool type is the playbook verdict. The web
  // client has first-class read-only support for it, pairing each
  // verdict onto its ASK column via `tool.askPropertyId`; masking it as
  // manual-input would render verdicts as editable single-select
  // columns. The grading inputs (rule/severity/standard) stay
  // server-side. The view-templates and update-by-id masking are
  // separate contracts.
  return {
    ...projected,
    tool: {
      version: property.tool.version,
      type: property.tool.type,
      askPropertyId: property.tool.askPropertyId,
      dependencies,
    },
  };
};

type PropertyListItem = ReturnType<typeof toPropertyListItem>;

type ProjectedPropertyColumn = Exclude<
  keyof PropertyRow,
  UnprojectedPropertyColumn
>;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedPropertyColumn = Exclude<
  ProjectedPropertyColumn,
  keyof PropertyListItem
>;
type UnexpectedProjectedPropertyColumn = Exclude<
  keyof PropertyListItem,
  ProjectedPropertyColumn
>;

true satisfies MissingProjectedPropertyColumn extends never ? true : never;
true satisfies UnexpectedProjectedPropertyColumn extends never ? true : never;

const config = {
  description:
    "List the property (column) definitions of a matter. Returns each " +
    "property's id, name, value type (text, single-select, multi-select, " +
    "date, or int), and status. Use the returned property id with " +
    "set_field_value to set a document's value for that property.",
  permissions: { workspace: ["read"] },
  mcp: { type: "tool", name: "list_properties" },
  access: "read",
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
      propertiesResult.map(({ dependencies, ...property }) =>
        toPropertyListItem(property, dependencies),
      ),
    );
  },
);

export default readProperties;
