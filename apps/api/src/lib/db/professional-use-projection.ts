import type { userProfessionalUseAcceptances } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type AcceptanceRow = typeof userProfessionalUseAcceptances.$inferSelect;

/** The record of the account's own consent: what, which versions, and when. */
export const projectProfessionalUseAcceptanceForAccountExport = (
  row: AcceptanceRow,
) => ({
  statementVersion: row.statementVersion,
  termsVersion: row.termsVersion,
  acceptedAt: row.acceptedAt.toISOString(),
  source: row.source,
});

type AcceptanceAccountExport = ReturnType<
  typeof projectProfessionalUseAcceptanceForAccountExport
>;

// Columns intentionally left out of the account export.
const UNEXPORTED_ACCEPTANCE_COLUMNS = [
  // The exporting account itself; the record is its own.
  "userId",
] as const satisfies readonly (keyof AcceptanceRow)[];

type MissingExportedAcceptanceColumn = UnprojectedColumns<
  AcceptanceRow,
  AcceptanceAccountExport,
  (typeof UNEXPORTED_ACCEPTANCE_COLUMNS)[number]
>;
type UnexpectedExportedAcceptanceColumn = UnbackedProjectionKeys<
  AcceptanceRow,
  AcceptanceAccountExport,
  (typeof UNEXPORTED_ACCEPTANCE_COLUMNS)[number]
>;

true satisfies MissingExportedAcceptanceColumn extends never ? true : never;
true satisfies UnexpectedExportedAcceptanceColumn extends never ? true : never;
