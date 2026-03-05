import { Result } from "better-result";
import { count, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { workspaceContacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const WORKSPACE_CONTACT_ROLES = [
  "opposing_party",
  "opposing_counsel",
  "co_counsel",
  "witness",
  "expert_witness",
  "third_party",
  "judge",
  "mediator",
  "other",
] as const;

export const createWorkspaceContactBodySchema = t.Object({
  contactId: tNanoid,
  role: t.UnionEnum(WORKSPACE_CONTACT_ROLES),
  isPrimary: t.Optional(t.Boolean()),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

type CreateWorkspaceContactBody = Static<
  typeof createWorkspaceContactBodySchema
>;

type CreateWorkspaceContactHandlerProps = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  body: CreateWorkspaceContactBody;
};

export const createWorkspaceContactHandler = async ({
  workspaceId,
  organizationId,
  body,
}: CreateWorkspaceContactHandlerProps) => {
  const contact = await db.query.contacts.findFirst({
    where: {
      id: body.contactId,
      organizationId: { eq: organizationId },
    },
    columns: { id: true },
  });

  if (!contact) {
    return status(400, {
      message: "Contact not found",
    });
  }

  const [existing] = await db
    .select({ count: count() })
    .from(workspaceContacts)
    .where(eq(workspaceContacts.workspaceId, workspaceId));

  if (existing && existing.count >= LIMITS.workspaceContactsCount) {
    return status(400, {
      message: "Workspace contacts limit reached",
    });
  }

  const result = await Result.tryPromise({
    try: () =>
      db
        .insert(workspaceContacts)
        .values({
          organizationId,
          workspaceId,
          contactId: body.contactId,
          role: body.role,
          isPrimary: body.isPrimary ?? false,
          notes: body.notes ?? null,
        })
        .returning(),
    catch: (error) => error,
  });

  if (result.isErr()) {
    if (isPgError(result.error, PG_ERROR.UNIQUE_VIOLATION)) {
      return status(409, {
        message: "Contact already has this role on the matter",
      });
    }
    throw result.error;
  }

  const [created] = result.value;
  return created;
};
