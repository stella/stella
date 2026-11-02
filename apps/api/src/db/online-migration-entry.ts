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

/** Revisions sequence entry groups within each phase; ids and revisions remain stable. */
export type OnlineMigrationEntry = { id: string; revision: number } & (
  | { type: "indexes"; values: readonly OnlineIndex[] }
  | { type: "cutovers"; values: readonly OnlineIndexCutover[] }
  | { type: "replacements"; values: readonly OnlineIndexReplacement[] }
  | { type: "repairs"; values: readonly OnlineRepair[] }
  | { type: "constraints"; values: readonly OnlineConstraintValidation[] }
);
