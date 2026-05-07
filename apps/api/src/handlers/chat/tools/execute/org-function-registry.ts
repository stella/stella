import { Result } from "better-result";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { contacts, entities, properties } from "@/api/db/schema";
import { createToolFunction } from "@/api/handlers/chat/tools/execute/execute-tool-function";
import {
  getContactsContract,
  getMattersContract,
  listContactsContract,
  listMattersContract,
  searchMatterDocumentsContract,
} from "@/api/handlers/chat/tools/execute/org-manifest";
import { buildPaginatedResult } from "@/api/handlers/chat/tools/execute/pagination";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { ensureAllowedWorkspaceIds } from "@/api/handlers/chat/tools/execute/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { getSearchProvider } from "@/api/lib/search/provider";

type OrgFunctionContext = {
  allowedWorkspaceIds: SafeId<"workspace">[];
  refRegistry: ChatRefRegistry;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
};

type ContactChannels = {
  emails?: { address: string; isPrimary: boolean }[] | null | undefined;
  phones?: { number: string; isPrimary: boolean }[] | null | undefined;
};

const getPrimaryEmail = ({ emails }: ContactChannels) =>
  emails?.find((email) => email.isPrimary)?.address ??
  emails?.at(0)?.address ??
  null;

const getPrimaryPhone = ({ phones }: ContactChannels) =>
  phones?.find((phone) => phone.isPrimary)?.number ??
  phones?.at(0)?.number ??
  null;

export const createReadonlyOrgFunctionRegistry = ({
  organizationId,
  refRegistry,
  safeDb,
  allowedWorkspaceIds,
}: OrgFunctionContext) => ({
  [listMattersContract.name]: createToolFunction(
    listMattersContract,
    async function* (input) {
      const offset = input.offset ?? 0;

      const workspaceRows = yield* await safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            id: { in: allowedWorkspaceIds },
            organizationId: { eq: organizationId },
            status: { eq: "active" },
          },
          columns: {
            id: true,
            name: true,
            reference: true,
            lastActivityAt: true,
          },
          orderBy: {
            lastActivityAt: "desc",
          },
          limit: input.limit + 1,
          offset,
        }),
      );

      return Result.ok(
        buildPaginatedResult({
          items: workspaceRows.map((workspace) => ({
            lastActivityAt: workspace.lastActivityAt.toISOString(),
            matterRef: refRegistry.toMatterRef(workspace.id),
            mention: refRegistry.toMatterMention({
              label: workspace.name,
              workspaceId: workspace.id,
            }),
            name: workspace.name,
            reference: workspace.reference,
          })),
          limit: input.limit,
          offset,
        }),
      );
    },
  ),
  [getMattersContract.name]: createToolFunction(
    getMattersContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });

      const workspaceRows = yield* await safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            id: { in: scopedWorkspaceIds },
            organizationId: { eq: organizationId },
            status: { eq: "active" },
          },
          columns: {
            id: true,
            name: true,
            reference: true,
            color: true,
            createdAt: true,
            lastActivityAt: true,
          },
          extras: {
            entityCount: (ws) =>
              tx.$count(entities, eq(entities.workspaceId, ws.id)),
            propertyCount: (ws) =>
              tx.$count(properties, eq(properties.workspaceId, ws.id)),
          },
          with: {
            client: {
              columns: {
                displayName: true,
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        }),
      );

      return Result.ok({
        items: workspaceRows.map((workspace) => ({
          clientName: workspace.client?.displayName ?? null,
          color: workspace.color,
          createdAt: workspace.createdAt.toISOString(),
          entityCount: workspace.entityCount,
          lastActivityAt: workspace.lastActivityAt.toISOString(),
          matterRef: refRegistry.toMatterRef(workspace.id),
          mention: refRegistry.toMatterMention({
            label: workspace.name,
            workspaceId: workspace.id,
          }),
          name: workspace.name,
          propertyCount: workspace.propertyCount,
          reference: workspace.reference,
        })),
      });
    },
  ),
  [listContactsContract.name]: createToolFunction(
    listContactsContract,
    async function* (input) {
      const offset = input.offset ?? 0;
      const conditions = [eq(contacts.organizationId, organizationId)];

      if (input.query) {
        const pattern = `%${escapeLike(input.query)}%`;
        const searchCondition = or(
          ilike(contacts.displayName, pattern),
          ilike(contacts.firstName, pattern),
          ilike(contacts.lastName, pattern),
          ilike(contacts.organizationName, pattern),
        );

        if (searchCondition) {
          conditions.push(searchCondition);
        }
      }

      const contactRows = yield* await safeDb((tx) =>
        tx
          .select({
            id: contacts.id,
            type: contacts.type,
            displayName: contacts.displayName,
            emails: contacts.emails,
            phones: contacts.phones,
          })
          .from(contacts)
          .where(and(...conditions))
          .orderBy(asc(contacts.displayName))
          .limit(input.limit + 1)
          .offset(offset),
      );

      return Result.ok(
        buildPaginatedResult({
          items: contactRows.map((contact) => ({
            contactRef: refRegistry.toContactRef(contact.id),
            displayName: contact.displayName,
            primaryEmail: getPrimaryEmail(contact),
            primaryPhone: getPrimaryPhone(contact),
            type: contact.type,
          })),
          limit: input.limit,
          offset,
        }),
      );
    },
  ),
  [getContactsContract.name]: createToolFunction(
    getContactsContract,
    async function* (input) {
      const contactIds = yield* refRegistry.resolveContactRefs(
        input.contactRefs,
      );

      const contactRows = yield* await safeDb((tx) =>
        tx
          .select({
            id: contacts.id,
            type: contacts.type,
            displayName: contacts.displayName,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            organizationName: contacts.organizationName,
            emails: contacts.emails,
            phones: contacts.phones,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              inArray(contacts.id, contactIds),
            ),
          )
          .orderBy(asc(contacts.displayName)),
      );

      return Result.ok({
        items: contactRows.map((contact) => ({
          contactRef: refRegistry.toContactRef(contact.id),
          displayName: contact.displayName,
          emails: contact.emails ?? [],
          firstName: contact.firstName,
          lastName: contact.lastName,
          organizationName: contact.organizationName,
          phones: contact.phones ?? [],
          primaryEmail: getPrimaryEmail(contact),
          primaryPhone: getPrimaryPhone(contact),
          type: contact.type,
        })),
      });
    },
  ),
  [searchMatterDocumentsContract.name]: createToolFunction(
    searchMatterDocumentsContract,
    async function* (input) {
      const workspaceIds = yield* refRegistry.resolveMatterRefs(
        input.matterRefs,
      );
      const scopedWorkspaceIds = yield* ensureAllowedWorkspaceIds({
        allowedWorkspaceIds,
        workspaceIds,
      });

      const result = yield* await Result.tryPromise({
        try: async () =>
          await getSearchProvider().search({
            query: input.query,
            kinds: ["document"],
            organizationId,
            workspaceIds: scopedWorkspaceIds,
            limit: input.limit,
          }),
        catch: (cause) =>
          new ChatToolError({
            message: "Failed to search matter documents.",
            cause,
          }),
      });

      return Result.ok({
        items: result.hits.map((hit) => {
          const entityId = brandPersistedEntityId(hit.entityId);
          const workspaceId = brandPersistedWorkspaceId(hit.workspaceId);

          return {
            entityRef: refRegistry.toEntityRef({
              entityId,
              workspaceId,
            }),
            headline: hit.headline,
            kind: hit.kind,
            matterName: hit.workspaceName,
            matterRef: refRegistry.toMatterRef(workspaceId),
            mention: refRegistry.toEntityMention({
              entityId,
              label: hit.title,
              workspaceId,
            }),
            name: hit.title,
            updatedAt: hit.updatedAt,
          };
        }),
      });
    },
  ),
});
