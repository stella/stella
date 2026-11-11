import { panic, Result } from "better-result";
import * as v from "valibot";

import { legalListSourceDocuments } from "@/api/db/schema";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  LIST_OR_DOCUMENT_NOT_FOUND,
  readListSourceScope,
  readSourceKinds,
} from "@/api/lib/lists/fact-tiers";
import {
  SOURCE_KIND_SET_OPERATION,
  SOURCE_KINDS,
} from "@/api/lib/lists/source-kind";

// `v.picklist` over the const tuple keeps the literal union in the inferred
// body type, which the web client reads its types from.

const bodySchema = v.object({
  listId: resourceIdSchema("legalList"),
  documentEntityId: resourceIdSchema("entity"),
  sourceKind: v.picklist(SOURCE_KINDS),
});

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Set what one document is to a list's facts: `testimony` when it is a " +
    "person's account (a witness statement, an interview note, a " +
    "transcript), `document` when it records what happened. Every source " +
    "of the list citing the document takes the kind at once: a fact whose " +
    "sources are all testimony reads as testimony, and a claim whose " +
    "verdict rests only on such facts carries the `testimony-only` " +
    "qualifier. Setting the kind a document already has changes nothing.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: legalListRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const updateSourceDocumentKind = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    user,
    body: { listId, documentEntityId, sourceKind },
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const scope = await readListSourceScope({
          tx,
          workspaceId,
          listId,
          documentEntityIds: [documentEntityId],
        });
        if (scope.type !== "found") {
          return scope;
        }
        const before =
          (
            await readSourceKinds({
              tx,
              workspaceId,
              listId,
              documentIds: [documentEntityId],
            })
          ).get(documentEntityId) ?? panic("A named document has no kind");
        if (before === sourceKind) {
          return { type: "unchanged" } as const;
        }
        await tx
          .insert(legalListSourceDocuments)
          .values({
            workspaceId,
            listId,
            documentEntityId,
            sourceKind,
            updatedBy: user.id,
          })
          .onConflictDoUpdate({
            target: [
              legalListSourceDocuments.listId,
              legalListSourceDocuments.documentEntityId,
            ],
            set: { sourceKind, updatedBy: user.id, updatedAt: new Date() },
          });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST,
          resourceId: listId,
          changes: { sourceKind: { old: before, new: sourceKind } },
          metadata: {
            operation: SOURCE_KIND_SET_OPERATION,
            documentEntityId,
          },
        });
        return { type: "updated" } as const;
      }),
    );

    switch (result.type) {
      case "list-not-found":
      case "documents-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: LIST_OR_DOCUMENT_NOT_FOUND,
            message: `No list ${listId} with a document ${documentEntityId} in this matter.`,
          }),
        );
      }
      case "unchanged":
      case "updated": {
        return Result.ok({ listId, documentEntityId, sourceKind });
      }
      default: {
        result satisfies never;
        return panic(`Unhandled outcome: ${String(result)}`);
      }
    }
  },
);

export default updateSourceDocumentKind;
