/**
 * The kind of each of several documents on one list, in one read: the AVT
 * documents tab shows every document's kind at once. Every named document
 * is answered, classified or not, so no reader has to know the default.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, uniqueItems } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  LIST_OR_DOCUMENT_NOT_FOUND,
  readListSourceScope,
  readSourceKinds,
} from "@/api/lib/lists/fact-tiers";
import { SOURCE_KIND_LIMITS } from "@/api/lib/lists/source-kind";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Read what each named document is to one list's facts: `document` (it " +
    "records what happened: a letter, minutes, a register) or `testimony` " +
    "(a person's account: a witness statement, an interview note, a " +
    "transcript). Every named document is answered; one nobody has " +
    "classified is `document`. Set a kind with lists.source-documents.update.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  body: v.object({
    listId: resourceIdSchema("legalList"),
    documentEntityIds: v.pipe(
      v.array(resourceIdSchema("entity")),
      v.minLength(1),
      v.maxLength(SOURCE_KIND_LIMITS.READ_DOCUMENTS_MAX),
      uniqueItems((id) => id),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readSourceDocumentKinds = createSafeHandler(
  config,
  async function* ({
    body: { listId, documentEntityIds },
    safeDb,
    workspaceId,
  }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const scope = await readListSourceScope({
          tx,
          workspaceId,
          listId,
          documentEntityIds,
        });
        if (scope.type !== "found") {
          return scope;
        }
        const kinds = await readSourceKinds({
          tx,
          workspaceId,
          listId,
          documentIds: documentEntityIds,
        });
        return {
          type: "found",
          documents: [...kinds].map(([documentEntityId, sourceKind]) => ({
            documentEntityId,
            sourceKind,
          })),
        } as const;
      }),
    );
    switch (result.type) {
      case "list-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: LIST_OR_DOCUMENT_NOT_FOUND,
            message: `No list ${listId} in this matter.`,
          }),
        );
      }
      case "documents-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: LIST_OR_DOCUMENT_NOT_FOUND,
            message: `No document in this matter has the id ${result.missing.join(", ")}.`,
          }),
        );
      }
      case "found": {
        return Result.ok({ documents: result.documents });
      }
      default: {
        result satisfies never;
        return panic(`Unhandled outcome: ${String(result)}`);
      }
    }
  },
);

export default readSourceDocumentKinds;
