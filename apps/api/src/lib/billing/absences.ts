import { panic, Result } from "better-result";
import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import { t } from "elysia";

import { ABSENCE_KINDS } from "@stll/api-contract";
import { isOrganizationManagementRole } from "@stll/permissions";
import { parsePlainDate } from "@stll/time";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { absences } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { formatTodayInTimeZone } from "@/api/lib/timezone";

export const requestAbsenceBodySchema = t.Object(
  {
    kind: t.UnionEnum(ABSENCE_KINDS),
    startDate: t.String({ format: "date" }),
    endDate: t.String({ format: "date", description: "Exclusive end date" }),
    timezoneId: t.String({ minLength: 1, maxLength: 64 }),
    coverage: t.Union([
      t.Object({ type: t.Literal("full") }, { additionalProperties: false }),
      t.Object(
        {
          type: t.Literal("half"),
          segment: t.Union([t.Literal("morning"), t.Literal("afternoon")]),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

const validateAbsenceRange = (body: typeof requestAbsenceBodySchema.static) => {
  const start = parsePlainDate(body.startDate);
  const end = parsePlainDate(body.endDate);
  if (!start || !end || body.startDate >= body.endDate) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Absence requires a positive calendar date range",
      }),
    );
  }
  if (
    body.coverage.type === "half" &&
    start.add({ days: 1 }).toString() !== body.endDate
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Half-day absence requires exactly one calendar day",
      }),
    );
  }
  return formatTodayInTimeZone({ timezoneId: body.timezoneId });
};

// All absence mutations acquire the owner lock before a row lock. Distinct requests
// for the same person therefore cannot both approve an overlapping period.
type AbsenceOwnerLockOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
const lockAbsenceOwner = async ({
  tx,
  organizationId,
  userId,
}: AbsenceOwnerLockOptions) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`absence:${organizationId}:${userId}`}))`,
  );
};

type RequestAbsenceOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: typeof requestAbsenceBodySchema.static;
  recordAuditEvent: AuditRecorder;
};
export const requestAbsence = async ({
  safeDb,
  organizationId,
  userId,
  body,
  recordAuditEvent,
}: RequestAbsenceOptions) =>
  await Result.gen(async function* () {
    yield* validateAbsenceRange(body);
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const [membership] = await tx
          .select({ id: member.id })
          .from(member)
          .where(
            and(
              eq(member.organizationId, organizationId),
              eq(member.userId, userId),
            ),
          )
          .limit(1)
          .for("share");
        if (!membership) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Organization membership is required",
            }),
          );
        }
        await lockAbsenceOwner({ tx, organizationId, userId });
        const [usage] = await tx
          .select({ count: count() })
          .from(absences)
          .where(
            and(
              eq(absences.organizationId, organizationId),
              eq(absences.userId, userId),
            ),
          );
        if (!usage) {
          return panic("Absence capacity query returned no row");
        }
        if (usage.count >= LIMITS.absencesPerUser) {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Absence history limit reached",
              hint: "Contact an organization administrator before requesting more absences.",
            }),
          );
        }
        const [created] = await tx
          .insert(absences)
          .values({
            organizationId,
            userId,
            kind: body.kind,
            startDate: body.startDate,
            endDate: body.endDate,
            timezoneId: body.timezoneId,
            coverage: body.coverage.type,
            halfDaySegment:
              body.coverage.type === "half" ? body.coverage.segment : null,
          })
          .returning({ id: absences.id, version: absences.version });
        if (!created) {
          return panic("Absence insert returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ABSENCE,
          resourceId: created.id,
          workspaceId: null,
        });
        return Result.ok({ ...created, status: "requested" as const });
      }),
    );
    return outcome;
  });

const absenceNotFound = () =>
  new HandlerError({
    status: 404,
    message: "Absence not found",
    hint: "List your absences or the approval queue before selecting an absence ID.",
  });
const absenceConflict = (message: string) =>
  new HandlerError({
    status: 409,
    message,
    hint: "Refresh the absence and retry with its current version.",
  });

type TransitionAbsenceOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  id: SafeId<"absence">;
  body:
    | { version: number; action: "approve"; comment?: string }
    | { version: number; action: "reject"; comment: string }
    | { version: number; action: "cancel" };
  recordAuditEvent: AuditRecorder;
};

const ABSENCE_TRANSITION_STATUSES = {
  approve: "approved",
  reject: "rejected",
  cancel: "cancelled",
} as const satisfies Record<
  TransitionAbsenceOptions["body"]["action"],
  (typeof absences.$inferSelect)["status"]
>;

const approvedOverlap = async (
  tx: Transaction,
  entry: typeof absences.$inferSelect,
) => {
  if (!entry.userId) {
    return false;
  }
  const matches = await tx
    .select({ id: absences.id })
    .from(absences)
    .where(
      and(
        eq(absences.organizationId, entry.organizationId),
        eq(absences.userId, entry.userId),
        eq(absences.status, "approved"),
        lt(absences.startDate, entry.endDate),
        gt(absences.endDate, entry.startDate),
        // Opposite halves of the same day occupy disjoint capacity.
        entry.coverage === "half"
          ? sql`(${absences.coverage} = 'full' OR ${absences.halfDaySegment} = ${entry.halfDaySegment})`
          : undefined,
      ),
    )
    .limit(1);
  return matches.length > 0;
};

export const transitionAbsence = async ({
  safeDb,
  organizationId,
  actorUserId,
  memberRole,
  id,
  body,
  recordAuditEvent,
}: TransitionAbsenceOptions) =>
  await Result.gen(async function* () {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // Membership locks drain identity-bearing writers before account erasure.
        const [membership] = await tx
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.organizationId, organizationId),
              eq(member.userId, actorUserId),
            ),
          )
          .limit(1)
          .for("share");
        if (!membership) {
          return Result.err(
            new HandlerError({
              status: 403,
              message: "Organization membership is required",
            }),
          );
        }
        const manager =
          isOrganizationManagementRole(memberRole.role) &&
          isOrganizationManagementRole(membership.role);
        if (body.action !== "cancel" && !manager) {
          return Result.err(
            new HandlerError({
              status: 403,
              message:
                "Only an organization owner or administrator may decide absences",
            }),
          );
        }
        const scope = and(
          eq(absences.organizationId, organizationId),
          eq(absences.id, id),
        );
        const [initial] = await tx
          .select()
          .from(absences)
          .where(scope)
          .limit(1);
        if (
          !initial ||
          (body.action === "cancel" && initial.userId !== actorUserId)
        ) {
          return Result.err(absenceNotFound());
        }
        if (!initial.userId) {
          return Result.err(
            absenceConflict("An anonymized absence cannot be decided"),
          );
        }
        await lockAbsenceOwner({ tx, organizationId, userId: initial.userId });
        const [entry] = await tx
          .select()
          .from(absences)
          .where(scope)
          .limit(1)
          .for("update");
        if (!entry || entry.userId !== initial.userId) {
          return Result.err(absenceNotFound());
        }
        if (entry.version !== body.version) {
          return Result.err(absenceConflict("Absence version changed"));
        }
        if (entry.status !== "requested") {
          return Result.err(
            absenceConflict(
              "Only requested absences may be decided or cancelled",
            ),
          );
        }
        if (body.action === "reject" && !body.comment.trim()) {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Rejection requires a comment",
            }),
          );
        }
        if (body.action === "approve" && (await approvedOverlap(tx, entry))) {
          return Result.err(
            absenceConflict("Absence overlaps an approved absence"),
          );
        }
        const status = ABSENCE_TRANSITION_STATUSES[body.action];
        const [changed] = await tx
          .update(absences)
          .set({
            status,
            version: entry.version + 1,
            approverUserId: body.action === "cancel" ? null : actorUserId,
            decidedAt: new Date(),
            decisionComment:
              body.action === "cancel" ? null : body.comment?.trim() || null,
            updatedAt: new Date(),
          })
          .where(and(scope, eq(absences.version, body.version)))
          .returning({
            id: absences.id,
            status: absences.status,
            version: absences.version,
          });
        if (!changed) {
          return panic("Locked absence update returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ABSENCE,
          resourceId: id,
          workspaceId: null,
          changes: { status: { old: entry.status, new: status } },
        });
        return Result.ok(changed);
      }),
    );
    return outcome;
  });
