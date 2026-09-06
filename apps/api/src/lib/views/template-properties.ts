import { deepEquals } from "bun";
import { eq } from "drizzle-orm";

import type { ConditionNode } from "@stll/conditions";

import type { Transaction } from "@/api/db/root";
import { properties, propertyDependencies } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  collectNodePropertyIds,
  remapDependencyRefs,
  remapNodePropertyIds,
} from "@/api/lib/conditions/ast-utils";
import { parseStoredCondition } from "@/api/lib/conditions/parse-stored";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";
import {
  assertPropertyDependencyReadWithinLimit,
  propertyDependencyReadLimit,
} from "@/api/lib/properties/dependency-limits";
import { propertyKindsForTool } from "@/api/lib/properties/property-kinds";
import { lockWorkspacePropertyWrites } from "@/api/lib/properties/property-lock";
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

type ResolveTemplatePropertiesResult = {
  layout: ViewLayout;
  propertyIds: string[];
};

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
    const parsed = parseStoredCondition(dep.condition, dep.dependsOnPropertyId);
    if (parsed.status === "invalid") {
      continue;
    }
    const storedDependencies = dependenciesByPropertyId.get(dep.propertyId);
    const list = arrayOrEmpty(storedDependencies);
    list.push({
      dependsOnSourceId: dep.dependsOnPropertyId,
      condition: parsed.condition,
    });
    dependenciesByPropertyId.set(dep.propertyId, list);
  }
  const creatablePropertyIds = new Set([
    ...referencedPropertyIds,
    ...visiblePropertyIds,
  ]);
  addDependencySourceIds(creatablePropertyIds, dependenciesByPropertyId);
  const hiddenPropertyIds = new Set(layout.hiddenProperties);

  const templateProperties: ViewTemplateProperty[] = [];
  for (const property of workspaceProperties) {
    if (property.system) {
      continue;
    }
    if (
      !creatablePropertyIds.has(property.id) &&
      !hiddenPropertyIds.has(property.id)
    ) {
      continue;
    }
    const propertyDeps = dependenciesByPropertyId.get(property.id);
    const templateProperty: ViewTemplateProperty = {
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
      role: resolveTemplateExportRole(property, workspaceProperties),
      createIfMissing: creatablePropertyIds.has(property.id),
    };
    if (propertyDeps && propertyDeps.length > 0) {
      templateProperty.dependencies = propertyDeps;
    }
    templateProperties.push(templateProperty);
  }
  return templateProperties;
};

const resolveTemplateExportRole = (
  property: WorkspacePropertyTemplateSource,
  workspaceProperties: readonly WorkspacePropertyTemplateSource[],
): typeof properties.$inferSelect.role => {
  if (property.role !== null) {
    return property.role;
  }

  if (!isLegacyDocumentTypeClassifierProperty(property)) {
    return null;
  }

  const taggedClassifierExists = workspaceProperties.some(
    (candidate) =>
      candidate.role === DOCUMENT_TYPE_CLASSIFIER_ROLE &&
      isDocumentTypeClassifierShape(candidate),
  );
  if (taggedClassifierExists) {
    return null;
  }

  const legacyClassifiers = workspaceProperties.filter(
    isLegacyDocumentTypeClassifierProperty,
  );
  return legacyClassifiers.length === 1 ? DOCUMENT_TYPE_CLASSIFIER_ROLE : null;
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
    const storedDependencies = dependenciesByPropertyId.get(propertyId);
    const dependencies = arrayOrEmpty(storedDependencies);
    for (const dependency of dependencies) {
      if (creatablePropertyIds.has(dependency.dependsOnSourceId)) {
        continue;
      }
      creatablePropertyIds.add(dependency.dependsOnSourceId);
      queue.push(dependency.dependsOnSourceId);
    }
  }
};

/**
 * Resolve a view's template columns against the workspace, creating the columns
 * the template asks for that do not exist yet.
 *
 * Every rejection throws a `HandlerError` rather than returning one. This runs
 * inside its caller's transaction, and returning from a transaction callback
 * commits whatever it has already written: a rejection raised part-way through
 * the creation loop would persist the columns, dependency rows, and audit
 * events written so far while the handler answered an error. Throwing aborts
 * the transaction, and callers recover the error with `transactionAbortError`
 * so the response is unchanged.
 */
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
      layout,
      propertyIds: existing.map((property) => property.id),
    };
  }

  const roleResolution = getTemplateRoleResolution(templateProperties);
  assertTemplatePropertiesValid(templateProperties, roleResolution);

  await lockWorkspacePropertyWrites(tx, workspaceId);

  const existingProperties = await readExistingProperties(tx, workspaceId);
  const systemFileProperty = findSystemFileProperty(existingProperties);
  const existingDependencyEdges = await tx
    .selectDistinct({ propertyId: propertyDependencies.propertyId })
    .from(propertyDependencies)
    .where(eq(propertyDependencies.workspaceId, workspaceId))
    .limit(propertyDependencyReadLimit("ownersPerWorkspace"));
  assertPropertyDependencyReadWithinLimit(
    existingDependencyEdges.length,
    "ownersPerWorkspace",
  );
  const propertyIdsWithDependencies = new Set(
    existingDependencyEdges.map((edge) => edge.propertyId),
  );
  const nextPropertyIds = existingProperties.map((property) => property.id);
  // Keyed as plain string: lookups use templateProperty.sourceId, which is
  // unbranded (the original .find compared the branded id against it).
  const existingPropertyById = new Map<
    string,
    (typeof existingProperties)[number]
  >(existingProperties.map((property) => [property.id, property]));
  const propertyIdBySourceId = new Map<string, string>();
  const createdPropertySourceIds = new Set<string>();
  const consumedExistingPropertyIds = new Set<string>();
  const templatePropertiesToCreate: ViewTemplateProperty[] = [];
  let projectedPropertyCount = nextPropertyIds.length;

  for (const templateProperty of templateProperties) {
    const existingById = existingPropertyById.get(templateProperty.sourceId);
    if (
      existingById &&
      canReusePropertyByExactId({
        property: existingById,
        templateProperty,
        roleResolution,
      })
    ) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingById.id);
      consumedExistingPropertyIds.add(existingById.id);
      continue;
    }

    const existingByRole = findUniquePropertyByRole({
      existingProperties,
      templateProperty,
      consumedExistingPropertyIds,
      roleResolution,
    });
    if (existingByRole) {
      propertyIdBySourceId.set(templateProperty.sourceId, existingByRole.id);
      consumedExistingPropertyIds.add(existingByRole.id);
      continue;
    }

    if (
      hasMalformedPropertyByRole({
        existingProperties,
        templateProperty,
        consumedExistingPropertyIds,
        roleResolution,
      })
    ) {
      throw new HandlerError({
        status: 422,
        message:
          "Document type classifier role is attached to an incompatible column",
      });
    }

    const existingByShape = findUniquePropertyByShape(
      existingProperties,
      templateProperty,
      consumedExistingPropertyIds,
      propertyIdsWithDependencies,
      roleResolution,
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
      throw new HandlerError({
        status: 403,
        message: "Missing permission to create template columns",
      });
    }

    if (projectedPropertyCount >= LIMITS.propertiesCount) {
      throw new HandlerError({
        status: 400,
        message: "Properties limit reached",
      });
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
    throw new HandlerError({
      status: 422,
      message: "Circular template dependency detected",
    });
  }

  const auditEvents: AuditEvent[] = [];
  const propertyRows: (typeof properties.$inferInsert)[] = [];

  // Ids are minted here rather than read back from `returning`: the source-id
  // mapping and the audit rows then need nothing from the database, so the
  // whole set of new columns goes in as one statement. Column order still
  // comes from `templatePropertiesToCreate`, which is what `nextPropertyIds`
  // records.
  for (const templateProperty of templatePropertiesToCreate) {
    const propertyId = createSafeId<"property">();

    propertyRows.push({
      id: propertyId,
      workspaceId,
      name: templateProperty.name,
      content: templateProperty.content,
      tool: sanitizeTemplatePropertyTool(templateProperty.tool),
      kinds: propertyKindsForTool(templateProperty.tool),
      role: resolveTemplatePropertyRole(templateProperty, roleResolution),
      status: templateProperty.tool.type === "ai-model" ? "stale" : "fresh",
    });

    propertyIdBySourceId.set(templateProperty.sourceId, propertyId);
    nextPropertyIds.push(propertyId);

    auditEvents.push({
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.PROPERTY,
      resourceId: propertyId,
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

  if (propertyRows.length > 0) {
    await tx.insert(properties).values(propertyRows);
  }

  // The audit rows carry the same order and go in as one statement.
  if (auditEvents.length > 0) {
    await recordAuditEvent(tx, auditEvents);
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

  return { layout, propertyIds: nextPropertyIds };
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

    const templateDependencies = templateProperty.dependencies;
    const resolvedEdges = arrayOrEmpty(templateDependencies).flatMap((dep) => {
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
    });

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
    const storedDependencyIds = graph.get(sourceId);
    const dependencyIds = arrayOrEmpty(storedDependencyIds);
    for (const dependencySourceId of dependencyIds) {
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

// Throws on the first invalid template column. Runs before any write, but
// throws for the same reason the rest of the resolver does: one rejection form
// for one caller contract.
const assertTemplatePropertiesValid = (
  templateProperties: readonly ViewTemplateProperty[],
  roleResolution: TemplateRoleResolution,
): void => {
  const sourceIds = new Set<string>();
  const roles = new Set<NonNullable<typeof properties.$inferSelect.role>>();

  for (const templateProperty of templateProperties) {
    if (sourceIds.has(templateProperty.sourceId)) {
      throw new HandlerError({
        status: 422,
        message: "Duplicate template property sourceId",
      });
    }
    sourceIds.add(templateProperty.sourceId);

    assertTemplatePropertyConfigValid(templateProperty, roleResolution);

    const role = resolveTemplatePropertyRole(templateProperty, roleResolution);
    if (role) {
      if (roles.has(role)) {
        throw new HandlerError({
          status: 422,
          message: "Duplicate template property role",
        });
      }
      roles.add(role);
    }
  }
};

const DOCUMENT_TYPE_CLASSIFIER_ROLE = "document-type-classifier";

type TemplateRoleResolution = {
  inferLegacyDocumentTypeRole: boolean;
};

const getTemplateRoleResolution = (
  templateProperties: readonly ViewTemplateProperty[],
): TemplateRoleResolution => ({
  inferLegacyDocumentTypeRole: !templateProperties.some(
    hasTemplatePropertyRole,
  ),
});

type DocumentTypeClassifierShape = {
  content: typeof properties.$inferSelect.content;
  tool: typeof properties.$inferSelect.tool;
};

const isDocumentTypeClassifierShape = ({
  content,
  tool,
}: DocumentTypeClassifierShape): boolean =>
  content.type === "single-select" && tool.type === "ai-model";

const assertTemplatePropertyConfigValid = (
  templateProperty: ViewTemplateProperty,
  roleResolution: TemplateRoleResolution,
): void => {
  if (
    resolveTemplatePropertyRole(templateProperty, roleResolution) &&
    !isDocumentTypeClassifierShape(templateProperty)
  ) {
    throw new HandlerError({
      status: 422,
      message:
        "Document type classifier templates must be AI single-select columns",
    });
  }

  if (
    templateProperty.content.type === "file" &&
    templateProperty.tool.type !== "manual-input"
  ) {
    throw new HandlerError({
      status: 422,
      message: "File template columns must use manual input",
    });
  }

  if (
    templateProperty.tool.type !== "ai-model" &&
    templateProperty.dependencies &&
    templateProperty.dependencies.length > 0
  ) {
    throw new HandlerError({
      status: 422,
      message: "Only AI template columns can declare dependencies",
    });
  }

  if (
    templateProperty.content.type !== "single-select" &&
    templateProperty.content.type !== "multi-select"
  ) {
    return;
  }

  const fallback = templateProperty.content.fallback;
  if (
    fallback !== null &&
    !templateProperty.content.options.some(
      (option) => option.value === fallback,
    )
  ) {
    throw new HandlerError({
      status: 400,
      message: "Fallback must match one of the supplied options",
    });
  }
};

const normalizePropertyName = (name: string): string =>
  name.trim().toLocaleLowerCase();

const hasTemplatePropertyRole = (
  templateProperty: ViewTemplateProperty,
): boolean => Object.hasOwn(templateProperty, "role");

const isLegacyDocumentTypeClassifierTemplate = (
  templateProperty: ViewTemplateProperty,
  { inferLegacyDocumentTypeRole }: TemplateRoleResolution,
): boolean =>
  inferLegacyDocumentTypeRole &&
  !hasTemplatePropertyRole(templateProperty) &&
  normalizePropertyName(templateProperty.name) === "document type" &&
  isDocumentTypeClassifierShape(templateProperty);

const resolveTemplatePropertyRole = (
  templateProperty: ViewTemplateProperty,
  roleResolution: TemplateRoleResolution,
): typeof properties.$inferSelect.role =>
  isLegacyDocumentTypeClassifierTemplate(templateProperty, roleResolution)
    ? DOCUMENT_TYPE_CLASSIFIER_ROLE
    : (templateProperty.role ?? null);

type PropertyRoleMatchCandidate = {
  id: string;
  name: string;
  content: typeof properties.$inferSelect.content;
  tool: typeof properties.$inferSelect.tool;
  role: typeof properties.$inferSelect.role;
};

type PropertyRoleMatchArgs = {
  existingProperties: readonly PropertyRoleMatchCandidate[];
  templateProperty: ViewTemplateProperty;
  consumedExistingPropertyIds: ReadonlySet<string>;
  roleResolution: TemplateRoleResolution;
};

const findUniquePropertyByRole = ({
  existingProperties,
  templateProperty,
  consumedExistingPropertyIds,
  roleResolution,
}: PropertyRoleMatchArgs) => {
  const role = resolveTemplatePropertyRole(templateProperty, roleResolution);

  if (!role) {
    return undefined;
  }

  const tagged = existingProperties.find(
    (property) =>
      !consumedExistingPropertyIds.has(property.id) &&
      property.role === role &&
      isDocumentTypeClassifierShape(property),
  );
  if (tagged) {
    return tagged;
  }

  const legacyMatches = existingProperties.filter(
    (property) =>
      !consumedExistingPropertyIds.has(property.id) &&
      isLegacyDocumentTypeClassifierProperty(property),
  );
  return legacyMatches.length === 1 ? legacyMatches[0] : undefined;
};

const isLegacyDocumentTypeClassifierProperty = (
  property: PropertyRoleMatchCandidate,
): boolean =>
  property.role === null &&
  normalizePropertyName(property.name) === "document type" &&
  isDocumentTypeClassifierShape(property);

const hasMalformedPropertyByRole = ({
  existingProperties,
  templateProperty,
  consumedExistingPropertyIds,
  roleResolution,
}: PropertyRoleMatchArgs): boolean => {
  const role = resolveTemplatePropertyRole(templateProperty, roleResolution);
  if (!role) {
    return false;
  }

  return existingProperties.some(
    (property) =>
      !consumedExistingPropertyIds.has(property.id) &&
      isMalformedPropertyByRole(property, role),
  );
};

const isMalformedPropertyByRole = (
  property: PropertyRoleMatchCandidate,
  role: typeof properties.$inferSelect.role,
): boolean => {
  if (!role) {
    return false;
  }

  return property.role === role && !isDocumentTypeClassifierShape(property);
};

const canReusePropertyByExactId = ({
  property,
  templateProperty,
  roleResolution,
}: {
  property: PropertyRoleMatchCandidate;
  templateProperty: ViewTemplateProperty;
  roleResolution: TemplateRoleResolution;
}): boolean => {
  const role = resolveTemplatePropertyRole(templateProperty, roleResolution);
  if (!role) {
    return true;
  }

  if (property.role === role && isDocumentTypeClassifierShape(property)) {
    return true;
  }

  return (
    isLegacyDocumentTypeClassifierTemplate(templateProperty, roleResolution) &&
    isLegacyDocumentTypeClassifierProperty(property)
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
  roleResolution: TemplateRoleResolution,
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
      propertyMatchesResolvedRole({
        property,
        templateProperty,
        roleResolution,
      }) &&
      hasSamePropertyConfig(property, templateProperty) &&
      !(
        templateHasDependencies || propertyIdsWithDependencies.has(property.id)
      ),
  );

  return matches.length === 1 ? matches[0] : undefined;
};

const propertyMatchesResolvedRole = ({
  property,
  templateProperty,
  roleResolution,
}: {
  property: PropertyRoleMatchCandidate;
  templateProperty: ViewTemplateProperty;
  roleResolution: TemplateRoleResolution;
}): boolean => {
  const role = resolveTemplatePropertyRole(templateProperty, roleResolution);
  if (property.role === role) {
    return true;
  }

  return (
    role === DOCUMENT_TYPE_CLASSIFIER_ROLE &&
    isLegacyDocumentTypeClassifierTemplate(templateProperty, roleResolution) &&
    isLegacyDocumentTypeClassifierProperty(property)
  );
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
  const hiddenPropertyIds = new Set(layout.hiddenProperties);
  const ids = new Set<string>();

  for (const property of workspaceProperties) {
    if (!hiddenPropertyIds.has(property.id)) {
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

  if (layout.type === "kanban") {
    if (layout.groupByPropertyId) {
      add(layout.groupByPropertyId);
    }
    if (layout.subgroupByPropertyId) {
      add(layout.subgroupByPropertyId);
    }
  }

  if (layout.type === "calendar") {
    add(layout.datePropertyId);
    if (layout.endDatePropertyId) {
      add(layout.endDatePropertyId);
    }
    const additionalDatePropertyIds = layout.additionalDatePropertyIds;
    for (const id of arrayOrEmpty(additionalDatePropertyIds)) {
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

  if (layout.type === "kanban") {
    if (layout.groupByPropertyId) {
      layout.groupByPropertyId = remap(layout.groupByPropertyId);
    }
    if (layout.subgroupByPropertyId) {
      layout.subgroupByPropertyId = remap(layout.subgroupByPropertyId);
    }
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
