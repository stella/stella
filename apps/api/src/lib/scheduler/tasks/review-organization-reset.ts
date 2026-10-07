import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { RlsDatabase } from "@/api/db/scoped";
import { readReviewOrganizationConfig } from "@/api/lib/review-organization/config";
import type { ReviewOrganizationConfig } from "@/api/lib/review-organization/config";
import {
  REVIEW_RESET_REFUSAL,
  resetReviewOrganization,
} from "@/api/lib/review-organization/reset";
import type {
  ReviewResetDependencies,
  ReviewResetReport,
} from "@/api/lib/review-organization/reset";
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import type { SystemAuditCounts } from "@/api/lib/system-audit/actors";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const RESET_REVIEW_ORGANIZATION_TASK =
  "reviewOrganization.reset" as const;

const REPORTED_FAILURES_MAX = 20;

/** What one reset run did, as the counts its system audit row records. */
export const reviewResetAuditCounts = (
  report: ReviewResetReport,
): SystemAuditCounts<"system:review-organization-reset"> => {
  const seeded = Result.isOk(report.seed) ? report.seed.value : null;
  return {
    deletedMatters: report.deleted.matters,
    deletedContacts: report.deleted.contacts,
    deletedClauses: report.deleted.clauses,
    deletedTemplates: report.deleted.templates,
    deletedPlaybooks: report.deleted.playbooks,
    sweptRows: [...report.swept.values()].reduce(
      (total, rows) => total + rows,
      0,
    ),
    failedDeletes: report.failures.length,
    seededContacts: seeded?.contacts.created ?? 0,
    seededMatters: seeded?.matters.created ?? 0,
    seededDocuments: seeded?.documents.created ?? 0,
    seededTasks: seeded?.tasks.created ?? 0,
    seededTimeEntries: seeded?.timeEntries.created ?? 0,
    seededClauses: seeded?.clauses.created ?? 0,
    seededTemplates: seeded?.templates.created ?? 0,
    seededPlaybooks: seeded?.playbooks.created ?? 0,
    seededRateTables: seeded?.rateTables.created ?? 0,
    enabledTimeBilling: seeded?.enrolments.created ?? 0,
    seedFailed: seeded === null ? 1 : 0,
  };
};

type ReviewResetTask = (
  context: SchedulerTaskContext,
) => Promise<Result<void, SchedulerTaskFailure>>;

type ReviewResetTaskOptions = {
  readConfig?: () => ReviewOrganizationConfig | null;
  dependencies?: ReviewResetDependencies | undefined;
  /** The application-role connection; the shared pool when omitted. */
  rlsDatabase?: RlsDatabase<Transaction> | undefined;
};

/**
 * Nightly: wipe the restricted review organization and seed its sample data
 * again. A deployment without a review organization runs nothing. Every
 * deleted or seeded row is in the organization's audit log under this run;
 * the run's totals go to the system audit, and any row that failed fails the
 * run with its id and reason.
 */
export const createResetReviewOrganizationTask =
  ({
    readConfig = readReviewOrganizationConfig,
    dependencies,
    rlsDatabase,
  }: ReviewResetTaskOptions = {}): ReviewResetTask =>
  async ({ db, runId, signal, logger }) => {
    const config = readConfig();
    if (config === null) {
      logger.debug("scheduler.review_organization_reset.unconfigured");
      return Result.ok(undefined);
    }
    const outcome = await resetReviewOrganization({
      config,
      db,
      rlsDatabase,
      runId,
      signal,
      dependencies,
    });
    if (Result.isError(outcome)) {
      if (outcome.error.reason === REVIEW_RESET_REFUSAL.unconfigured) {
        return Result.ok(undefined);
      }
      return Result.err(
        new SchedulerTaskFailure({
          message: `Review organization reset refused: ${outcome.error.reason}`,
          cause: outcome.error,
        }),
      );
    }
    const report = outcome.value;
    const counts = reviewResetAuditCounts(report);
    await recordSystemAudit(db, "system:review-organization-reset", {
      subject: runId,
      counts,
    });
    logger.info("scheduler.review_organization_reset", { ...counts });
    if (Result.isError(report.seed)) {
      return Result.err(
        new SchedulerTaskFailure({
          message: `Review organization seed failed at ${report.seed.error.item}`,
          cause: report.seed.error,
        }),
      );
    }
    if (report.failures.length > 0) {
      // The organization's audit log holds every row; the run error names
      // the first few so the scheduler log points at them.
      const listed = report.failures
        .slice(0, REPORTED_FAILURES_MAX)
        .map(({ kind, id, reason }) => `${kind} ${id}: ${reason}`)
        .join("; ");
      return Result.err(
        new SchedulerTaskFailure({
          message: `Review organization reset left ${report.failures.length} row(s): ${listed}`,
          cause: report.failures,
        }),
      );
    }
    return Result.ok(undefined);
  };

export const resetReviewOrganizationTask = createResetReviewOrganizationTask();
