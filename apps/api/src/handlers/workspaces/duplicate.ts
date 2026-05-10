import { Result, panic } from "better-result";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { member } from "@/api/db/auth-schema";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import {
  entities,
  entityVersions,
  fields,
  matterCounters,
  properties,
  propertyDependencies,
  workspaceContacts,
  workspaceMembers,
  workspaces,
  workspaceViews,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { allocateEntityStamp } from "@/api/lib/document-counter";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { LIMITS } from "@/api/lib/limits";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  toReference,
  toScopeKey,
} from "@/api/lib/matter-reference";
import { getS3 } from "@/api/lib/s3";
import { processExtraction } from "@/api/lib/search/process-extraction";
import type { ViewLayout } from "@/api/lib/views-schema";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const config = {
  permissions: { workspace: ["create"] },
  body: t.Object({
    includeContent: t.Boolean(),
  }),
} satisfies HandlerConfig;

type FileCopy = {
  sourceFileId: string;
  targetFileId: string;
  mimeType: string;
};

const remapPropertyId = (
  propertyId: string,
  propertyIdMap: Map<string, SafeId<"property">>,
) => propertyIdMap.get(propertyId) ?? propertyId;

const remapLayout = (
  layout: ViewLayout,
  propertyIdMap: Map<string, SafeId<"property">>,
): ViewLayout => {
  const remapFilters = layout.filters.map((filter) => {
    if (filter.field !== "property") {
      return filter;
    }
    return {
      ...filter,
      propertyId: remapPropertyId(filter.propertyId, propertyIdMap),
    };
  });
  const remapSorts = layout.sorts.map((sort) => ({
    ...sort,
    propertyId: remapPropertyId(sort.propertyId, propertyIdMap),
  }));
  const base = {
    ...layout,
    filters: remapFilters,
    sorts: remapSorts,
    hiddenProperties: layout.hiddenProperties.map((id) =>
      remapPropertyId(id, propertyIdMap),
    ),
  };

  if (base.type === "table") {
    return {
      ...base,
      columnOrder: base.columnOrder.map((id) =>
        remapPropertyId(id, propertyIdMap),
      ),
      columnPinning: base.columnPinning.map((id) =>
        remapPropertyId(id, propertyIdMap),
      ),
    };
  }

  if (base.type === "kanban") {
    return {
      ...base,
      groupByPropertyId: base.groupByPropertyId
        ? remapPropertyId(base.groupByPropertyId, propertyIdMap)
        : undefined,
    };
  }

  if (base.type === "calendar") {
    return {
      ...base,
      datePropertyId: remapPropertyId(base.datePropertyId, propertyIdMap),
      endDatePropertyId: base.endDatePropertyId
        ? remapPropertyId(base.endDatePropertyId, propertyIdMap)
        : undefined,
      additionalDatePropertyIds: base.additionalDatePropertyIds?.map((id) =>
        remapPropertyId(id, propertyIdMap),
      ),
    };
  }

  if (base.type === "timeline") {
    return {
      ...base,
      startDatePropertyId: remapPropertyId(
        base.startDatePropertyId,
        propertyIdMap,
      ),
      endDatePropertyId: remapPropertyId(base.endDatePropertyId, propertyIdMap),
      groupByPropertyId: base.groupByPropertyId
        ? remapPropertyId(base.groupByPropertyId, propertyIdMap)
        : undefined,
    };
  }

  return base;
};

const collectFileCopies = (content: FieldContent): FileCopy[] => {
  if (content.type !== "file") {
    return [];
  }

  const copies: FileCopy[] = [
    {
      sourceFileId: content.id,
      targetFileId: Bun.randomUUIDv7(),
      mimeType: content.mimeType,
    },
  ];

  if (content.pdfFileId) {
    copies.push({
      sourceFileId: content.pdfFileId,
      targetFileId: Bun.randomUUIDv7(),
      mimeType: PDF_MIME_TYPE,
    });
  }

  return copies;
};

const collectUniqueFileCopies = (
  entitiesToCopy: {
    currentVersion?: { fields: { content: FieldContent }[] } | null;
  }[],
) => {
  const fileCopiesBySourceId = new Map<string, FileCopy>();

  for (const entity of entitiesToCopy) {
    for (const field of entity.currentVersion?.fields ?? []) {
      for (const copy of collectFileCopies(field.content)) {
        if (fileCopiesBySourceId.has(copy.sourceFileId)) {
          continue;
        }
        fileCopiesBySourceId.set(copy.sourceFileId, copy);
      }
    }
  }

  return [...fileCopiesBySourceId.values()];
};

const remapFieldContent = (
  content: FieldContent,
  fileIdMap: Map<string, string>,
): FieldContent => {
  if (content.type !== "file") {
    return content;
  }

  return {
    ...content,
    id: fileIdMap.get(content.id) ?? content.id,
    pdfFileId: content.pdfFileId
      ? (fileIdMap.get(content.pdfFileId) ?? content.pdfFileId)
      : null,
  };
};

const orderEntitiesForDuplicate = <
  TEntity extends { id: string; parentId: string | null },
>(
  entitiesToOrder: TEntity[],
) => {
  const entityIds = new Set(entitiesToOrder.map((entity) => entity.id));
  const childrenByParentId = new Map<string, TEntity[]>();
  const roots: TEntity[] = [];

  for (const entity of entitiesToOrder) {
    if (!entity.parentId || !entityIds.has(entity.parentId)) {
      roots.push(entity);
      continue;
    }

    const children = childrenByParentId.get(entity.parentId);
    if (children) {
      children.push(entity);
      continue;
    }
    childrenByParentId.set(entity.parentId, [entity]);
  }

  const ordered: TEntity[] = [];
  const visited = new Set<string>();
  const queue = [...roots];

  for (const entity of queue) {
    if (visited.has(entity.id)) {
      continue;
    }
    visited.add(entity.id);
    ordered.push(entity);
    queue.push(...(childrenByParentId.get(entity.id) ?? []));
  }

  for (const entity of entitiesToOrder) {
    if (!visited.has(entity.id)) {
      ordered.push(entity);
    }
  }

  return ordered;
};

const copyWorkspaceFile = async ({
  copy,
  organizationId,
  sourceWorkspaceId,
  targetWorkspaceId,
}: {
  copy: FileCopy;
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
}) => {
  const sourceKey = createFileKey({
    organizationId,
    workspaceId: sourceWorkspaceId,
    fileId: copy.sourceFileId,
    mimeType: copy.mimeType,
  });
  const targetKey = createFileKey({
    organizationId,
    workspaceId: targetWorkspaceId,
    fileId: copy.targetFileId,
    mimeType: copy.mimeType,
  });
  const bytes = await getS3().file(sourceKey).arrayBuffer();
  await getS3().write(targetKey, new Uint8Array(bytes));
  return targetKey;
};

const duplicateWorkspace = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    workspaceId: sourceWorkspaceId,
    request,
    server,
    body: { includeContent },
  }) {
    const organizationId = session.activeOrganizationId;
    const targetWorkspaceId = createSafeId<"workspace">();

    const snapshot = yield* Result.await(
      safeDb(async (tx) => {
        const workspace = await tx.query.workspaces.findFirst({
          where: { id: { eq: sourceWorkspaceId } },
          columns: {
            id: true,
            name: true,
            clientId: true,
            billingReference: true,
            color: true,
          },
        });

        if (!workspace) {
          return null;
        }

        const [
          workspaceProperties,
          dependencies,
          views,
          members,
          contacts,
          sourceEntities,
        ] = await Promise.all([
          tx.query.properties.findMany({
            where: { workspaceId: { eq: sourceWorkspaceId } },
            orderBy: { createdAt: "asc" },
          }),
          tx.query.propertyDependencies.findMany({
            where: { workspaceId: { eq: sourceWorkspaceId } },
          }),
          tx.query.workspaceViews.findMany({
            where: { workspaceId: { eq: sourceWorkspaceId } },
            orderBy: { position: "asc" },
          }),
          tx.query.workspaceMembers.findMany({
            where: { workspaceId: { eq: sourceWorkspaceId } },
            columns: { userId: true },
          }),
          tx.query.workspaceContacts.findMany({
            where: { workspaceId: { eq: sourceWorkspaceId } },
          }),
          includeContent
            ? tx.query.entities.findMany({
                where: { workspaceId: { eq: sourceWorkspaceId } },
                orderBy: { createdAt: "asc" },
                limit: LIMITS.entitiesCount + 1,
                with: {
                  currentVersion: {
                    columns: { id: true },
                    with: {
                      fields: {
                        columns: {
                          propertyId: true,
                          content: true,
                        },
                      },
                    },
                  },
                },
              })
            : Promise.resolve([]),
        ]);

        return {
          workspace,
          properties: workspaceProperties,
          dependencies,
          views,
          members,
          contacts,
          entities: sourceEntities,
        };
      }),
    );

    if (!snapshot) {
      return Result.err(
        new HandlerError({ status: 404, message: "Workspace not found" }),
      );
    }

    const fileCopies = collectUniqueFileCopies(snapshot.entities);
    const fileIdMap = new Map(
      fileCopies.map((copy) => [copy.sourceFileId, copy.targetFileId]),
    );
    const copiedS3Keys: string[] = [];

    if (includeContent) {
      const copyResult = await Result.tryPromise(async () => {
        for (const copy of fileCopies) {
          const key = await copyWorkspaceFile({
            copy,
            organizationId,
            sourceWorkspaceId,
            targetWorkspaceId,
          });
          copiedS3Keys.push(key);
        }
      });

      if (Result.isError(copyResult)) {
        await Result.tryPromise(async () => {
          await Promise.all(
            copiedS3Keys.map(async (key) => await getS3().delete(key)),
          );
        });
        return Result.err(
          new HandlerError({
            status: 500,
            message: "Failed to copy matter files",
            cause: copyResult.error,
          }),
        );
      }
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const [countResult, duplicatedNames, settings, orgMembers] =
          await Promise.all([
            tx
              .select({ total: count() })
              .from(workspaces)
              .where(eq(workspaces.organizationId, organizationId)),
            tx
              .select({ name: workspaces.name })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.organizationId, organizationId),
                  ilike(
                    workspaces.name,
                    `${escapeLike(snapshot.workspace.name)}%`,
                  ),
                ),
              ),
            tx.query.organizationSettings.findFirst({
              where: { organizationId: { eq: organizationId } },
              columns: {
                matterNumberPattern: true,
                matterNumberPadding: true,
              },
            }),
            snapshot.members.length > 0
              ? tx
                  .select({ userId: member.userId })
                  .from(member)
                  .where(
                    and(
                      eq(member.organizationId, organizationId),
                      inArray(
                        member.userId,
                        snapshot.members.map((m) => m.userId),
                      ),
                    ),
                  )
              : Promise.resolve([]),
          ]);

        const activeCount = countResult.at(0)?.total ?? 0;
        if (activeCount >= LIMITS.workspacesCount) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Workspaces limit reached",
          };
        }

        if (orgMembers.length !== snapshot.members.length) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Some users are not members of this organization",
          };
        }

        const newName =
          duplicatedNames.length > 0
            ? `${snapshot.workspace.name} (${duplicatedNames.length})`
            : snapshot.workspace.name;
        const pattern =
          settings?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN;
        const padding =
          settings?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING;
        const now = new Date();
        const scopeKey = toScopeKey(pattern, now);
        const counter = await tx
          .insert(matterCounters)
          .values({
            id: createSafeId<"matterCounter">(),
            organizationId,
            scopeKey,
            lastValue: 1,
          })
          .onConflictDoUpdate({
            target: [matterCounters.organizationId, matterCounters.scopeKey],
            set: { lastValue: sql`${matterCounters.lastValue} + 1` },
          })
          .returning({ lastValue: matterCounters.lastValue })
          .then((rows) => rows.at(0));

        if (!counter) {
          panic("Failed to create matter counter");
        }

        const reference = toReference({
          pattern,
          now,
          seq: counter.lastValue,
          padding,
        });

        await tx.insert(workspaces).values({
          id: targetWorkspaceId,
          organizationId,
          clientId: snapshot.workspace.clientId,
          billingReference: snapshot.workspace.billingReference,
          color: snapshot.workspace.color,
          name: newName,
          reference,
        });

        await tx.execute(
          sql`SELECT set_config(
            ${SETTING_WORKSPACE_IDS},
            array_append(
              current_setting(${SETTING_WORKSPACE_IDS}, true)::text[],
              ${targetWorkspaceId}
            )::text,
            true
          )`,
        );

        if (snapshot.members.length > 0) {
          await tx.insert(workspaceMembers).values(
            snapshot.members.map((workspaceMember) => ({
              workspaceId: targetWorkspaceId,
              userId: workspaceMember.userId,
            })),
          );
        }

        const propertyIdMap = new Map<string, SafeId<"property">>();
        if (snapshot.properties.length > 0) {
          const newProperties = snapshot.properties.map((property) => {
            const id = createSafeId<"property">();
            propertyIdMap.set(property.id, id);
            return {
              id,
              workspaceId: targetWorkspaceId,
              name: property.name,
              status: property.status,
              content: property.content,
              tool: property.tool,
              system: property.system,
              kinds: property.kinds,
            };
          });
          await tx.insert(properties).values(newProperties);
        }

        const newDependencies = snapshot.dependencies
          .map((dependency) => {
            const propertyId = propertyIdMap.get(dependency.propertyId);
            const dependsOnPropertyId = propertyIdMap.get(
              dependency.dependsOnPropertyId,
            );
            if (!propertyId || !dependsOnPropertyId) {
              return null;
            }
            return {
              id: createSafeId<"propertyDependency">(),
              workspaceId: targetWorkspaceId,
              propertyId,
              dependsOnPropertyId,
              condition: dependency.condition,
            };
          })
          .filter((dependency) => dependency !== null);
        if (newDependencies.length > 0) {
          await tx.insert(propertyDependencies).values(newDependencies);
        }

        if (snapshot.views.length > 0) {
          await tx.insert(workspaceViews).values(
            snapshot.views.map((view) => ({
              id: createSafeId<"workspaceView">(),
              workspaceId: targetWorkspaceId,
              name: view.name,
              layout: remapLayout(view.layout, propertyIdMap),
              position: view.position,
            })),
          );
        }

        if (snapshot.contacts.length > 0) {
          await tx.insert(workspaceContacts).values(
            snapshot.contacts.map((contact) => ({
              id: createSafeId<"workspaceContact">(),
              organizationId,
              workspaceId: targetWorkspaceId,
              contactId: contact.contactId,
              role: contact.role,
              isPrimary: contact.isPrimary,
              notes: contact.notes,
            })),
          );
        }

        const entityIdMap = new Map<string, SafeId<"entity">>();
        const duplicatedEntityIds: SafeId<"entity">[] = [];
        const entitiesToDuplicate = orderEntitiesForDuplicate(
          snapshot.entities,
        );

        if (includeContent && entitiesToDuplicate.length > 0) {
          if (entitiesToDuplicate.length > LIMITS.entitiesCount) {
            return {
              ok: false as const,
              status: 400 as const,
              message: "Entities limit reached",
            };
          }

          for (const source of entitiesToDuplicate) {
            if (!source.currentVersion) {
              return {
                ok: false as const,
                status: 400 as const,
                message: "Entity has no current version",
              };
            }

            const newEntityId = createSafeId<"entity">();
            const newVersionId = createSafeId<"entityVersion">();
            const entityStamp =
              source.kind === "document"
                ? await allocateEntityStamp(tx, targetWorkspaceId)
                : null;
            const newParentId = source.parentId
              ? (entityIdMap.get(source.parentId) ?? null)
              : null;

            await tx.insert(entities).values({
              id: newEntityId,
              workspaceId: targetWorkspaceId,
              kind: source.kind,
              parentId: newParentId,
              name: source.name,
              createdBy: user.id,
              lastEditedBy: source.lastEditedBy,
              docSequence: entityStamp?.docSequence ?? null,
              status: source.status,
              priority: source.priority,
              dueDate: source.dueDate,
              agendaKind: source.agendaKind,
              startAt: source.startAt,
              endAt: source.endAt,
              occurredAt: source.occurredAt,
              remindAt: source.remindAt,
              allDay: source.allDay,
              timeZone: source.timeZone,
              location: source.location,
              onlineMeetingUrl: source.onlineMeetingUrl,
              availability: source.availability,
              sensitivity: source.sensitivity,
              organizer: source.organizer,
              attendees: source.attendees,
              recurrence: source.recurrence,
              agendaSource: source.agendaSource,
              externalSource: null,
              externalId: null,
              externalChangeKey: null,
              externalICalUid: null,
              externalData: null,
              readOnly: false,
              sortOrder: source.sortOrder,
              metadata: source.metadata,
            });

            await tx.insert(entityVersions).values({
              id: newVersionId,
              workspaceId: targetWorkspaceId,
              entityId: newEntityId,
              versionNumber: 1,
              stamp: entityStamp?.stamp ?? null,
              verificationCode: entityStamp?.verificationCode ?? null,
              createdBy: user.id,
            });

            await tx
              .update(entities)
              .set({ currentVersionId: newVersionId })
              .where(eq(entities.id, newEntityId));

            const newFields = source.currentVersion.fields.flatMap((field) => {
              const propertyId = propertyIdMap.get(field.propertyId);
              if (!propertyId) {
                return [];
              }
              return [
                {
                  workspaceId: targetWorkspaceId,
                  propertyId,
                  entityVersionId: newVersionId,
                  content: remapFieldContent(field.content, fileIdMap),
                },
              ];
            });
            if (newFields.length > 0) {
              await tx.insert(fields).values(newFields);
            }

            entityIdMap.set(source.id, newEntityId);
            duplicatedEntityIds.push(newEntityId);
          }
        }

        await writeAuditLog(
          {
            ...createAuditContext({
              organizationId,
              workspaceId: targetWorkspaceId,
              userId: user.id,
              request,
              server,
            }),
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: targetWorkspaceId,
            changes: {
              created: {
                old: { sourceWorkspaceId, includeContent },
                new: { name: newName, reference },
              },
            },
          },
          tx,
        );

        return {
          ok: true as const,
          workspaceId: targetWorkspaceId,
          entityIds: duplicatedEntityIds,
        };
      }),
    );

    if (!txResult.ok) {
      await Result.tryPromise(async () => {
        await Promise.all(
          copiedS3Keys.map(async (key) => await getS3().delete(key)),
        );
      });
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    for (const entityId of txResult.entityIds) {
      processExtraction(entityId).catch(captureError);
    }

    return Result.ok({ workspaceId: txResult.workspaceId });
  },
);

export default duplicateWorkspace;
