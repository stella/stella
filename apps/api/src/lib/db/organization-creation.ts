import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import {
  ORGANIZATION_EVALUATION_LIMIT,
  ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE,
} from "@stll/api-contract/organization-create";

import { organization } from "@/api/db/auth-schema";
import { SETTING_USER_ID } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { accountAuditLogs } from "@/api/db/schema";
import { ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE } from "@/api/lib/audit-log.constants";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { createBackgroundAuditRecorder } from "@/api/lib/db/audit-recording";
import type { AccountAuditEvent } from "@/api/lib/db/audit-recording";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export type OrganizationEvaluation = "grant" | "none";

type OrganizationCreationOptions = {
  /** The account that owns the new organization and holds its evaluation grant. */
  userId: SafeId<"user">;
  evaluation: OrganizationEvaluation;
};

/** Holds the account lock until the owning creation records its grant and commits. */
const claimOrganizationEvaluation = async (
  tx: Transaction,
  userId: SafeId<"user">,
): Promise<boolean> => {
  await withAggregateLock({
    tx,
    aggregate: "account",
    id: userId,
    mode: "no key update",
  });
  // FORCE RLS also binds owner reads to the authenticated account.
  await tx.execute(sql`SELECT set_config(${SETTING_USER_ID}, ${userId}, true)`);
  const granted = await readBounded(
    tx
      .select({ id: accountAuditLogs.id })
      .from(accountAuditLogs)
      .where(
        and(
          eq(accountAuditLogs.userId, userId),
          eq(
            accountAuditLogs.eventType,
            ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
          ),
        ),
      ),
    ORGANIZATION_EVALUATION_LIMIT - 1,
  );
  switch (granted.type) {
    case "complete":
      return true;
    case "overflow":
      return false;
    default:
      granted satisfies never;
      return panic("Unhandled organization evaluation audit count");
  }
};

/** The lifetime evaluation limit refuses before any organization row is written. */
const admitOrganizationCreation = async (
  tx: Transaction,
  { userId, evaluation }: OrganizationCreationOptions,
): Promise<Result<void, HandlerError>> => {
  switch (evaluation) {
    case "grant":
      if (await claimOrganizationEvaluation(tx, userId)) {
        return Result.ok();
      }
      return Result.err(
        new HandlerError({
          status: 403,
          code: ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE,
          message: `This account has used all ${ORGANIZATION_EVALUATION_LIMIT} lifetime organization evaluation periods.`,
          hint: "Use an existing organization or contact support to arrange paid access. Deleting an organization does not restore an evaluation period.",
        }),
      );
    case "none":
      return Result.ok();
    default:
      evaluation satisfies never;
      return panic("Unhandled organization evaluation request");
  }
};

/** Evaluation grants stay in immutable account history when organizations are deleted. */
const organizationCreationEvents = (
  organizationId: SafeId<"organization">,
  evaluation: OrganizationEvaluation,
): AccountAuditEvent[] => {
  const created = {
    type: "organization.created",
    resourceId: organizationId,
  } satisfies AccountAuditEvent;
  switch (evaluation) {
    case "grant":
      return [
        created,
        {
          type: ORGANIZATION_EVALUATION_STARTED_EVENT_TYPE,
          resourceId: organizationId,
        },
      ];
    case "none":
      return [created];
    default:
      evaluation satisfies never;
      return panic("Unhandled organization evaluation grant");
  }
};

/**
 * The owner of new organization rows written by the organization plugin. The
 * account lock, the evaluation grant, the plugin's create and the account
 * creation audit share the caller's transaction: a refused grant runs no
 * create, and a failed create records no grant. Callers abort their
 * transaction on any error this returns.
 */
export const createOrganizationWithEvaluation = async <
  T extends { organizationId: SafeId<"organization"> },
  E,
>(
  tx: Transaction,
  options: OrganizationCreationOptions,
  create: () => Promise<Result<T, E>>,
): Promise<Result<T, E | HandlerError>> => {
  const admitted = await admitOrganizationCreation(tx, options);
  if (admitted.isErr()) {
    return Result.err(admitted.error);
  }
  const created = await create();
  if (created.isErr()) {
    return Result.err(created.error);
  }
  const recordAuditEvent = createBackgroundAuditRecorder({
    account: { userId: options.userId },
  });
  await recordAuditEvent(
    tx,
    organizationCreationEvents(
      created.value.organizationId,
      options.evaluation,
    ),
  );
  return Result.ok(created.value);
};

type FixedOrganizationOptions = OrganizationCreationOptions & {
  organization: typeof organization.$inferInsert & {
    id: SafeId<"organization">;
  };
};

/**
 * The owner of fixed-id organization rows that system provisioning writes
 * directly, with the same grant, refusal and account audit as
 * `createOrganizationWithEvaluation`. Callers abort their transaction on any
 * error this returns.
 */
export const insertOrganizationWithEvaluation = async (
  tx: Transaction,
  { organization: row, ...options }: FixedOrganizationOptions,
): Promise<
  Result<{ organizationId: SafeId<"organization"> }, HandlerError>
> => {
  const admitted = await admitOrganizationCreation(tx, options);
  if (admitted.isErr()) {
    return Result.err(admitted.error);
  }
  await tx.insert(organization).values(row);
  const recordAuditEvent = createBackgroundAuditRecorder({
    account: { userId: options.userId },
  });
  await recordAuditEvent(
    tx,
    organizationCreationEvents(row.id, options.evaluation),
  );
  return Result.ok({ organizationId: row.id });
};
