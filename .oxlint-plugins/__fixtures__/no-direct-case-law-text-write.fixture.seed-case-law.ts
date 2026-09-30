// A script sharing the seed basename is not the exact nonproduction owner.
import { caseLawDecisions } from "@/api/db/schema";

declare const tx: {
  update: (table: unknown) => { set: (values: unknown) => unknown };
};
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: matching the seed basename cannot exempt a production writer
const _seedNameCannotExempt = tx
  .update(caseLawDecisions)
  .set({ fulltext: "unchecked repair" });
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _seedNameAllowsClear = tx
  .update(caseLawDecisions)
  .set({ fulltext: null });
export const __noDirectCaseLawTextWriteSeedNameFixture = {
  _seedNameCannotExempt,
  _seedNameAllowsClear,
};
