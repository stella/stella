import { clauses, clauseVersions } from "@/api/db/schema";
import { validateClauseBodyDirectives as validate } from "@/api/lib/clauses/clause-directives";

declare const tx: {
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
};
declare const body: Parameters<typeof validate>[0];

// oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: owning writers must invoke directive validation
const _uncheckedOwner = () => tx.insert(clauses);
const _checkedOwner = function* () {
  yield* validate(body);
  // expect-clean: no-unvalidated-clause-write/no-unvalidated-clause-write
  return tx.insert(clauses);
};
const _checkedSnapshot = function* () {
  yield* validate(body);
  // expect-clean: no-unvalidated-clause-write/no-unvalidated-clause-write
  return () => tx.insert(clauseVersions);
};
const _lateCheck = function* () {
  // oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: a later call does not validate an earlier write
  tx.update(clauses);
  yield* validate(body);
};
const _siblingCheck = () => {
  const check = () => validate(body);
  // oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: validation in an uncalled sibling function does not cover the writer
  tx.insert(clauses);
  return check;
};

const _discardedCheck = () => {
  validate(body);
  // oxlint-disable-next-line no-unvalidated-clause-write/no-unvalidated-clause-write -- fixture: discarding the validation result cannot cover a writer
  return tx.insert(clauses);
};

export const __noUnvalidatedClauseWriteFixture = {
  _uncheckedOwner,
  _checkedOwner,
  _checkedSnapshot,
  _lateCheck,
  _siblingCheck,
  _discardedCheck,
};
