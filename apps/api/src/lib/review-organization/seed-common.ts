import { TaggedError } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { SampleMatter } from "@/api/lib/review-organization/sample-data";
import { brandDerivedSampleId } from "@/api/lib/safe-id-boundaries";

/** One sample item the seeder could not write. */
export class ReviewSeedError extends TaggedError("ReviewSeedError")<{
  message: string;
  item: string;
  cause: unknown;
}> {}

/**
 * The review account acting in its own organization. Every write goes through
 * the same handlers a member request or an MCP tool call uses, on a handle
 * scoped to this organization and this member, so row-level security confines
 * the seed exactly as it confines the account.
 */
export type ReviewSeedActor = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  userEmail: string;
  /** The account's authority, built where its membership was proved. */
  memberAuthority: AuthorizedMemberRole;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  /** The recorder for one matter, or for organization-level rows (null). */
  recorderFor: (workspaceId: SafeId<"workspace"> | null) => AuditRecorder;
};

export type ReviewSeedDependencies = {
  /** Side effects after a document is stored (extraction, derivatives). */
  documents?: CreateEntityFromBufferDependencies | undefined;
  /** Whether time billing is offered; the deployment flag when omitted. */
  timeBillingAdmitted?: (() => boolean) | undefined;
};

export type ReviewSeedKind =
  | "contacts"
  | "matters"
  | "documents"
  | "tasks"
  | "timeEntries"
  | "clauses"
  | "templates"
  | "playbooks"
  | "rateTables"
  | "rateEntries"
  | "enrolments";

/** Per kind: items this run wrote, and items an earlier run had written. */
export type ReviewSeedCounts = Record<
  ReviewSeedKind,
  { created: number; existing: number }
>;

export const emptyCounts = (): ReviewSeedCounts => ({
  contacts: { created: 0, existing: 0 },
  matters: { created: 0, existing: 0 },
  documents: { created: 0, existing: 0 },
  tasks: { created: 0, existing: 0 },
  timeEntries: { created: 0, existing: 0 },
  clauses: { created: 0, existing: 0 },
  templates: { created: 0, existing: 0 },
  playbooks: { created: 0, existing: 0 },
  rateTables: { created: 0, existing: 0 },
  rateEntries: { created: 0, existing: 0 },
  enrolments: { created: 0, existing: 0 },
});

/**
 * A stable id for one sample item in one organization, so a rerun finds what
 * an earlier run wrote instead of writing it twice.
 */
export const reviewSampleId = <T extends SafeIdType>(
  organizationId: SafeId<"organization">,
  key: string,
): SafeId<T> =>
  brandDerivedSampleId<T>(`review-organization:${organizationId}:${key}`);

export const seedError = (item: string, cause: unknown) =>
  new ReviewSeedError({
    message: `Could not seed the sample ${item}`,
    item,
    cause,
  });

/** One seeded matter, as each of its per-matter steps receives it. */
export type MatterStep = {
  actor: ReviewSeedActor;
  workspaceId: SafeId<"workspace">;
  matter: SampleMatter;
  dependencies: ReviewSeedDependencies;
  counts: ReviewSeedCounts;
};
