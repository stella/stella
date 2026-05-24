import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { properties, propertyDependencies } from "@/api/db/schema";
import type { PropertyCondition } from "@/api/db/schema-validators";
import type { AuditContext } from "@/api/lib/audit-log";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedPropertyId } from "@/api/lib/safe-id-boundaries";
import type {
  ViewFilterCondition,
  ViewLayout,
  ViewTemplateProperty,
} from "@/api/lib/views-schema";

type WorkspacePropertyTemplateSource = {
  id: string;
  name: string;
  content: typeof properties.$inferSelect.content;
  tool: typeof properties.$inferSelect.tool;
  system: boolean;
};

type WorkspacePropertyDependencySource = {
  propertyId: string;
  dependsOnPropertyId: string;
  condition: PropertyCondition | null;
};

type ResolveTemplatePropertiesOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  layout: ViewLayout;
  templateProperties: readonly ViewTemplateProperty[] | undefined;
  canCreateProperties: boolean;
  auditContext?: AuditContext;
};

type ResolveTemplatePropertiesResult =
  | { ok: true; layout: ViewLayout; propertyIds: string[] }
  | { ok: false; status: 400 | 403; message: string };

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
  const creatablePropertyIds = new Set([
    ...referencedPropertyIds,
    ...visiblePropertyIds,
  ]);

  const dependenciesByPropertyId = new Map<
    string,
    { dependsOnSourceId: string; condition: PropertyCondition | null }[]
  >();
  for (const dep of dependencies) {
    const list = dependenciesByPropertyId.get(dep.propertyId) ?? [];
    list.push({
      dependsOnSourceId: dep.dependsOnPropertyId,
      condition: dep.condition,
    });
    dependenciesByPropertyId.set(dep.propertyId, list);
  }

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
        tool: property.tool,
        createIfMissing: creatablePropertyIds.has(property.id),
      };
      if (propertyDeps && propertyDeps.length > 0) {
        result.dependencies = propertyDeps;
      }
      return result;
    });
};

export const resolveTemplateProperties = async ({
  tx,
  workspaceId,
  layout,
  templateProperties,
  canCreateProperties,
  auditContext,
}: ResolveTemplatePropertiesOptions): Promise<ResolveTemplatePropertiesResult> => {
  if (!templateProperties || templateProperties.length === 0) {
    const propertyIds = await readPropertyIds(tx, workspaceId);
    return { ok: true, layout, propertyIds };
  }

  // Lock all existing property rows in this workspace before the
  // limit check and any inserts. Without this, two concurrent
  // template-apply requests can both pass the count guard and exceed
  // LIMITS.propertiesCount. Matches the pattern in
  // handlers/properties/create.ts.
  await tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.workspaceId, workspaceId))
    .for("update");

  const existingProperties = await tx.query.properties.findMany({
    where: { workspaceId: { eq: workspaceId } },
    columns: {
      id: true,
      name: true,
      content: true,
      tool: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const nextPropertyIds = existingProperties.map((property) => property.id);
  const propertyIdBySourceId = new Map<string, string>();

  for (const templateProperty of templateProperties) {
    const existingById = existingProperties.find(
      (property) => property.id === templateProperty.sourceId,
    );
    if (existingById) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingById.id);
      continue;
    }

    const existingByShape = existingProperties.find(
      (property) =>
        normalizePropertyName(property.name) ===
          normalizePropertyName(templateProperty.name) &&
        property.content.type === templateProperty.content.type &&
        property.tool.type === templateProperty.tool.type,
    );
    if (existingByShape) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingByShape.id);
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

    if (nextPropertyIds.length >= LIMITS.propertiesCount) {
      return {
        ok: false,
        status: 400,
        message: "Properties limit reached",
      };
    }

    const [inserted] = await tx
      .insert(properties)
      .values({
        workspaceId,
        name: templateProperty.name,
        content: templateProperty.content,
        tool: templateProperty.tool,
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

    if (auditContext) {
      await writeAuditLog(
        {
          ...auditContext,
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
        },
        tx,
      );
    }
  }

  await recreateTemplateDependencies({
    tx,
    workspaceId,
    templateProperties,
    propertyIdBySourceId,
  });

  remapLayoutPropertyIds(layout, propertyIdBySourceId);
  return { ok: true, layout, propertyIds: nextPropertyIds };
};

const recreateTemplateDependencies = async ({
  tx,
  workspaceId,
  templateProperties,
  propertyIdBySourceId,
}: {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  templateProperties: readonly ViewTemplateProperty[];
  propertyIdBySourceId: ReadonlyMap<string, string>;
}): Promise<void> => {
  const rows = templateProperties.flatMap((templateProperty) => {
    const propertyId = propertyIdBySourceId.get(templateProperty.sourceId);
    if (!propertyId || !templateProperty.dependencies) {
      return [];
    }
    return templateProperty.dependencies.flatMap((dep) => {
      const dependsOnPropertyId = propertyIdBySourceId.get(
        dep.dependsOnSourceId,
      );
      // Drop edges where either endpoint failed to remap; the
      // missing-property branch above already declined to create
      // them, so the workflow planner will treat the property as
      // having no inputs rather than crashing.
      if (!dependsOnPropertyId || dependsOnPropertyId === propertyId) {
        return [];
      }
      return [
        {
          workspaceId,
          propertyId: brandPersistedPropertyId(propertyId),
          dependsOnPropertyId: brandPersistedPropertyId(dependsOnPropertyId),
          condition: dep.condition,
        },
      ];
    });
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
};

const readPropertyIds = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
): Promise<string[]> => {
  const rows = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.workspaceId, workspaceId));
  return rows.map((row) => row.id);
};

const normalizePropertyName = (name: string): string =>
  name.trim().toLocaleLowerCase();

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

  for (const filter of layout.filters) {
    if (filter.field === "property") {
      add(filter.propertyId);
    }
  }

  if (layout.type === "table") {
    for (const id of layout.columnOrder) {
      add(id);
    }
    for (const id of layout.columnPinning) {
      add(id);
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
  layout.filters = layout.filters.map((filter): ViewFilterCondition => {
    if (filter.field !== "property") {
      return filter;
    }

    return {
      ...filter,
      propertyId: remap(filter.propertyId),
    };
  });

  if (layout.type === "table") {
    layout.columnOrder = layout.columnOrder.map(remap);
    layout.columnPinning = layout.columnPinning.map(remap);
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
