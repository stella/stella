import { eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

export const updateWorkspaceBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  clientId: t.Optional(t.Nullable(tNanoid)),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
});

type UpdateWorkspaceBodySchema = Static<typeof updateWorkspaceBodySchema>;

type UpdateWorkspaceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  body: UpdateWorkspaceBodySchema;
};

// Workspace name is fetched via JOIN at search time;
// no reindex needed on rename.
export const updateWorkspaceHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  body,
}: UpdateWorkspaceHandlerProps) => {
  // Normalize empty string to null so the unique index
  // doesn't reject duplicate empty references.
  if (body.reference === "") {
    body.reference = null;
  }

  try {
    return await scopedDb(async (tx) => {
      if (body.clientId) {
        const contact = await tx.query.contacts.findFirst({
          where: {
            id: body.clientId,
            organizationId: { eq: organizationId },
          },
          columns: { id: true },
        });

        if (!contact) {
          return status(400, { message: "Contact not found" });
        }
      }

      return tx
        .update(workspaces)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.clientId !== undefined && {
            clientId: body.clientId,
          }),
          ...(body.reference !== undefined && {
            reference: body.reference,
          }),
          ...(body.billingReference !== undefined && {
            billingReference: body.billingReference,
          }),
          ...(body.color !== undefined && {
            color: body.color,
          }),
        })
        .where(eq(workspaces.id, workspaceId));
    });
  } catch (error) {
    // The unique index (workspaces_org_reference_uidx) enforces
    // reference uniqueness across the entire org, including
    // workspaces behind ethical walls that scopedDb can't see.
    if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
      return status(409, {
        message: "Reference already exists",
        code: "REFERENCE_TAKEN",
      });
    }
    throw error;
  }
};
