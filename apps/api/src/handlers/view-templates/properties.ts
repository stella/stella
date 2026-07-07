import { deepEquals } from "bun";

import type { ConditionNode } from "@stll/conditions";

import type { Transaction } from "@/api/db";
import { properties, propertyDependencies } from "@/api/db/schema";
import { lockWorkspacePropertyWrites } from "@/api/handlers/properties/property-lock";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  collectNodePropertyIds,
  remapDependencyRefs,
  remapNodePropertyIds,
} from "@/api/lib/conditions/ast-utils";
import { parseStoredCondition } from "@/api/lib/conditions/parse-stored";
import { LIMITS } from "@/api/lib/limits";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";
import { brandPersistedPropertyId } from "@/api/lib/safe-id-boundaries";
import { sortDeep } from "@/api/lib/sort-deep";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";

type WorkspacePropertyTemplateSource = {
  id: string;
  name: string;
  content: typeof properties.$inferSelect.content;
  tool: typeof properties.$inferSelect.tool;
  system: boolean;
  role: typeof properties.$inferSelect.role;
};

type WorkspacePropertyDependencySource = {
  propertyId: string;
  dependsOnPropertyId: string;
  condition: ConditionNode | null;
};

type ResolveTemplatePropertiesOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  layout: ViewLayout;
  templateProperties: readonly ViewTemplateProperty[] | undefined;
  canCreateProperties: boolean;
  recordAuditEvent: AuditRecorder;
};

type ResolveTemplatePropertiesResult =
  | { ok: true; layout: ViewLayout; propertyIds: string[] }
  | { ok: false; status: 400 | 403 | 422; message: string };

export const collectTemplateProperties = ({
  layout,
  properties: workspaceProperties,
  dependencies,
}: {
  layout: ViewLayout;
  properties: readonly WorkspacePropertyTemplateSource[];
  dependencies: readonly WorkspacePropertyDependencySource[];
}): ViewTemplateProperty[] => {
  const referencedPropertyIds = collectLayoutPropertyIds(layout);
  const visiblePropertyIds = collectVisibleTemplatePropertyIds({
    layout,
    properties: workspaceProperties,
  });
  const dependenciesByPropertyId = new Map<
    string,
    { dependsOnSourceId: string; condition: ConditionNode | null }[]
  >();
  for (const dep of dependencies) {
    const list = dependenciesByPropertyId.get(dep.propertyId) ?? [];
    list.push({
      dependsOnSourceId: dep.dependsOnPropertyId,
      condition: parseStoredCondition(dep.condition),
    });
    dependenciesByPropertyId.set(dep.propertyId, list);
  }
  const creatablePropertyIds = new Set([
    ...referencedPropertyIds,
    ...visiblePropertyIds,
  ]);
  addDependencySourceIds(creatablePropertyIds, dependenciesByPropertyId);

  return workspaceProperties
    .filter((property) => !property.system)
    .filter(
      (property) =>
        creatablePropertyIds.has(property.id) ||
        layout.hiddenProperties.includes(property.id),
    )
    .map((property): ViewTemplateProperty => {
      const propertyDeps = dependenciesByPropertyId.get(property.id);
      const result: ViewTemplateProperty = {
        version: 1,
        sourceId: property.id,
        name: property.name,
        content: property.content,
        // A view template can carry ai-model or manual-input columns only; a
        // playbook verdict column exports as a plain single-select (manual)
        // column, since its verdict computation is tied to a playbook run.
        tool:
          property.tool.type === "playbook-verdict"
            ? { version: 1, type: "manual-input" }
            : property.tool,
        createIfMissing: creatablePropertyIds.has(property.id),
      };
      if (propertyDeps && propertyDeps.length > 0) {
        result.dependencies = propertyDeps;
      }
      if (property.role !== null && property.role !== undefined) {
        result.role = property.role;
      }
      return result;
    });
};

const addDependencySourceIds = (
  creatablePropertyIds: Set<string>,
  dependenciesByPropertyId: ReadonlyMap<
    string,
    readonly {
      dependsOnSourceId: string;
      condition: ConditionNode | null;
    }[]
  >,
): void => {
  const queue = [...creatablePropertyIds];

  for (const propertyId of queue) {
    for (const dependency of dependenciesByPropertyId.get(propertyId) ?? []) {
      if (creatablePropertyIds.has(dependency.dependsOnSourceId)) {
        continue;
      }
      creatablePropertyIds.add(dependency.dependsOnSourceId);
      queue.push(dependency.dependsOnSourceId);
    }
  }
};

export const resolveTemplateProperties = async ({
  tx,
  workspaceId,
  layout,
  templateProperties,
  canCreateProperties,
  recordAuditEvent,
}: ResolveTemplatePropertiesOptions): Promise<ResolveTemplatePropertiesResult> => {
  if (!templateProperties || templateProperties.length === 0) {
    const existing = await readExistingProperties(tx, workspaceId);
    const systemFile = findSystemFileProperty(existing);
    prependSystemFileToColumnOrder(layout, systemFile);
    return {
      ok: true,
      layout,
      propertyIds: existing.map((property) => property.id),
    };
  }

  const validationError = validateTemplateProperties(templateProperties);
  if (validationError) {
    return validationError;
  }

  await lockWorkspacePropertyWrites(tx, workspaceId);

  const existingProperties = await readExistingProperties(tx, workspaceId);
  const systemFileProperty = findSystemFileProperty(existingProperties);
  // SAFETY: one workspace's property-dependency edges, bounded by its properties (<= LIMITS.propertiesCount per endpoint)
  // eslint-disable-next-line require-query-limit/require-query-limit
  const existingDependencyEdges = await tx.query.propertyDependencies.findMany({
    where: { workspaceId: { eq: workspaceId } },
    columns: { propertyId: true },
  });
  const propertyIdsWithDependencies = new Set(
    existingDependencyEdges.map((edge) => edge.propertyId),
  );
  const nextPropertyIds = existingProperties.map((property) => property.id);
  const propertyIdBySourceId = new Map<string, string>();
  const createdPropertySourceIds = new Set<string>();
  const consumedExistingPropertyIds = new Set<string>();
  const templatePropertiesToCreate: ViewTemplateProperty[] = [];
  let projectedPropertyCount = nextPropertyIds.length;

  for (const templateProperty of templateProperties) {
    const existingById = existingProperties.find(
      (property) => property.id === templateProperty.sourceId,
    );
    if (existingById) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingById.id);
      consumedExistingPropertyIds.add(existingById.id);
      continue;
    }

    const existingByRole = findUniquePropertyByRole(
      existingProperties,
      templateProperty,
      consumedExistingPropertyIds,
    );
    if (existingByRole) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingByRole.id);
      consumedExistingPropertyIds.add(existingByRole.id);
      continue;
    }

    const existingByShape = findUniquePropertyByShape(
      existingProperties,
      templateProperty,
      consumedExistingPropertyIds,
      propertyIdsWithDependencies,
    );
    if (existingByShape) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingByShape.id);
      consumedExistingPropertyIds.add(existingByShape.id);
      continue;
    }

    if (!templateProperty.createIfMissing) {
      continue;
    }

    if (!canCreateProperties) {
      return {
        ok: false,
        status: 403,
        message: "Missing permission to create template columns",
      };
    }

    if (projectedPropertyCount >= LIMITS.propertiesCount) {
      return {
        ok: false,
        status: 400,
        message: "Properties limit reached",
      };
    }

    createdPropertySourceIds.add(templateProperty.sourceId);
    templatePropertiesToCreate.push(templateProperty);
    projectedPropertyCount += 1;
  }

  if (
    hasTemplateDependencyCycle({
      templateProperties,
      createdPropertySourceIds,
    })
  ) {
    return {
      ok: false,
      status: 422,
      message: "Circular template dependency detected",
    };
  }

  for (const templateProperty of templatePropertiesToCreate) {
    // oxlint-disable-next-line no-await-in-loop -- sequential inserts preserve column order and feed the source-id mapping
    const [inserted] = await tx
      .insert(properties)
      .values({
        workspaceId,
        name: templateProperty.name,
        content: templateProperty.content,
        tool: sanitizeTemplatePropertyTool(templateProperty.tool),
        role: templateProperty.role ?? null,
        status: templateProperty.tool.type === "ai-model" ? "stale" : "fresh",
      })
      .returning({ id: properties.id });

    if (!inserted) {
      return {
        ok: false,
        status: 400,
        message: "Failed to create template column",
      };
    }

    propertyIdBySourceId.set(templateProperty.sourceId, inserted.id);
    nextPropertyIds.push(inserted.id);

    // oxlint-disable-next-line no-await-in-loop -- audit row depends on the property id inserted in this same iteration
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
      resourceId: inserted.id,
      changes: {
        createdFromViewTemplate: {
          old: null,
          new: {
            name: templateProperty.name,
            contentType: templateProperty.content.type,
            toolType: templateProperty.tool.type,
          },
        },
      },
    });
  }

  await recreateTemplateDependencies({
    tx,
    workspaceId,
    templateProperties,
    propertyIdBySourceId,
    createdPropertySourceIds,
    recordAuditEvent,
    systemFilePropertyId: systemFileProperty?.id,
  });

  remapLayoutPropertyIds(layout, propertyIdBySourceId);
  prependSystemFileToColumnOrder(layout, systemFileProperty);

  return { ok: true, layout, propertyIds: nextPropertyIds };
};

const readExistingProperties = (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) =>
  tx.query.properties.findMany({
    where: { workspaceId: { eq: workspaceId } },
    columns: {
      id: true,
      name: true,
      content: true,
      tool: true,
      system: true,
      role: true,
    },
    orderBy: { createdAt: "asc" },
    limit: LIMITS.propertiesCount,
  });

type ExistingProperty = Awaited<
  ReturnType<typeof readExistingProperties>
>[number];

const findSystemFileProperty = (existing: readonly ExistingProperty[]) =>
  existing.find(
    (property) => property.system && property.content.type === "file",
  );

// Templates strip system properties, so their saved columnOrder never
// carries the workspace-specific Documents id. Without this prepend it
// lands at the end of the table.
const prependSystemFileToColumnOrder = (
  layout: ViewLayout,
  systemFileProperty: ExistingProperty | undefined,
): void => {
  if (
    layout.type !== "table" ||
    !systemFileProperty ||
    layout.columnOrder.includes(systemFileProperty.id)
  ) {
    return;
  }
  layout.columnOrder = [systemFileProperty.id, ...layout.columnOrder];
};

const sanitizeTemplatePropertyTool = (
  tool: ViewTemplateProperty["tool"],
): typeof properties.$inferSelect.tool => {
  if (tool.type === "manual-input") {
    return tool;
  }

  const { prompt } = serializeAITool({
    version: 1,
    type: "ai-model",
    prompt: tool.prompt,
    dependencies: [],
  });
  return { version: 1, type: "ai-model", prompt };
};

const recreateTemplateDependencies = async ({
  tx,
  workspaceId,
  templateProperties,
  propertyIdBySourceId,
  createdPropertySourceIds,
  recordAuditEvent,
  systemFilePropertyId,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  templateProperties: readonly ViewTemplateProperty[];
  propertyIdBySourceId: ReadonlyMap<string, string>;
  createdPropertySourceIds: ReadonlySet<string>;
  recordAuditEvent: AuditRecorder;
  systemFilePropertyId: string | undefined;
}): Promise<void> => {
  const rows = templateProperties.flatMap((templateProperty) => {
    if (!createdPropertySourceIds.has(templateProperty.sourceId)) {
      return [];
    }

    const propertyId = propertyIdBySourceId.get(templateProperty.sourceId);
    if (!propertyId) {
      return [];
    }

    const resolvedEdges = (templateProperty.dependencies ?? []).flatMap(
      (dep) => {
        // Remaps the edge and the gate condition together (so neither is
        // forgotten); null when the edge endpoint did not remap — the workflow
        // planner then treats the property as having no inputs.
        const refs = remapDependencyRefs(
          {
            dependsOnPropertyId: dep.dependsOnSourceId,
            condition: dep.condition,
          },
          (id) => propertyIdBySourceId.get(id),
        );
        if (!refs || refs.dependsOnPropertyId === propertyId) {
          return [];
        }
        return [
          {
            workspaceId,
            propertyId: brandPersistedPropertyId(propertyId),
            dependsOnPropertyId: brandPersistedPropertyId(
              refs.dependsOnPropertyId,
            ),
            condition: refs.condition,
          },
        ];
      },
    );

    // Templates strip the workspace-specific Documents id, so an AI
    // column whose only dependency pointed at Documents loses every
    // edge in remap. Fall back to the target workspace's system file
    // property so the new AI column has a source. Skip when the
    // template explicitly declared no dependencies (static-prompt
    // columns), so we don't force a spurious source on them.
    if (
      resolvedEdges.length === 0 &&
      templateProperty.dependencies !== undefined &&
      templateProperty.dependencies.length > 0 &&
      templateProperty.tool.type === "ai-model" &&
      systemFilePropertyId !== undefined &&
      systemFilePropertyId !== propertyId
    ) {
      return [
        {
          workspaceId,
          propertyId: brandPersistedPropertyId(propertyId),
          dependsOnPropertyId: brandPersistedPropertyId(systemFilePropertyId),
          condition: null,
        },
      ];
    }

    return resolvedEdges;
  });

  if (rows.length === 0) {
    return;
  }

  await tx
    .insert(propertyDependencies)
    .values(rows)
    .onConflictDoNothing({
      target: [
        propertyDependencies.propertyId,
        propertyDependencies.dependsOnPropertyId,
      ],
    });

  await recordAuditEvent(
    tx,
    rows.map((row) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
      resourceId: row.propertyId,
      changes: {
        dependencyCreatedFromViewTemplate: {
          old: null,
          new: {
            dependsOnPropertyId: row.dependsOnPropertyId,
            condition: row.condition,
          },
        },
      },
    })),
  );
};

const hasTemplateDependencyCycle = ({
  templateProperties,
  createdPropertySourceIds,
}: {
  templateProperties: readonly ViewTemplateProperty[];
  createdPropertySourceIds: ReadonlySet<string>;
}): boolean => {
  const graph = new Map<string, string[]>();

  for (const templateProperty of templateProperties) {
    if (!createdPropertySourceIds.has(templateProperty.sourceId)) {
      continue;
    }

    if (!templateProperty.dependencies) {
      continue;
    }

    const dependencySourceIds: string[] = [];
    for (const dep of templateProperty.dependencies) {
      if (
        dep.dependsOnSourceId === templateProperty.sourceId ||
        !createdPropertySourceIds.has(dep.dependsOnSourceId)
      ) {
        continue;
      }
      dependencySourceIds.push(dep.dependsOnSourceId);
    }
    graph.set(templateProperty.sourceId, dependencySourceIds);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (sourceId: string): boolean => {
    if (visiting.has(sourceId)) {
      return true;
    }
    if (visited.has(sourceId)) {
      return false;
    }

    visiting.add(sourceId);
    for (const dependencySourceId of graph.get(sourceId) ?? []) {
      if (visit(dependencySourceId)) {
        return true;
      }
    }
    visiting.delete(sourceId);
    visited.add(sourceId);
    return false;
  };

  for (const sourceId of graph.keys()) {
    if (visit(sourceId)) {
      return true;
    }
  }

  return false;
};

const validateTemplateProperties = (
  templateProperties: readonly ViewTemplateProperty[],
): ResolveTemplatePropertiesResult | null => {
  const sourceIds = new Set<string>();

  for (const templateProperty of templateProperties) {
    if (sourceIds.has(templateProperty.sourceId)) {
      return {
        ok: false,
        status: 422,
        message: "Duplicate template property sourceId",
      };
    }
    sourceIds.add(templateProperty.sourceId);

    const validationError = validateTemplatePropertyConfig(templateProperty);
    if (validationError) {
      return validationError;
    }
  }

  return null;
};

const validateTemplatePropertyConfig = (
  templateProperty: ViewTemplateProperty,
): ResolveTemplatePropertiesResult | null => {
  if (
    templateProperty.content.type === "file" &&
    templateProperty.tool.type !== "manual-input"
  ) {
    return {
      ok: false,
      status: 422,
      message: "File template columns must use manual input",
    };
  }

  if (
    templateProperty.tool.type !== "ai-model" &&
    templateProperty.dependencies &&
    templateProperty.dependencies.length > 0
  ) {
    return {
      ok: false,
      status: 422,
      message: "Only AI template columns can declare dependencies",
    };
  }

  if (
    templateProperty.content.type === "single-select" ||
    templateProperty.content.type === "multi-select"
  ) {
    const fallback = templateProperty.content.fallback;
    if (
      fallback !== null &&
      !templateProperty.content.options.some(
        (option) => option.value === fallback,
      )
    ) {
      return {
        ok: false,
        status: 400,
        message: "Fallback must match one of the supplied options",
      };
    }
  }

  return null;
};

const normalizePropertyName = (name: string): string =>
  name.trim().toLocaleLowerCase();

const DOCUMENT_TYPE_CLASSIFIER_ROLE = "document-type-classifier";

const isLegacyDocumentTypeClassifierTemplate = (
  templateProperty: ViewTemplateProperty,
): boolean =>
  templateProperty.role === undefined &&
  normalizePropertyName(templateProperty.name) === "document type" &&
  templateProperty.content.type === "single-select" &&
  templateProperty.tool.type === "ai-model";

const findUniquePropertyByRole = (
  existingProperties: readonly {
    id: string;
    role: typeof properties.$inferSelect.role;
  }[],
  templateProperty: ViewTemplateProperty,
  consumedExistingPropertyIds: ReadonlySet<string>,
) => {
  const role = isLegacyDocumentTypeClassifierTemplate(templateProperty)
    ? DOCUMENT_TYPE_CLASSIFIER_ROLE
    : templateProperty.role;

  if (role === undefined) {
    return undefined;
  }

  return existingProperties.find(
    (property) =>
      !consumedExistingPropertyIds.has(property.id) &&
      property.role === role,
  );
};

const findUniquePropertyByShape = (
  existingProperties: readonly {
    id: string;
    name: string;
    content: typeof properties.$inferSelect.content;
    tool: typeof properties.$inferSelect.tool;
    role: typeof properties.$inferSelect.role;
  }[],
  templateProperty: ViewTemplateProperty,
  consumedExistingPropertyIds: ReadonlySet<string>,
  propertyIdsWithDependencies: ReadonlySet<string>,
) => {
  // Reusing an AI column would silently inherit its existing dependency
  // graph, so only fall back when neither side carries dependencies.
  const templateHasDependencies =
    templateProperty.tool.type === "ai-model" &&
    (templateProperty.dependencies?.length ?? 0) > 0;

  const matches = existingProperties.filter(
    (property) =>
      !consumedExistingPropertyIds.has(property.id) &&
      normalizePropertyName(property.name) ===
        normalizePropertyName(templateProperty.name) &&
      property.content.type === templateProperty.content.type &&
      property.tool.type === templateProperty.tool.type &&
      property.role === (templateProperty.role ?? null) &&
      hasSamePropertyConfig(property, templateProperty) &&
      !(
        templateHasDependencies || propertyIdsWithDependencies.has(property.id)
      ),
  );

  return matches.length === 1 ? matches[0] : undefined;
};

const hasSamePropertyConfig = (
  property: Pick<WorkspacePropertyTemplateSource, "content" | "tool">,
  templateProperty: ViewTemplateProperty,
): boolean =>
  deepEquals(
    sortDeep({
      content: property.content,
      tool: property.tool,
    }),
    sortDeep({
      content: templateProperty.content,
      tool: templateProperty.tool,
    }),
  );

const collectVisibleTemplatePropertyIds = ({
  layout,
  properties: workspaceProperties,
}: {
  layout: ViewLayout;
  properties: readonly WorkspacePropertyTemplateSource[];
}): Set<string> => {
  const ids = new Set<string>();

  for (const property of workspaceProperties) {
    if (!layout.hiddenProperties.includes(property.id)) {
      ids.add(property.id);
    }
  }

  return ids;
};

const collectLayoutPropertyIds = (layout: ViewLayout): Set<string> => {
  const ids = new Set<string>();
  const add = (id: string) => {
    if (!isInternalPropertyId(id)) {
      ids.add(id);
    }
  };

  for (const sort of layout.sorts) {
    add(sort.propertyId);
  }

  const filterPropertyIds = new Set<string>();
  for (const node of layout.filters) {
    collectNodePropertyIds(node, filterPropertyIds);
  }
  for (const id of filterPropertyIds) {
    add(id);
  }

  if (layout.type === "table") {
    for (const id of layout.columnOrder) {
      add(id);
    }
    for (const id of layout.columnPinning) {
      add(id);
    }
    if (layout.groupByPropertyId) {
      add(layout.groupByPropertyId);
    }
  }

  if (layout.type === "kanban" && layout.groupByPropertyId) {
    add(layout.groupByPropertyId);
  }

  if (layout.type === "calendar") {
    add(layout.datePropertyId);
    if (layout.endDatePropertyId) {
      add(layout.endDatePropertyId);
    }
    for (const id of layout.additionalDatePropertyIds ?? []) {
      add(id);
    }
  }

  if (layout.type === "timeline") {
    add(layout.startDatePropertyId);
    add(layout.endDatePropertyId);
    if (layout.groupByPropertyId) {
      add(layout.groupByPropertyId);
    }
  }

  return ids;
};

const remapLayoutPropertyIds = (
  layout: ViewLayout,
  propertyIdBySourceId: ReadonlyMap<string, string>,
): void => {
  const remap = (id: string): string => propertyIdBySourceId.get(id) ?? id;

  layout.hiddenProperties = layout.hiddenProperties.map(remap);
  layout.sorts = layout.sorts.map((sort) => ({
    ...sort,
    propertyId: remap(sort.propertyId),
  }));
  layout.filters = layout.filters.map((node) =>
    remapNodePropertyIds(node, remap),
  );

  if (layout.type === "table") {
    layout.columnOrder = layout.columnOrder.map(remap);
    layout.columnPinning = layout.columnPinning.map(remap);
    if (layout.groupByPropertyId) {
      layout.groupByPropertyId = remap(layout.groupByPropertyId);
    }
  }

  if (layout.type === "kanban" && layout.groupByPropertyId) {
    layout.groupByPropertyId = remap(layout.groupByPropertyId);
  }

  if (layout.type === "calendar") {
    layout.datePropertyId = remap(layout.datePropertyId);
    if (layout.endDatePropertyId) {
      layout.endDatePropertyId = remap(layout.endDatePropertyId);
    }
    if (layout.additionalDatePropertyIds) {
      layout.additionalDatePropertyIds =
        layout.additionalDatePropertyIds.map(remap);
    }
  }

  if (layout.type === "timeline") {
    layout.startDatePropertyId = remap(layout.startDatePropertyId);
    layout.endDatePropertyId = remap(layout.endDatePropertyId);
    if (layout.groupByPropertyId) {
      layout.groupByPropertyId = remap(layout.groupByPropertyId);
    }
  }
};

const isInternalPropertyId = (id: string): boolean => id.startsWith("_");
