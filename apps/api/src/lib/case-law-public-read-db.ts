import type { Transaction } from "@/api/db/root";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import type {
  PublicLawReadIsolation,
  PublicLawReadOptions,
} from "@/api/lib/public-law-read-db";

const CASE_LAW_PUBLIC_READ_DB = Symbol("caseLawPublicReadDb");

type CaseLawQueryKey = Extract<keyof Transaction["query"], "caseLawDecisions">;

export type CaseLawPublicReadTransaction = Pick<
  Transaction,
  "execute" | "select"
> & {
  query: Pick<Transaction["query"], CaseLawQueryKey>;
};

export type CaseLawReadIsolation = PublicLawReadIsolation;
export type CaseLawReadOptions = PublicLawReadOptions;

export type CaseLawPublicReadDb = (<T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  options?: CaseLawReadOptions,
) => Promise<T>) & {
  [CASE_LAW_PUBLIC_READ_DB]: true;
};

export const caseLawPublicReadDb: CaseLawPublicReadDb = Object.assign(
  async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    options?: CaseLawReadOptions,
  ): Promise<T> => await publicLawReadDb(fn, options),
  { [CASE_LAW_PUBLIC_READ_DB]: true as const },
);
