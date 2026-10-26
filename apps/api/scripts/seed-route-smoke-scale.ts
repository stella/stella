import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { LIST_ITEM_TYPE, TASK_STATUS } from "@stll/api-contract/entity-options";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatThreads,
  contacts,
  entities,
  entityVersions,
  featureEnrolments,
  fields,
  legalListItems,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { chatThreadHasMessages } from "@/api/handlers/chat/threads/list-visibility";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { createSiblingNamePlan } from "@/api/lib/entities/sibling-name-insert";
import { insertEntityBatch } from "@/api/lib/entity-versions/insert-entity-batch";
import { insertEntityVersions } from "@/api/lib/entity-versions/insert-entity-version";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { buildRouteSmokeChatRows } from "./seed-route-smoke-chat";

requireLocalDevOpen("Seeding route smoke scale fixtures");

const input = v.parse(
  v.object({
    organizationId: v.string(),
    userId: v.string(),
    workspaceId: v.pipe(v.string(), v.uuid()),
    documentId: v.pipe(v.string(), v.uuid()),
    contactId: v.pipe(v.string(), v.uuid()),
    count: v.picklist([100, 1000]),
  }),
  JSON.parse(process.argv.at(2) ?? "null"),
);
const organizationId = toSafeId<"organization">(input.organizationId);
const userId = toSafeId<"user">(input.userId);
const workspaceId = toSafeId<"workspace">(input.workspaceId);
const db = openMaintenanceDb({ readOnly: false });

type SeedPhase =
  | "owner"
  | "enrollment"
  | "scoped-lookup"
  | "entities"
  | "versions"
  | "lists-and-contacts"
  | "chat"
  | "cardinalities";

const recordSeedPhase = (phase: SeedPhase): void => {
  process.stderr.write(
    `${JSON.stringify({ event: "route_smoke_scale.seed_phase", phase })}\n`,
  );
};

type SmokeCardinalityScope = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

const readSmokeCardinalities = async (
  tx: Transaction,
  {
    organizationId: scopeOrganizationId,
    userId: scopeUserId,
    workspaceId: scopeWorkspaceId,
  }: SmokeCardinalityScope,
) => ({
  entities: await tx.$count(
    entities,
    eq(entities.workspaceId, scopeWorkspaceId),
  ),
  documents: await tx.$count(
    entities,
    and(
      eq(entities.workspaceId, scopeWorkspaceId),
      eq(entities.kind, "document"),
    ),
  ),
  contacts: await tx.$count(
    contacts,
    eq(contacts.organizationId, scopeOrganizationId),
  ),
  versions: await tx.$count(
    entityVersions,
    eq(entityVersions.workspaceId, scopeWorkspaceId),
  ),
  chatThreads: await tx.$count(
    chatThreads,
    and(
      eq(chatThreads.organizationId, scopeOrganizationId),
      eq(chatThreads.userId, scopeUserId),
      chatThreadHasMessages,
    ),
  ),
  listRows: await tx.$count(
    legalListItems,
    eq(legalListItems.workspaceId, scopeWorkspaceId),
  ),
});

await runScriptWithErrorOutput(async () => {
  // This maintenance command can augment only an isolated fixture created by
  // the HTTP helpers, never an operator's existing organization or matter.
  recordSeedPhase("owner");
  const principal = await withAggregateTransaction(db, async (tx) =>
    (
      await tx
        .select({ email: user.email, slug: organization.slug })
        .from(workspaces)
        .innerJoin(organization, eq(organization.id, workspaces.organizationId))
        .innerJoin(member, eq(member.organizationId, organization.id))
        .innerJoin(user, eq(user.id, member.userId))
        .where(
          and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.name, `route-smoke-${workspaceId.slice(0, 8)}`),
            eq(workspaces.organizationId, organizationId),
            eq(workspaces.status, "active"),
            eq(member.userId, userId),
            eq(member.role, "owner"),
          ),
        )
        .limit(1)
    ).at(0),
  );
  if (
    principal === undefined ||
    !/^route-smoke-scale-[\da-f-]+@stella\.dev$/u.test(principal.email) ||
    !principal.slug.startsWith("route-smoke-scale-")
  ) {
    panic("Scale fixture requires an isolated route smoke owner and matter");
  }
  recordSeedPhase("enrollment");
  await withAggregateTransaction(db, async (tx) => {
    await tx.insert(featureEnrolments).values({
      organizationId,
      userId,
      featureId: "time-billing",
    });
  });

  const scopedDb = createRootMembershipScopedDb({ organizationId, userId });
  await scopedDb(async (tx) => {
    recordSeedPhase("scoped-lookup");
    const document = await tx.query.entities.findFirst({
      where: {
        id: { eq: toSafeId<"entity">(input.documentId) },
        workspaceId: { eq: workspaceId },
      },
    });
    const contact = await tx.query.contacts.findFirst({
      where: {
        id: { eq: toSafeId<"contact">(input.contactId) },
        organizationId: { eq: organizationId },
      },
    });
    if (
      document?.currentVersionId === null ||
      document === undefined ||
      contact === undefined
    ) {
      panic("Scale fixture requires its uploaded document and contact");
    }
    const sourceFields = await tx
      .select()
      .from(fields)
      .where(eq(fields.entityVersionId, document.currentVersionId));
    const namePlan = await createSiblingNamePlan({ tx, workspaceId });
    const siblings = Array.from({ length: input.count - 1 }, (_, index) => ({
      id: createSafeId<"entity">(),
      versionId: createSafeId<"entityVersion">(),
      name: namePlan({
        name: `Scale document ${String(index).padStart(3, "0")}`,
        kind: "document",
        parentId: null,
      }).name,
    }));
    const rows = Array.from({ length: input.count }, (_, index) => ({
      id: createSafeId<"entity">(),
      versionId: createSafeId<"entityVersion">(),
      name: namePlan({
        name: `Scale list row ${String(index).padStart(3, "0")}`,
        kind: "task",
        parentId: null,
      }).name,
      position: String(index).padStart(4, "0"),
    }));
    recordSeedPhase("entities");
    await insertEntityBatch({
      tx,
      entityRows: [
        ...siblings.map(({ id, name }) => ({
          id,
          workspaceId,
          kind: "document" as const,
          name,
          displayName: name,
          createdBy: userId,
        })),
        ...rows.map(({ id, name }) => ({
          id,
          workspaceId,
          kind: "task" as const,
          name,
          displayName: name,
          createdBy: userId,
          listItemType: LIST_ITEM_TYPE.FACT,
          agendaKind: "task" as const,
          status: TASK_STATUS.OPEN,
          agendaSource: "manual" as const,
        })),
      ],
      versionRows: [...siblings, ...rows].map(({ id, versionId }) => ({
        id: versionId,
        entityId: id,
        workspaceId,
        createdBy: userId,
      })),
      currentVersions: [...siblings, ...rows].map(({ id, versionId }) => ({
        entityId: id,
        versionId,
      })),
      stampOrigin: "issued",
      fieldRows: siblings.flatMap(({ versionId }) =>
        sourceFields.map((field) => ({
          ...field,
          id: createSafeId<"field">(),
          entityVersionId: versionId,
        })),
      ),
    });
    // The opened document also has a tenfold history. Historical versions do
    // not need duplicate S3 objects: their fields reference the uploaded file.
    const history = Array.from({ length: input.count }, (_, index) => ({
      id: createSafeId<"entityVersion">(),
      entityId: document.id,
      workspaceId,
      createdBy: userId,
      versionNumber: index + 2,
    }));
    recordSeedPhase("versions");
    await insertEntityVersions({ tx, values: history, stampOrigin: "issued" });
    await tx.insert(fields).values(
      history.flatMap((version) =>
        sourceFields.map((field) => ({
          ...field,
          id: createSafeId<"field">(),
          entityVersionId: version.id,
        })),
      ),
    );
    recordSeedPhase("lists-and-contacts");
    const listId = createSafeId<"legalList">();
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Scale chronology",
      createdBy: userId,
    });
    await tx.insert(legalListItems).values(
      rows.map(({ id, position }) => ({
        entityId: id,
        workspaceId,
        listId,
        position,
        addedBy: userId,
      })),
    );
    await tx.insert(contacts).values(
      Array.from({ length: input.count - 1 }, (_, index) => ({
        ...contact,
        id: createSafeId<"contact">(),
        displayName: `Scale contact ${String(index).padStart(3, "0")}`,
      })),
    );
    const chat = buildRouteSmokeChatRows({
      count: input.count,
      organizationId,
      userId,
      workspaceId,
    });
    recordSeedPhase("chat");
    await tx.insert(chatThreads).values(chat.threads);
    await tx.insert(chatMessages).values(chat.messages);
    recordSeedPhase("cardinalities");
    const cardinalities = await readSmokeCardinalities(tx, {
      organizationId,
      userId,
      workspaceId,
    });
    process.stdout.write(JSON.stringify(cardinalities));
  });
});
process.exit(0);
