import { Result, panic } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { WORKSPACE_CONTACT_ROLES } from "@stll/api-contract";
import { MATTER_CONTACT_CAPACITY_CODE } from "@stll/api-contract/workspace-contacts";

import type { SafeDb } from "@/api/db/safe-db";
import { workspaceContacts } from "@/api/db/schema";
import { workspaceContactRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";

const createWorkspaceContactBodySchema = t.Object({
  contactId: tSafeId("contact", {
    description: "Contact ID: with role to link the contact",
  }),
  role: t.UnionEnum(WORKSPACE_CONTACT_ROLES, {
    description: "Party role for the linked contact",
  }),
  isPrimary: t.Optional(t.Boolean()),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const config = {
  description:
    "Link a contact to a matter in a party role (opposing party/counsel, " +
    "co-counsel, witness, expert witness, third party, judge, mediator, or " +
    "other). Pass contactId with role to link. When the matter reaches its " +
    "contact limit, remove an existing contact link before adding another.",
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: workspaceContactRealtimeUpdates,
  mcp: { type: "tool", name: "link_matter_contact" },
  body: createWorkspaceContactBodySchema,
} satisfies WorkspaceHandlerConfig;

const WORKSPACE_CONTACT_CAPACITY_CONSTRAINT =
  "workspace_contacts_workspace_capacity";
const CONTACT_CAPACITY_REFUSAL = {
  status: 400,
  code: MATTER_CONTACT_CAPACITY_CODE.reached,
  retryable: false,
  hint: "CLI: call matters.contacts.delete with matterId and matterContactId. MCP: call link_matter_contact with matter_id and matter_contact_id (without role). Then link the new contact.",
  message:
    "This matter has reached its contact limit. Remove a contact link before adding another.",
} as const;

export type CreateWorkspaceContactHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof createWorkspaceContactBodySchema>;
  dependencies?: {
    flushWorkspaceSearchRepairs: typeof flushWorkspaceSearchRepairs;
  };
};

// Shared matter-contact link logic reused by the HTTP handler and the
// `link_matter_contact` MCP tool, so both emit identical audit events
// and search-index writes.
export const createWorkspaceContactHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  recordAuditEvent,
  body,
  dependencies = { flushWorkspaceSearchRepairs },
}: CreateWorkspaceContactHandlerProps) {
  const txResult = await safeDb(async (tx) => {
    // The parent matter lock precedes the contact count and insert, matching
    // matter members and entity capacity.
    await lockWorkspacesForEntityCap(tx, [workspaceId]);
    const contact = await tx.query.contacts.findFirst({
      where: {
        id: { eq: body.contactId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true },
    });

    if (!contact) {
      return {
        ok: false as const,
        status: 400 as const,
        message: "Contact not found",
      };
    }

    const existing = await tx.query.workspaceContacts.findFirst({
      where: {
        organizationId: { eq: organizationId },
        workspaceId: { eq: workspaceId },
        contactId: { eq: body.contactId },
        role: { eq: body.role },
      },
      columns: { id: true },
    });
    if (existing) {
      return {
        ok: false as const,
        status: 409 as const,
        message: "Contact already has this role on the matter",
      };
    }

    const linkCount = await tx.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, workspaceId),
    );
    if (linkCount >= LIMITS.workspaceContactsCount) {
      return {
        ok: false as const,
        ...CONTACT_CAPACITY_REFUSAL,
      };
    }

    const [created] = await tx
      .insert(workspaceContacts)
      .values({
        organizationId,
        workspaceId,
        contactId: body.contactId,
        role: body.role,
        isPrimary: body.isPrimary ?? false,
        notes: body.notes ?? null,
      })
      .returning();

    if (created) {
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE_CONTACT,
        resourceId: created.id,
        changes: {
          created: {
            old: null,
            new: {
              contactId: created.contactId,
              role: created.role,
              isPrimary: created.isPrimary,
            },
          },
        },
      });
    }

    // The matter folds each party's name into its searchable text, so adding
    // one changes the matter's projection, not the contact's.
    await enqueueWorkspaceSearchRepairs(tx, [workspaceId]);

    return { ok: true as const, created };
  });

  if (Result.isError(txResult)) {
    if (
      DatabaseError.is(txResult.error) &&
      txResult.error.code === PG_ERROR.UNIQUE_VIOLATION
    ) {
      return yield* Result.err(
        new HandlerError({
          status: 409,
          message: "Contact already has this role on the matter",
        }),
      );
    }
    if (
      isPgConstraintError(
        txResult.error,
        PG_ERROR.CHECK_VIOLATION,
        WORKSPACE_CONTACT_CAPACITY_CONSTRAINT,
      )
    ) {
      return yield* Result.err(new HandlerError(CONTACT_CAPACITY_REFUSAL));
    }
    return yield* Result.err(txResult.error);
  }

  if (!txResult.value.ok) {
    return yield* Result.err(
      new HandlerError({
        status: txResult.value.status,
        message: txResult.value.message,
        ...("code" in txResult.value
          ? {
              code: txResult.value.code,
              retryable: txResult.value.retryable,
              hint: txResult.value.hint,
            }
          : {}),
      }),
    );
  }

  dependencies.flushWorkspaceSearchRepairs([workspaceId]).catch(captureError);

  const created = txResult.value.created;
  if (!created) {
    panic("Failed to create workspace contact");
  }

  return Result.ok(created);
};

const createWorkspaceContact = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    return yield* createWorkspaceContactHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default createWorkspaceContact;
