import { clauses, clauseVariants as variants } from "@/api/db/schema";
import * as schema from "@/api/db/schema";

declare const tx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
};

// oxlint-disable-next-line no-direct-clause-variant-insert/no-direct-clause-variant-insert -- fixture exercises an imported table alias
const direct = tx.insert(variants);
// oxlint-disable-next-line no-direct-clause-variant-insert/no-direct-clause-variant-insert -- fixture exercises namespace access
const namespace = tx.insert(schema.clauseVariants);
const localAlias = variants;
// oxlint-disable-next-line no-direct-clause-variant-insert/no-direct-clause-variant-insert -- fixture exercises a constant alias
const alias = tx.insert(localAlias);
// oxlint-disable-next-line no-direct-clause-variant-insert/no-direct-clause-variant-insert, typescript/dot-notation -- fixture exercises computed method and table access
const computed = tx["insert"](schema["clauseVariants"]);
// expect-clean: no-direct-clause-variant-insert/no-direct-clause-variant-insert
const otherTable = tx.insert(clauses);
// expect-clean: no-direct-clause-variant-insert/no-direct-clause-variant-insert
const update = tx.update(variants);

export const __clauseVariantInsertFixture = {
  direct,
  namespace,
  alias,
  computed,
  otherTable,
  update,
};
