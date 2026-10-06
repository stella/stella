/**
 * The time-billing part of the review organization's sample data: the
 * account's enrolment, each matter's default rate table and fallback rate,
 * and the matters' time entries. Every entry point here admits itself on the
 * deployment's time-billing feature first, so the reset runs everywhere and a
 * deployment without time billing simply gets no time-billing sample data.
 * The feature registry declares this module as time billing's admitted
 * dispatch owner.
 */
import { Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";

import {
  featureEnrolments,
  rateEntries,
  rateTables,
  timeEntries,
} from "@/api/db/schema";
import { enrolFeatureHandler } from "@/api/handlers/organization-settings/feature-enrolments/enrol";
import { createRateTableHandler } from "@/api/handlers/rates/create";
import { createRateEntryHandler } from "@/api/handlers/rates/entries/create";
import { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { inOrder } from "@/api/lib/review-organization/in-order";
import { SAMPLE_RATE_TABLE } from "@/api/lib/review-organization/sample-data";
import { seedError } from "@/api/lib/review-organization/seed-common";
import type {
  MatterStep,
  ReviewSeedActor,
  ReviewSeedCounts,
  ReviewSeedDependencies,
  ReviewSeedError,
} from "@/api/lib/review-organization/seed-common";

/** Whether this deployment offers time billing at all. */
const timeBillingAdmitted = () =>
  isDeploymentFeatureEnabled("FEATURE_TIME_BILLING");

const TIME_BILLING_FEATURE_ID = "time-billing";

/** The matter's default rate table, created when it has none. */
const ensureDefaultRateTable = async ({
  actor,
  workspaceId,
  counts,
}: MatterStep): Promise<Result<SafeId<"rateTable">, ReviewSeedError>> => {
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ id: rateTables.id })
      .from(rateTables)
      .where(
        and(
          eq(rateTables.workspaceId, workspaceId),
          eq(rateTables.isDefault, true),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("rate table", existing.error));
  }
  const table = existing.value.at(0);
  if (table !== undefined) {
    counts.rateTables.existing += 1;
    return Result.ok(table.id);
  }
  const created = await Result.gen(() =>
    createRateTableHandler({
      safeDb: actor.safeDb,
      organizationId: actor.organizationId,
      workspaceId,
      body: {
        name: SAMPLE_RATE_TABLE.name,
        currency: SAMPLE_RATE_TABLE.currency,
        isDefault: true,
      },
      recordAuditEvent: actor.recorderFor(workspaceId),
    }),
  );
  if (Result.isError(created)) {
    return Result.err(seedError("rate table", created.error));
  }
  counts.rateTables.created += 1;
  return Result.ok(created.value.id);
};

/**
 * A default rate table with a fallback rate per matter, through the same
 * writers the rate settings use, so sample time entries are billable as the
 * product's default entry is. The table and its fallback rate are ensured
 * separately, so a run that stopped between the two completes on the next.
 */
const seedRateTable = async (
  step: MatterStep,
): Promise<Result<void, ReviewSeedError>> => {
  const { actor, workspaceId, counts } = step;
  const table = await ensureDefaultRateTable(step);
  if (Result.isError(table)) {
    return table;
  }
  const rateTableId = table.value;
  const fallback = await actor.safeDb((tx) =>
    tx
      .select({ id: rateEntries.id })
      .from(rateEntries)
      .where(
        and(
          eq(rateEntries.rateTableId, rateTableId),
          isNull(rateEntries.userId),
          isNull(rateEntries.role),
        ),
      )
      .limit(1),
  );
  if (Result.isError(fallback)) {
    return Result.err(seedError("rate entry", fallback.error));
  }
  if (fallback.value.length > 0) {
    counts.rateEntries.existing += 1;
    return Result.ok(undefined);
  }
  const entry = await Result.gen(() =>
    createRateEntryHandler({
      safeDb: actor.safeDb,
      workspaceId,
      session: { activeOrganizationId: actor.organizationId },
      params: { rateTableId },
      body: {
        hourlyRate: SAMPLE_RATE_TABLE.hourlyRateMinor,
        effectiveFrom: SAMPLE_RATE_TABLE.effectiveFrom,
      },
      recordAuditEvent: actor.recorderFor(workspaceId),
    }),
  );
  if (Result.isError(entry)) {
    return Result.err(seedError("rate entry", entry.error));
  }
  counts.rateEntries.created += 1;
  return Result.ok(undefined);
};

/**
 * Turn on time billing for the review account through the self-serve toggle
 * the settings page uses.
 */
const seedTimeBilling = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
): Promise<Result<void, ReviewSeedError>> => {
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ featureId: featureEnrolments.featureId })
      .from(featureEnrolments)
      .where(
        and(
          eq(featureEnrolments.organizationId, actor.organizationId),
          eq(featureEnrolments.userId, actor.userId),
          eq(featureEnrolments.featureId, TIME_BILLING_FEATURE_ID),
        ),
      )
      .limit(1),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("time billing", existing.error));
  }
  if (existing.value.length > 0) {
    counts.enrolments.existing += 1;
    return Result.ok(undefined);
  }
  const enrolled = await Result.gen(() =>
    enrolFeatureHandler({
      safeDb: actor.safeDb,
      organizationId: actor.organizationId,
      userId: actor.userId,
      featureId: TIME_BILLING_FEATURE_ID,
      recordAuditEvent: actor.recorderFor(null),
    }),
  );
  if (Result.isError(enrolled)) {
    return Result.err(seedError("time billing", enrolled.error));
  }
  counts.enrolments.created += 1;
  return Result.ok(undefined);
};

const SAMPLE_TIME_ZONE = "Europe/Prague";

const seedTimeEntries = async ({
  actor,
  workspaceId,
  matter,
  counts,
}: MatterStep): Promise<Result<void, ReviewSeedError>> => {
  const narratives = matter.timeEntries.map(({ narrative }) => narrative);
  const existing = await actor.safeDb((tx) =>
    tx
      .select({ narrative: timeEntries.narrative })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, actor.organizationId),
          eq(timeEntries.workspaceId, workspaceId),
          inArray(timeEntries.narrative, narratives),
        ),
      )
      .limit(narratives.length),
  );
  if (Result.isError(existing)) {
    return Result.err(seedError("time entries", existing.error));
  }
  const existingNarratives = new Set(
    existing.value.map(({ narrative }) => narrative),
  );
  return await inOrder(matter.timeEntries, async (entry) => {
    if (existingNarratives.has(entry.narrative)) {
      counts.timeEntries.existing += 1;
      return Result.ok(undefined);
    }
    const created = await Result.gen(() =>
      createTimeEntryHandler({
        safeDb: actor.safeDb,
        organizationId: actor.organizationId,
        workspaceId,
        userId: actor.userId,
        memberRole: actor.memberAuthority,
        recordAuditEvent: actor.recorderFor(workspaceId),
        body: {
          dateWorked: entry.dateWorked,
          timezoneId: SAMPLE_TIME_ZONE,
          durationMinutes: entry.durationMinutes,
          narrative: entry.narrative,
        },
      }),
    );
    if (Result.isError(created)) {
      return Result.err(seedError("time entry", created.error));
    }
    counts.timeEntries.created += 1;
    return Result.ok(undefined);
  });
};

const admitted = (dependencies: ReviewSeedDependencies) =>
  (dependencies.timeBillingAdmitted ?? timeBillingAdmitted)();

/** Turn on time billing for the review account, where the deployment has it. */
export const seedTimeBillingEnrolment = async (
  actor: ReviewSeedActor,
  counts: ReviewSeedCounts,
  dependencies: ReviewSeedDependencies,
): Promise<Result<void, ReviewSeedError>> =>
  admitted(dependencies)
    ? await seedTimeBilling(actor, counts)
    : Result.ok(undefined);

/**
 * One matter's rate table, fallback rate and time entries, where the
 * deployment has time billing. The rate table comes before the entries it
 * prices.
 */
export const seedMatterTimeBilling = async (
  step: MatterStep,
): Promise<Result<void, ReviewSeedError>> =>
  admitted(step.dependencies)
    ? await inOrder(
        [seedRateTable, seedTimeEntries],
        async (seedStep) => await seedStep(step),
      )
    : Result.ok(undefined);
