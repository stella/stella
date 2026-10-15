// Passive regression fixture for
// `no-hand-rolled-execute-rows/no-hand-rolled-execute-rows`.
//
// Each `oxlint-disable-next-line` suppresses a shape the rule MUST report; if
// the detector regresses, the directive becomes unused and the fixture lint
// fails. Everything without a directive is a shape the rule must NOT report.

import { Result } from "better-result";

declare const tx: { execute: (query: string) => Promise<unknown> };
declare const pgliteDb: {
  execute: (query: string) => Promise<{ rows: unknown[] }>;
};
declare const tool: {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};
declare const oneArgumentTool: {
  execute: (input: unknown) => Promise<{ rows: unknown }>;
};
declare const executedRows: (result: unknown) => unknown[];
declare const isRecord: (value: unknown) => value is Record<string, unknown>;
declare const table: { rows: unknown };

const query = "SELECT 1";

// An awaited execute result, tested and read by hand.
const result = await tx.execute(query);
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows -- fixture: array test on a bound result
const first = Array.isArray(result) ? result.at(0) : undefined;
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows, typescript/dot-notation -- fixture: bracket rows read
const bracketRows = isRecord(result) ? result["rows"] : [];
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows -- fixture: rows key test
const hasRows = isRecord(result) && "rows" in result;

// A driver whose result type carries `rows`: inline, bound, destructured.
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows -- fixture: inline execute rows read
const inline = (await pgliteDb.execute(query)).rows;
const typed = await pgliteDb.execute(query);
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows -- fixture: Reflect rows read
const reflectedRows: unknown = Reflect.get(typed, "rows");
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows -- fixture: destructured rows
const { rows: destructured } = await pgliteDb.execute(query);

// The success value of a Result wrapping the execute call.
const queried = await Result.tryPromise({
  try: async () => await tx.execute(query),
  catch: (cause) => cause,
});
// oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows -- fixture: Result-wrapped execute result
const wrapped = Result.isOk(queried) && Array.isArray(queried.value);

// A hand-written copy of the owner, whatever its argument's provenance.
const rowsOf = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value;
  }
  // oxlint-disable-next-line no-hand-rolled-execute-rows/no-hand-rolled-execute-rows, typescript/dot-notation -- fixture: both-shape sniff
  return isRecord(value) ? value["rows"] : [];
};

// --- Must NOT be reported ---

// The owner's reader.
// expect-clean: no-hand-rolled-execute-rows/no-hand-rolled-execute-rows
const owned = executedRows(await tx.execute(query)).at(0);

// A tool's two-argument `execute` is not a query.
const toolOutput = await tool.execute({}, {});
const toolIsList = Array.isArray(toolOutput);

// Nor is a one-argument `execute` on a receiver that is not a database handle
// and given no `sql` query.
const toolRows = (await oneArgumentTool.execute({})).rows;

// A `rows` field of a value never tested as an array.
const tableRows = Array.isArray(table.rows) ? table.rows : [];

// A shadowing parameter does not inherit the result's provenance.
// oxlint-disable-next-line no-shadow -- the shadow is the regression shape
const shadowed = (result: unknown[]) => Array.isArray(result);

export {
  bracketRows,
  destructured,
  first,
  hasRows,
  inline,
  owned,
  reflectedRows,
  rowsOf,
  shadowed,
  tableRows,
  toolIsList,
  toolRows,
  wrapped,
};
