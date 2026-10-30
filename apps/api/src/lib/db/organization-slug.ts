import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { runWithOrganizationSlugUpdate } from "@/api/lib/auth/organization-slug-update-scope";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockMemberAccessRow,
  withAggregateParentBatch,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import {
  hasMemberPermission,
  withCurrentMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";

// Migrated databases use PostgreSQL's inline UNIQUE name; schema-sync databases
// use Drizzle's name. Both also have the explicitly named unique index.
const SLUG_UNIQUE_CONSTRAINTS = [
  "organization_slug_key",
  "organization_slug_unique",
  "organization_slug_uidx",
] as const;

const updatedOrganizationSchema = v.object({ slug: v.string() });
const slugConflict = () =>
  new HandlerError({
    status: 409,
    code: "organization_slug_conflict",
    message:
      "This organization slug is already taken. Choose another slug or use the opaque option.",
  });

type ChangeOrganizationSlugOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  slug: string;
  recordAuditEvent: AuditRecorder;
};

/** Auth tables deny application writes; the owner transaction binds the plugin write and audit. */
const changeOrganizationSlugInTransaction = async (
  tx: Transaction,
  {
    organizationId,
    userId,
    memberRole,
    slug,
    recordAuditEvent,
  }: ChangeOrganizationSlugOptions,
) => {
  await withAggregateParentBatch({
    tx,
    organizationIds: [organizationId],
    mode: "update",
  });
  const current = (
    await tx
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
  ).at(0);
  const membership = await lockMemberAccessRow({
    tx,
    organizationId,
    userId,
    mode: "share",
  });
  if (
    !current ||
    !membership ||
    !isMemberRole(membership.role) ||
    !hasMemberPermission(withCurrentMemberRole(memberRole, membership.role), {
      organization: ["update"],
    })
  ) {
    return abortTransaction(
      new HandlerError({
        status: 403,
        message: "Only organization owners and admins may change its slug.",
      }),
    );
  }
  const actor = (
    await tx
      .select({ user })
      .from(user)
      .innerJoin(
        member,
        and(
          eq(member.userId, user.id),
          eq(member.organizationId, organizationId),
        ),
      )
      .where(eq(user.id, userId))
      .limit(1)
  ).at(0);
  if (!actor) {
    return abortTransaction(
      new HandlerError({
        status: 401,
        message: "The account is no longer available.",
      }),
    );
  }
  const auth = getAuth();
  // This server-only endpoint receives the already authenticated principal, not a
  // new credential. Its adapter stays inside the transaction; organization hooks run.
  const context = {
    ...(await auth.$context),
    adapter: drizzleAdapter(tx, AUTH_DATABASE_ADAPTER_OPTIONS)(auth.options),
    getSession: async () =>
      await Promise.resolve({
        user: actor.user,
        session: { activeOrganizationId: organizationId },
      }),
  };
  const updated: unknown = await runWithOrganizationSlugUpdate(
    { organizationId, userId, slug },
    async () =>
      await auth.organizationUpdateEndpoint({
        headers: new Headers(),
        context,
        body: { organizationId, data: { slug } },
      }),
  );
  const result = v.parse(updatedOrganizationSchema, updated);
  if (current.slug !== result.slug) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      changes: { slug: { old: current.slug, new: result.slug } },
    });
  }
  return result;
};

export const changeOrganizationSlug = async (
  options: ChangeOrganizationSlugOptions,
) =>
  await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(
        rootDb,
        async (tx) => await changeOrganizationSlugInTransaction(tx, options),
      ),
    catch: (cause: unknown) => {
      if (HandlerError.is(cause)) {
        return cause;
      }
      if (
        (cause instanceof APIError &&
          cause.body?.code === "ORGANIZATION_SLUG_ALREADY_TAKEN") ||
        SLUG_UNIQUE_CONSTRAINTS.some((constraint) =>
          isPgConstraintError(cause, PG_ERROR.UNIQUE_VIOLATION, constraint),
        )
      ) {
        return slugConflict();
      }
      return new HandlerError({
        status: 500,
        message: "Could not change the organization slug.",
        cause,
      });
    },
  });
