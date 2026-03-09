import { and, eq, ne } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { adminDb, type ScopedDb } from "@/api/db";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";

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

  // Reference uniqueness check needs full org visibility.
  // Under RLS, scopedDb only sees the caller's workspaces;
  // a conflict in another workspace would be missed, causing
  // a 500 UNIQUE_VIOLATION instead of a 409.
  if (body.reference) {
    const [existing] = await adminDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, organizationId),
          eq(workspaces.reference, body.reference),
          ne(workspaces.id, workspaceId),
        ),
      )
      .limit(1);

    if (existing) {
      return status(409, {
        message: "Reference already exists",
        code: "REFERENCE_TAKEN",
      });
    }
  }

  return scopedDb(async (tx) => {
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
};
