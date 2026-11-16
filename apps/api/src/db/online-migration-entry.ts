import type { RequiredMigrationIndex } from "../lib/db/migration-history";
import type {
  OnlineConstraintValidation,
  OnlineIndexDeclaration,
} from "./online-ddl";
import type {
  OnlineRepair,
  OnlineStepIntroduction,
} from "./online-migration-connection";

export type OnlineIndex = OnlineIndexDeclaration & {
  introducedBy: OnlineStepIntroduction;
};
export type OnlineIndexCutover = {
  introducedBy: string;
  final: RequiredMigrationIndex & { introducedBy: OnlineStepIntroduction };
  legacy: RequiredMigrationIndex;
  staged: OnlineIndex;
};
export type OnlineIndexReplacement = {
  introducedBy: OnlineStepIntroduction;
  legacyName: string;
  replacementNames: readonly string[];
};

/**
 * Whether a release still owes this entry's online work. `finalized` work
 * shipped in a promoted release and every database is expected to hold it;
 * `pending` work is newer and may still be building after a rollout.
 * `scripts/check-online-migration-lifecycle.ts` lets an entry be finalized only
 * once the promoted release carries it unchanged.
 */
export const ONLINE_LIFECYCLE = {
  pending: "pending",
  finalized: "finalized",
} as const;
export type OnlineLifecycle =
  (typeof ONLINE_LIFECYCLE)[keyof typeof ONLINE_LIFECYCLE];

/** Revisions sequence entry groups within each phase; ids and revisions remain stable. */
export type OnlineMigrationEntry = {
  id: string;
  revision: number;
  lifecycle: OnlineLifecycle;
} & (
  | { type: "indexes"; values: readonly OnlineIndex[] }
  | { type: "cutovers"; values: readonly OnlineIndexCutover[] }
  | { type: "replacements"; values: readonly OnlineIndexReplacement[] }
  | { type: "repairs"; values: readonly OnlineRepair[] }
  | { type: "constraints"; values: readonly OnlineConstraintValidation[] }
);
