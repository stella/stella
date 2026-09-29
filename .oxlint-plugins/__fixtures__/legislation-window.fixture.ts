// Passive regression fixture for `legislation-window`.
//
// Each `oxlint-disable-next-line` below suppresses a case the rule MUST flag;
// if the rule stops reporting it, the directive goes unused and the fixture
// lint fails. `expect-clean` marks a line the rule must accept.

import { gt, gte, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

declare const column: SQL;
declare const asOf: SQL;
declare const date: string;

// Stand-ins for the schema table, a Drizzle alias of it and the helper's
// reference type: the rule reads the property names, not their origin.
const legislationDocuments = {
  versionValidFrom: column,
  versionValidTo: column,
};
const alias = <Table>(table: Table, _name: string): Table => table;
const ref = { validFrom: column, validTo: column };
type Version = { versionValidFrom: string; versionValidTo: string | null };
declare const version: Version;

// --- legislation-window-through-helper -------------------------------------

// A raw window column compared in SQL text.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _rawText = sql`newer.version_valid_from <= ${asOf}`;

// A column interpolated beside a comparison operator.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _interpolated = sql`${legislationDocuments.versionValidTo} > ${asOf}`;

// A helper reference's window compared by hand instead of through the helper.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _refByHand = sql`(${ref.validFrom} IS NULL OR ${ref.validFrom} <= ${asOf})`;

// Raw SQL built from a string.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _rawCall = sql.raw(`version_valid_to IS NULL`);

// A Drizzle comparison on the column.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _drizzle = lt(legislationDocuments.versionValidFrom, asOf);

// The same column reached through a Drizzle alias of the table.
const older = alias(legislationDocuments, "older");
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _viaAlias = gt(older.versionValidTo, asOf);

// ... through a const bound to the column.
const openedOn = legislationDocuments.versionValidFrom;
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _viaConst = lte(openedOn, asOf);

// ... through a renamed destructured binding.
const { versionValidTo: closedOn } = legislationDocuments;
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _viaDestructuring = sql`${closedOn} > ${asOf}`;

// ... through a static computed key.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper, typescript/dot-notation -- the computed form is the case under test
const _viaComputedKey = gte(legislationDocuments["versionValidFrom"], asOf);

// A client-side compare of a version's dates.
// oxlint-disable-next-line legislation-window/legislation-window-through-helper
const _clientSide = version.versionValidFrom <= date;

// ... and through a destructured parameter.
const _viaParameter = ({ versionValidTo }: Version): boolean =>
  // oxlint-disable-next-line legislation-window/legislation-window-through-helper
  versionValidTo !== null && versionValidTo > date;

// Selecting the columns decides nothing.
// expect-clean: legislation-window/legislation-window-through-helper
const _selected = { versionValidFrom: legislationDocuments.versionValidFrom };

// Nor does naming one as an output alias, ordering by it or checking it for
// null in plain code, which displays the window rather than decides it.
const _outputAlias = sql`${legislationDocuments.versionValidFrom}::text AS version_valid_from`;
const _sortKey = sql`coalesce(${legislationDocuments.versionValidFrom}, DATE '0001-01-01')`;
const _openEnded = version.versionValidTo === null;

// --- legislation-window-hint-display-only ----------------------------------

declare const hintRow: Record<string, string | null>;

// The hint named in raw SQL text.
// oxlint-disable-next-line legislation-window/legislation-window-hint-display-only
const _hintInSql = sql`SELECT window_hint_next_start FROM legislation_documents`;

// ... in a string handed to raw SQL.
// oxlint-disable-next-line legislation-window/legislation-window-hint-display-only
const _hintInRawString = sql.raw("window_hint_next_start");

// ... read through a renamed destructured binding, which names it once.
// oxlint-disable-next-line legislation-window/legislation-window-hint-display-only
const { windowHintNextStart: nextStart } = hintRow;

// ... and through a computed key.
// oxlint-disable-next-line legislation-window/legislation-window-hint-display-only, typescript/dot-notation -- the computed form is the case under test
const _hintViaComputedKey = hintRow["windowHintNextStart"];

// The alias itself carries no spelling of the field.
// expect-clean: legislation-window/legislation-window-hint-display-only
const _aliasUse = nextStart ?? null;

export const __legislationWindowFixture = {
  _aliasUse,
  _clientSide,
  _drizzle,
  _hintInRawString,
  _hintInSql,
  _hintViaComputedKey,
  _interpolated,
  _openEnded,
  _outputAlias,
  _rawCall,
  _rawText,
  _refByHand,
  _selected,
  _sortKey,
  _viaAlias,
  _viaComputedKey,
  _viaConst,
  _viaDestructuring,
  _viaParameter,
};
