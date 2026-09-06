import { panic, Result } from "better-result";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import { t } from "elysia";

import { member } from "@/api/db/auth-schema";
import { SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import { transactionAbortError } from "@/api/db/safe-db";
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
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  remapDependencyRefs,
  remapNodePropertyIds,
} from "@/api/lib/conditions/ast-utils";
import { allocateEntityStamps } from "@/api/lib/document-counter";
import { enqueueDocumentProcessingRun } from "@/api/lib/document-processing-enqueue";
import { handoffCommittedDocumentProcessingRuns } from "@/api/lib/document-processing-handoff";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { THUMBNAIL_MIME_TYPE } from "@/api/lib/files/image-derivative";
import { createFileKey } from "@/api/lib/files/utils";
import { LIMITS } from "@/api/lib/limits";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  toReference,
  toScopeKey,
} from "@/api/lib/matter-reference";
import {
  assertPropertyDependencyReadWithinLimit,
  propertyDependencyReadLimit,
} from "@/api/lib/properties/dependency-limits";
import { getS3 } from "@/api/lib/s3";
import { copyObject } from "@/api/lib/s3-presign";
import {
  nativeExtractionRunRequestForFields,
  requestNativeExtractionRuns,
  SEARCH_INDEX_OWNER,
} from "@/api/lib/search/process-extraction";
import type {
  NativeExtractionRunRequest,
  SearchIndexOwner,
} from "@/api/lib/search/process-extraction";
import {
  enqueueEntitySearchRepairs,
  enqueueWorkspaceSearchRepairs,
  flushEntitySearchRepairs,
  flushWorkspaceSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import type { ViewLayout } from "@/api/lib/views-schema";
import { parseStoredViewLayout } from "@/api/lib/views-schema";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const config = {
  description:
    "Copy a matter into a new one: its columns with their dependencies, " +
    "views, members, party contacts, client, billing reference, colour, and " +
    "lead. With includeContent true its documents, folders, tasks, and their " +
    "stored files are copied as well; with false the new matter starts " +
    "empty. The copy takes the organization's next matter number and its " +
    "name gains a numeric suffix when earlier copies exist. Refused once the " +
    "organization is at its matter limit.",
  permissions: { workspace: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: t.Object({
    includeContent: t.Boolean(),
  }),
} satisfies HandlerConfig;

const FILE_COPY_CONCURRENCY = 4;

export type DuplicateWorkspaceDependencies = {
  enqueueDocumentProcessingRun: typeof enqueueDocumentProcessingRun;
  enqueueEntitySearchRepairs: typeof enqueueEntitySearchRepairs;
  enqueueWorkspaceSearchRepairs: typeof enqueueWorkspaceSearchRepairs;
  flushEntitySearchRepairs: typeof flushEntitySearchRepairs;
  flushWorkspaceSearchRepairs: typeof flushWorkspaceSearchRepairs;
  requestNativeExtractionRuns: typeof requestNativeExtractionRuns;
};

const defaultDuplicateWorkspaceDependencies = {
  enqueueDocumentProcessingRun,
  enqueueEntitySearchRepairs,
  enqueueWorkspaceSearchRepairs,
  flushEntitySearchRepairs,
  flushWorkspaceSearchRepairs,
  requestNativeExtractionRuns: async (options) =>
    await requestNativeExtractionRuns(options),
} satisfies DuplicateWorkspaceDependencies;

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
  storedLayout: unknown,
  propertyIdMap: Map<string, SafeId<"property">>,
): ViewLayout => {
  const layout = parseStoredViewLayout(storedLayout);
  const remapFilters = layout.filters.map((node) =>
    remapNodePropertyIds(node, (id) => remapPropertyId(id, propertyIdMap)),
  );
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
      // A grouped table carries a groupByPropertyId; remap it like kanban so a
      // duplicated grouped table doesn't point at the source workspace's
      // property. Built-in groupings (_kind, _status) aren't in the map and pass
      // through unchanged.
      groupByPropertyId: base.groupByPropertyId
        ? remapPropertyId(base.groupByPropertyId, propertyIdMap)
        : undefined,
    };
  }

  if (base.type === "kanban") {
    return {
      ...base,
      groupByPropertyId: base.groupByPropertyId
        ? remapPropertyId(base.groupByPropertyId, propertyIdMap)
        : undefined,
      subgroupByPropertyId: base.subgroupByPropertyId
        ? remapPropertyId(base.subgroupByPropertyId, propertyIdMap)
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

  if (content.thumbnailFileId) {
    copies.push({
      sourceFileId: content.thumbnailFileId,
      targetFileId: Bun.randomUUIDv7(),
      mimeType: THUMBNAIL_MIME_TYPE,
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
    const currentVersion =
      entity.currentVersion ?? panic("Entity is missing its current version");
    for (const field of currentVersion.fields) {
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
    thumbnailFileId: content.thumbnailFileId
      ? (fileIdMap.get(content.thumbnailFileId) ?? content.thumbnailFileId)
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
    const children = childrenByParentId.get(entity.id);
    if (children) {
      queue.push(...children);
    }
  }

  for (const entity of entitiesToOrder) {
    if (!visited.has(entity.id)) {
      ordered.push(entity);
    }
  }

  return ordered;
};

const copyWorkspaceFile = async ({
  copiedS3Keys,
  copy,
  organizationId,
  sourceWorkspaceId,
  targetWorkspaceId,
}: {
  copiedS3Keys: string[];
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
  // Reserve the deterministic destination before starting the copy. A timed-out
  // request may still have completed in S3, so rollback must delete this key even
  // when the client never observes a successful response.
  copiedS3Keys.push(targetKey);
  const copied = await copyObject(sourceKey, targetKey);
  if (Result.isError(copied)) {
    throw copied.error;
  }
};

const copyWorkspaceFiles = async ({
  copiedS3Keys,
  copies,
  organizationId,
  sourceWorkspaceId,
  targetWorkspaceId,
}: {
  copiedS3Keys: string[];
  copies: FileCopy[];
  organizationId: SafeId<"organization">;
  sourceWorkspaceId: SafeId<"workspace">;
  targetWorkspaceId: SafeId<"workspace">;
}) => {
  let nextIndex = 0;

  const copyNext = async () => {
    while (nextIndex < copies.length) {
      const copy = copies[nextIndex];
      nextIndex++;
      if (!copy) {
        return;
      }

      await copyWorkspaceFile({
        copiedS3Keys,
        copy,
        organizationId,
        sourceWorkspaceId,
        targetWorkspaceId,
      });
    }
  };

  const copyResults = await Promise.allSettled(
    Array.from(
      { length: Math.min(FILE_COPY_CONCURRENCY, copies.length) },
      copyNext,
    ),
  );
  const failedCopy = copyResults.find((result) => result.status === "rejected");

  if (failedCopy) {
    throw failedCopy.reason;
  }
};

const cleanupCopiedS3Keys = async ({
  copiedS3Keys,
  targetWorkspaceId,
}: {
  copiedS3Keys: string[];
  targetWorkspaceId: SafeId<"workspace">;
}) => {
  if (copiedS3Keys.length === 0) {
    return;
  }

  const cleanupResult = await Result.tryPromise(async () => {
    await Promise.all(
      copiedS3Keys.map(async (key) => await getS3().delete(key)),
    );
  });

  if (Result.isError(cleanupResult)) {
    captureError(cleanupResult.error, { targetWorkspaceId });
  }
};

export const createDuplicateWorkspace = (
  dependencies: DuplicateWorkspaceDependencies = defaultDuplicateWorkspaceDependencies,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      session,
      user,
      workspaceId: sourceWorkspaceId,
      body: { includeContent },
      recordAuditEvent,
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
              leadUserId: true,
            },
          });

          if (!workspace) {
            return null;
          }

          const [
            workspaceProperties,
            propertyDependencyRows,
            views,
            members,
            contacts,
            sourceEntities,
          ] = await Promise.all([
            tx.query.properties.findMany({
              where: { workspaceId: { eq: sourceWorkspaceId } },
              orderBy: { createdAt: "asc" },
              limit: LIMITS.propertiesCount,
            }),
            tx.query.propertyDependencies.findMany({
              where: { workspaceId: { eq: sourceWorkspaceId } },
              limit: propertyDependencyReadLimit("perWorkspace"),
            }),
            tx.query.workspaceViews.findMany({
              where: { workspaceId: { eq: sourceWorkspaceId } },
              orderBy: { position: "asc" },
              limit: LIMITS.viewsCount,
            }),
            tx.query.workspaceMembers.findMany({
              where: { workspaceId: { eq: sourceWorkspaceId } },
              columns: { userId: true },
              limit: LIMITS.workspaceMembersCount,
            }),
            tx.query.workspaceContacts.findMany({
              where: { workspaceId: { eq: sourceWorkspaceId } },
              limit: LIMITS.workspaceContactsCount,
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
                        // Ascending field id is ascending creation order, which
                        // is the order `findExtractionFileField` requires: the
                        // copy must select the same file field for extraction
                        // that the source does. At most one field per property,
                        // so the limit is the structural bound, stated for the
                        // unbounded-read rule.
                        fields: {
                          columns: {
                            propertyId: true,
                            content: true,
                          },
                          orderBy: { id: "asc" },
                          limit: LIMITS.propertiesCount,
                        },
                      },
                    },
                  },
                })
              : Promise.resolve([]),
          ]);

          assertPropertyDependencyReadWithinLimit(
            propertyDependencyRows.length,
            "perWorkspace",
          );

          return {
            workspace,
            properties: workspaceProperties,
            dependencies: propertyDependencyRows,
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

      // Checked before anything is written: the snapshot already carries the
      // count, so the source size never has to reach the write transaction.
      if (snapshot.entities.length > LIMITS.entitiesCount) {
        return Result.err(
          new HandlerError({ status: 400, message: "Entities limit reached" }),
        );
      }

      const fileCopies = collectUniqueFileCopies(snapshot.entities);
      const fileIdMap = new Map(
        fileCopies.map((copy) => [copy.sourceFileId, copy.targetFileId]),
      );
      const copiedS3Keys: string[] = [];

      if (includeContent) {
        const copyResult = await Result.tryPromise(async () => {
          await copyWorkspaceFiles({
            copiedS3Keys,
            copies: fileCopies,
            organizationId,
            sourceWorkspaceId,
            targetWorkspaceId,
          });
        });

        if (Result.isError(copyResult)) {
          await cleanupCopiedS3Keys({
            copiedS3Keys,
            targetWorkspaceId,
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

      // Every rejection below throws rather than returning: returning from a
      // transaction callback commits whatever it has already written, so a
      // rejection raised part-way through would persist half a matter and then
      // have the caller delete the objects those committed rows point at.
      const txResult = await safeDb(async (tx) => {
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
          throw new HandlerError({
            status: 400,
            message: "Workspaces limit reached",
          });
        }

        if (orgMembers.length !== snapshot.members.length) {
          throw new HandlerError({
            status: 400,
            message: "Some users are not members of this organization",
          });
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
          throw new HandlerError({
            status: 500,
            message: "Failed to create matter counter",
          });
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
          leadUserId: snapshot.workspace.leadUserId,
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
              role: property.role,
            };
          });
          await tx.insert(properties).values(newProperties);
        }

        const newDependencies = snapshot.dependencies
          .map((dependency) => {
            const propertyId = propertyIdMap.get(dependency.propertyId);
            // Remaps the edge and the gate condition together so the copy can't
            // remap one without the other; null when the edge endpoint is gone.
            const refs = remapDependencyRefs(
              {
                dependsOnPropertyId: dependency.dependsOnPropertyId,
                condition: dependency.condition,
              },
              (id) => propertyIdMap.get(id),
            );
            if (!propertyId || !refs) {
              return null;
            }
            return {
              id: createSafeId<"propertyDependency">(),
              workspaceId: targetWorkspaceId,
              propertyId,
              dependsOnPropertyId: refs.dependsOnPropertyId,
              condition: refs.condition,
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
        // Split by which mechanism owns each copy's search projection, so every
        // duplicated entity is covered exactly once: a durable extraction run
        // indexes the documents it extracts, and a dirty mark committed with
        // this transaction covers everything else.
        const duplicatedEntityIds: Record<
          SearchIndexOwner,
          SafeId<"entity">[]
        > = {
          [SEARCH_INDEX_OWNER.durableExtraction]: [],
          [SEARCH_INDEX_OWNER.searchMark]: [],
        };
        const nativeExtractionRequests: NativeExtractionRunRequest[] = [];
        const entitiesToDuplicate = orderEntitiesForDuplicate(
          snapshot.entities,
        );

        if (includeContent && entitiesToDuplicate.length > 0) {
          // The document rows are known before the duplicate starts, so the
          // whole run of sequence numbers is allocated in one counter upsert
          // plus one reference read instead of two statements per document.
          // The filter keeps duplicate order, so each document consumes the
          // stamp for its own position.
          const documentStamps = await allocateEntityStamps({
            tx,
            workspaceId: targetWorkspaceId,
            count: entitiesToDuplicate.filter(
              (source) => source.kind === "document",
            ).length,
          });
          let nextStampIndex = 0;

          for (const source of entitiesToDuplicate) {
            if (!source.currentVersion) {
              throw new HandlerError({
                status: 400,
                message: "Entity has no current version",
              });
            }

            const newEntityId = createSafeId<"entity">();
            const newVersionId = createSafeId<"entityVersion">();
            const entityStamp =
              source.kind === "document"
                ? (documentStamps.at(nextStampIndex++) ??
                  panic(
                    "Fewer document stamps allocated than documents copied",
                  ))
                : null;
            const newParentId = source.parentId
              ? (entityIdMap.get(source.parentId) ?? null)
              : null;

            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential by design: children reference parent IDs created in earlier iterations via entityIdMap; also the version insert and currentVersionId update just below depend on this row
            await tx.insert(entities).values({
              id: newEntityId,
              workspaceId: targetWorkspaceId,
              kind: source.kind,
              parentId: newParentId,
              name: source.name,
              createdBy: user.id,
              lastEditedBy: user.id,
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

            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential version insert depends on the entity row created just above in this iteration
            await tx.insert(entityVersions).values({
              id: newVersionId,
              workspaceId: targetWorkspaceId,
              entityId: newEntityId,
              versionNumber: 1,
              stamp: entityStamp?.stamp ?? null,
              verificationCode: entityStamp?.verificationCode ?? null,
              createdBy: user.id,
            });

            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential update sets currentVersionId on the just-created entity/version pair
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
                  id: createSafeId<"field">(),
                  workspaceId: targetWorkspaceId,
                  propertyId,
                  entityVersionId: newVersionId,
                  content: remapFieldContent(field.content, fileIdMap),
                },
              ];
            });
            if (newFields.length > 0) {
              // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential field insert depends on the version created in this iteration
              await tx.insert(fields).values(newFields);
            }

            entityIdMap.set(source.id, newEntityId);
            // IDs are minted in source field order, so the transactional run
            // uses the same selected file the post-commit processor would read.
            const extractionRequest = nativeExtractionRunRequestForFields({
              entityId: newEntityId,
              entityVersionId: newVersionId,
              fields: newFields,
              organizationId,
              workspaceId: targetWorkspaceId,
            });
            if (extractionRequest === null) {
              duplicatedEntityIds[SEARCH_INDEX_OWNER.searchMark].push(
                newEntityId,
              );
            } else {
              duplicatedEntityIds[SEARCH_INDEX_OWNER.durableExtraction].push(
                newEntityId,
              );
              nativeExtractionRequests.push(extractionRequest);
            }
          }
        }

        await recordAuditEvent(tx, {
          workspaceId: targetWorkspaceId,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: targetWorkspaceId,
          changes: {
            created: {
              old: { sourceWorkspaceId, includeContent },
              new: { name: newName, reference },
            },
          },
        });

        await dependencies.enqueueEntitySearchRepairs(
          tx,
          duplicatedEntityIds[SEARCH_INDEX_OWNER.searchMark],
        );
        const nativeExtractionRunIds =
          await dependencies.requestNativeExtractionRuns({
            requests: nativeExtractionRequests,
            tx,
          });
        await dependencies.enqueueWorkspaceSearchRepairs(tx, [
          targetWorkspaceId,
        ]);

        return {
          workspaceId: targetWorkspaceId,
          entityIds: duplicatedEntityIds,
          nativeExtractionRunIds,
        };
      });

      // An aborted duplicate leaves no target matter, so every object copied
      // for it is an orphan and the whole set goes back.
      if (Result.isError(txResult)) {
        await cleanupCopiedS3Keys({
          copiedS3Keys,
          targetWorkspaceId,
        });
        return Result.err(transactionAbortError(txResult.error));
      }

      // These post-commit calls only accelerate work the transaction already
      // made durable: projection marks and immutable-source extraction runs.
      dependencies
        .flushWorkspaceSearchRepairs([txResult.value.workspaceId])
        .catch(captureError);
      dependencies
        .flushEntitySearchRepairs(
          txResult.value.entityIds[SEARCH_INDEX_OWNER.searchMark],
        )
        .catch(captureError);

      handoffCommittedDocumentProcessingRuns({
        enqueue: dependencies.enqueueDocumentProcessingRun,
        runIds: txResult.value.nativeExtractionRunIds,
      }).catch(captureError);

      return Result.ok({ workspaceId: txResult.value.workspaceId });
    },
  );

const duplicateWorkspace = createDuplicateWorkspace();

export default duplicateWorkspace;
