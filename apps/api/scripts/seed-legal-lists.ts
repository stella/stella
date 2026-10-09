import { panic } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import {
  ENTITY_PRIORITY,
  LIST_ITEM_TYPE,
  TASK_STATUS,
} from "@stll/api-contract/entity-options";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalListFactDetails,
  legalListItems,
  legalListItemSources,
  legalLists,
  workspaceViews,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { DEFAULT_USER_ID, seedId } from "./seed-utils";

const SYNTHETIC_FACTS = [
  { name: "Sample delivery schedule confirmed", position: "a" },
  { name: "Sample inspection completed", position: "b" },
  { name: "Sample acceptance recorded", position: "c" },
] as const;

type SeedLegalListsOptions = {
  workspaceId: SafeId<"workspace">;
  userId: string;
};

/** Fictional facts and provenance for the local list review surfaces. */
export const seedLegalLists = async (
  scopedDb: ScopedDb,
  { workspaceId, userId }: SeedLegalListsOptions,
) =>
  await scopedDb(async (tx) => {
    const source = (
      await tx
        .select({
          entityId: entities.id,
          versionId: entityVersions.id,
        })
        .from(entities)
        .innerJoin(
          entityVersions,
          and(
            eq(entityVersions.id, entities.currentVersionId),
            eq(entityVersions.entityId, entities.id),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "document"),
            isNull(entityVersions.deletedAt),
          ),
        )
        .orderBy(entities.id)
        .limit(1)
    ).at(0);
    if (!source) {
      panic("Legal list fixtures require a seeded document version");
    }

    const listId = seedId<"legalList">(`legal-list-${workspaceId}`);
    const viewId = seedId<"workspaceView">(`legal-list-view-${workspaceId}`);
    const sourceId = seedId<"legalListItemSource">(
      `legal-list-source-${workspaceId}`,
    );
    const facts = SYNTHETIC_FACTS.map((fact) => ({
      ...fact,
      id: seedId<"entity">(`legal-list-fact-${workspaceId}-${fact.position}`),
    }));
    const firstFact = facts.at(0);
    if (!firstFact) {
      panic("Legal list fixtures require a fact");
    }
    await tx
      .insert(legalLists)
      .values({
        id: listId,
        workspaceId,
        name: "Synthetic evidence chronology",
        description: "Fictional sample facts for source review.",
        createdBy: userId,
      })
      .onConflictDoNothing();
    await tx
      .insert(entities)
      .values(
        facts.map(({ id, name }) => ({
          id,
          workspaceId,
          kind: "task" as const,
          listItemType: LIST_ITEM_TYPE.FACT,
          name,
          displayName: name,
          createdBy: userId,
          agendaKind: "task" as const,
          status: TASK_STATUS.OPEN,
          priority: ENTITY_PRIORITY.NONE,
          agendaSource: "manual" as const,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(legalListItems)
      .values(
        facts.map(({ id, position }) => ({
          entityId: id,
          workspaceId,
          listId,
          position,
          addedBy: userId,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(legalListFactDetails)
      .values(
        facts.map(({ id }) => ({
          itemEntityId: id,
          workspaceId,
          listId,
          confidence: "high" as const,
          evidenceKind: "Synthetic example",
          updatedBy: userId,
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(legalListItemSources)
      .values({
        id: sourceId,
        workspaceId,
        listId,
        itemEntityId: firstFact.id,
        sourceEntityId: source.entityId,
        sourceEntityVersionId: source.versionId,
        locator: { type: "document" },
        quote: "Synthetic example: the sample delivery schedule is confirmed.",
        createdBy: userId,
      })
      .onConflictDoNothing();
    // A seeded view supplies the click path to the list without creating data.
    await tx
      .insert(workspaceViews)
      .values({
        id: viewId,
        workspaceId,
        name: "Source review",
        position: 5,
        layout: {
          version: 1,
          type: "avt",
          filters: [],
          sorts: [],
          hiddenProperties: [],
          calculations: [],
          listId,
        },
      })
      .onConflictDoNothing();
    return {
      listId,
      viewId,
      sourceId,
      itemEntityIds: facts.map(({ id }) => id),
    };
  });

if (import.meta.main) {
  requireLocalDevOpen("seed legal lists");
  await seedLegalLists(openMaintenanceDb({ readOnly: false }).transaction, {
    workspaceId: seedId<"workspace">("ws-akvizice-energo"),
    userId: DEFAULT_USER_ID,
  });
  process.exit(0);
}
