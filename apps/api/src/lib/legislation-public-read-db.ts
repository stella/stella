import type { Transaction } from "@/api/db/root";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";

const LEGISLATION_PUBLIC_READ_DB = Symbol("legislationPublicReadDb");

/**
 * Read surface a legislation reader needs: statement builders only, no
 * mutation entry points and no relational query graph.
 */
export type LegislationReadTransaction = Pick<
  Transaction,
  "execute" | "select"
>;

/** Any database handle able to serve a legislation read. */
export type LegislationReadDb = <T>(
  fn: (tx: LegislationReadTransaction) => Promise<T>,
) => Promise<T>;

export type LegislationPublicReadDb = LegislationReadDb & {
  [LEGISLATION_PUBLIC_READ_DB]: true;
};

/**
 * Read-only access boundary for public legislation data.
 *
 * Public handlers receive no `scopedDb`, session or workspace context. The
 * brand keeps a public read from silently accepting an authenticated handle,
 * and the transaction is read-only at the database as well as in the type.
 */
export const legislationPublicReadDb: LegislationPublicReadDb = Object.assign(
  async <T>(fn: (tx: LegislationReadTransaction) => Promise<T>): Promise<T> =>
    await publicLawReadDb(fn),
  { [LEGISLATION_PUBLIC_READ_DB]: true as const },
);
