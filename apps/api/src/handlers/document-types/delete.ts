import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  documentTypes,
  playbookDefinitions,
  PLAYBOOK_DOCUMENT_TYPE_CONSTRAINT,
} from "@/api/db/schema";
import { documentTypeParamsSchema } from "@/api/handlers/document-types/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { BoundedReadResult } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";

const config = {
  description:
    "Remove one document type from the organization's classification list so " +
    "it can no longer be assigned. Documents already classified as that type " +
    "keep their stored label; the call is refused while any playbook is scoped " +
    "to the type.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "workspace_schema",
    consumesServices: false,
  },
  params: documentTypeParamsSchema,
} satisfies HandlerConfig;

/** How many referencing playbooks the refusal names. */
const IN_USE_NAMED_PLAYBOOKS = 5;

type ReferencingPlaybooks = BoundedReadResult<{ name: string }>;

// A read past the cap names no partial set: its count would be a guess.
const documentTypeInUseError = (referencing: ReferencingPlaybooks) => {
  const usage =
    referencing.type === "overflow"
      ? `more than ${String(referencing.cap)} playbooks`
      : `${String(referencing.rows.length)} playbook(s): ${referencing.rows
          .map((row) => row.name)
          .join(", ")}`;
  return new HandlerError({
    status: 409,
    message: `In use by ${usage}. Reassign them first.`,
    retryable: false,
  });
};

// The named pre-check explains which playbooks need reassignment. The FK
// protects references committed after that read. Classified documents retain
// their stored label; deletion removes only the type as a future option.
const deleteDocumentType = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const deleted = await safeDb(async (tx) => {
      const existing = await tx.query.documentTypes.findFirst({
        where: {
          id: { eq: params.documentTypeId },
          organizationId: { eq: organizationId },
        },
        columns: { id: true, key: true, label: true },
      });
      if (!existing) {
        return { notFound: true } as const;
      }

      const referencing = await readBounded(
        tx
          .select({ name: playbookDefinitions.name })
          .from(playbookDefinitions)
          .where(
            and(
              eq(playbookDefinitions.organizationId, organizationId),
              eq(playbookDefinitions.documentTypeKey, existing.key),
            ),
          ),
        IN_USE_NAMED_PLAYBOOKS,
      );
      if (referencing.type === "overflow" || referencing.rows.length > 0) {
        return { inUse: referencing } as const;
      }

      await tx
        .delete(documentTypes)
        .where(
          and(
            eq(documentTypes.id, params.documentTypeId),
            eq(documentTypes.organizationId, organizationId),
          ),
        );

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.DELETE,
        resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE,
        resourceId: existing.id,
        changes: {
          deleted: {
            old: { key: existing.key, label: existing.label },
            new: null,
          },
        },
      });

      return { deleted: true } as const;
    });

    if (deleted.isErr()) {
      if (
        !isPgConstraintError(
          deleted.error,
          PG_ERROR.FOREIGN_KEY_VIOLATION,
          PLAYBOOK_DOCUMENT_TYPE_CONSTRAINT,
        )
      ) {
        return Result.err(deleted.error);
      }
      // The failed transaction rolled back; read the committed references to
      // preserve the same named refusal as the pre-check.
      const referencing = yield* Result.await(
        safeDb(
          async (tx) =>
            await readBounded(
              tx
                .select({ name: playbookDefinitions.name })
                .from(playbookDefinitions)
                .innerJoin(
                  documentTypes,
                  and(
                    eq(
                      documentTypes.organizationId,
                      playbookDefinitions.organizationId,
                    ),
                    eq(documentTypes.key, playbookDefinitions.documentTypeKey),
                  ),
                )
                .where(
                  and(
                    eq(documentTypes.id, params.documentTypeId),
                    eq(documentTypes.organizationId, organizationId),
                  ),
                ),
              IN_USE_NAMED_PLAYBOOKS,
            ),
        ),
      );
      return Result.err(documentTypeInUseError(referencing));
    }
    const outcome = deleted.value;

    if ("notFound" in outcome) {
      return Result.err(
        new HandlerError({ status: 404, message: "Document type not found" }),
      );
    }
    if ("inUse" in outcome) {
      return Result.err(documentTypeInUseError(outcome.inUse));
    }

    return Result.ok({});
  },
);

export default deleteDocumentType;
