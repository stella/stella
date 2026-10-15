import * as schema from "@/api/db/schema";
import { clauses as table } from "@/api/db/schema";
import { validateClauseBodyDirectives } from "@/api/lib/clauses/clause-directives";

declare const tx: {
  insert: (value: unknown) => unknown;
  update: (value: unknown) => unknown;
};
declare const unrelated: unknown;
declare const body: Parameters<typeof validateClauseBodyDirectives>[0];

// oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: aliased clause writes are confined to the owning operations
const _insert = tx.insert(table);
// oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: namespace variant writes are confined to the owning operations
const _update = tx.update(schema.clauseVariants);
// oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: snapshot writes are confined to the owning operations
const _snapshot = tx.insert(schema.clauseVersions);
const _checkedUnowned = function* () {
  yield* validateClauseBodyDirectives(body);
  // oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: calling validation does not authorize a second persistence owner
  return tx.insert(table);
};
// expect-clean: no-unvalidated-clause-write/no-unvalidated-clause-write
const _unrelated = tx.insert(unrelated);
// oxlint-disable-next-line no-shadow -- fixture: a locally bound table is not the imported clause table
const _shadowed = (table: unknown) => tx.insert(table);

export const __noUnvalidatedClauseWriteUnownedFixture = {
  _insert,
  _update,
  _snapshot,
  _checkedUnowned,
  _unrelated,
  _shadowed,
};
