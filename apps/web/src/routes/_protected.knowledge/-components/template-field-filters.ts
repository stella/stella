/**
 * Writing the Studio's field configuration back into the document's markers.
 *
 * The DOCX is the only store: `{{ deposit | number | label("Kaution") |
 * required }}` IS the field's configuration, so a Studio edit is only
 * persisted once it has been written back into the marker it configures.
 *
 * The chain itself comes from `@stll/template-conditions`, which the api
 * writes through too: one writer, because two would be two documents. This
 * module owns only where those chains go in the ProseMirror document.
 */

import type { DirectiveRange } from "@stll/folio-react";
import {
  arrayFiltersFromFieldConfig,
  filtersFromFieldConfig,
  isFieldPath,
  qualifyLoopPath,
  qualifyRowScopedPlaceholder,
  renderConditionTag,
  renderForOpener,
  scanMarkers,
  unwritableFilterValues,
} from "@stll/template-conditions";
import type {
  FilterCall,
  MarkerMeta,
  MarkerPrefix,
  RowScope,
} from "@stll/template-conditions";

import { formatMarker } from "@/routes/_protected.knowledge/-components/template-markers";
import { studioFieldToManifestField } from "@/routes/_protected.knowledge/-components/template-studio-model";
import type { StudioField } from "@/routes/_protected.knowledge/-components/template-studio-store";
import type { EditableLookup } from "@/routes/_protected.knowledge/-components/template-value-source";

/** The filter chain that declares this field in a document. */
const fieldFilters = (field: StudioField): FilterCall[] =>
  filtersFromFieldConfig(studioFieldToManifestField(field));

/** The chain a `{% for %}` opener carries for this array: the repeat's own
 *  filters and nothing else. */
const arrayFieldFilters = (field: StudioField): FilterCall[] =>
  arrayFiltersFromFieldConfig(studioFieldToManifestField(field));

// ── Writing the session back into the document ───────────

/** One marker's text replaced by the same marker carrying its field's
 *  configuration. Positions are the directive's own, so a caller applies them
 *  highest-first within a single transaction. */
type MarkerConfigRewrite = { from: number; to: number; text: string };

/**
 * One field the document cannot carry, and why.
 *
 * `no-marker` is a configuration whose marker the author deleted, so the field
 * goes with it. The other two are settings the document has no spelling for at
 * all, and a save that dropped them would lose the author's work: they stop the
 * save instead.
 */
export type UnplacedField =
  | { reason: "no-marker"; path: string }
  | { reason: "unwritable"; path: string; filter: string }
  | { reason: "unspellable-rule"; path: string };

/** True when the loss has to stop the save rather than be reported after it. */
export const refusesSave = ({ reason }: UnplacedField): boolean =>
  reason !== "no-marker";

/** What projecting the session onto the document produced: the marker edits to
 *  apply, and the configuration that has nowhere to go. */
export type MarkerProjection = {
  rewrites: MarkerConfigRewrite[];
  unplaced: UnplacedField[];
};

/** The rewrite one marker needs, or none when its text already reads that way. */
const rewriteTo = (
  range: { from: number; to: number },
  raw: string,
  text: string,
): MarkerConfigRewrite[] =>
  text === raw ? [] : [{ from: range.from, to: range.to, text }];

type MarkerConfigRewriteOptions = {
  directives: readonly DirectiveRange[];
  fields: readonly StudioField[];
  /** The document text of one directive's range. */
  markerText: (range: { from: number; to: number }) => string;
};

/** The input controls the DOCUMENT already implies: a marker with no input
 *  filter asks for text, and a path an `{% if %}` reads is a yes/no question.
 *  A field carrying only one of these has decided nothing an author would
 *  miss, so its marker going away is not a loss to report. */
const DERIVED_INPUT_FILTERS: ReadonlySet<string> = new Set([
  "text",
  "checkbox",
]);

/** A field says something worth reporting when it carries a filter the
 *  document's own structure did not already imply. */
const carriesConfiguration = (field: StudioField): boolean =>
  fieldFilters(field).some(({ name }) => !DERIVED_INPUT_FILTERS.has(name));

/** The registry lookup a field fills from, when that is the source it uses. */
const fieldLookup = (field: StudioField): EditableLookup | undefined =>
  field.valueSource.type === "lookup" ? field.valueSource.lookup : undefined;

/**
 * What a field's rule can be written as.
 *
 * The rule editor serializes a rule to its `{% if %}` expression as it is
 * built, and stores the tree instead only for a rule over a formula operand
 * (`rent * 12 > 1000`) — arithmetic the tag grammar has no syntax for. The tag
 * is the only place a rule can live now, so that shape is refused rather than
 * written as something it is not.
 */
type FieldRule =
  | { kind: "none" }
  | { kind: "expression"; expression: string }
  | { kind: "unspellable" };

const fieldRule = (field: StudioField): FieldRule => {
  const { valueSource } = field;
  if (valueSource.type !== "condition") {
    return { kind: "none" };
  }
  if (valueSource.conditionAst !== undefined) {
    return { kind: "unspellable" };
  }
  const expression = valueSource.condition.trim();
  return expression === ""
    ? { kind: "none" }
    : { kind: "expression", expression };
};

/** One directive of the document, with the manifest path it addresses: the
 *  body writes `{{ attorney.name }}` inside `{% for attorney in attorneys %}`
 *  and the session calls that field `attorneys.name`, so the alias resolves
 *  through the same scoping the server applies when it reads the document back. */
type ScannedDirective = {
  from: number;
  to: number;
  raw: string;
  meta: MarkerMeta;
  prefix: MarkerPrefix;
  scopedPath: string;
};

/** The directives a configuration can be written into, in document order.
 *  Anything else — `{% endif %}`, a clause slot, a run holding two markers —
 *  carries no field configuration. */
const scanDirectives = ({
  directives,
  markerText,
}: Omit<MarkerConfigRewriteOptions, "fields">): ScannedDirective[] => {
  const scopes: RowScope[] = [];
  const scanned: ScannedDirective[] = [];
  for (const { from, to } of directives) {
    const raw = markerText({ from, to });
    const [marker, ...rest] = scanMarkers(raw);
    if (marker === undefined || rest.length > 0) {
      continue;
    }
    const { meta, prefix } = marker;
    if (meta.kind === "endfor") {
      scopes.pop();
      continue;
    }
    if (meta.kind === "for") {
      const scopedPath = qualifyLoopPath(meta.path, scopes);
      scanned.push({ from, to, raw, meta, prefix, scopedPath });
      scopes.push({ alias: meta.alias, declaredPath: meta.path, scopedPath });
      continue;
    }
    if (meta.kind === "placeholder") {
      const scopedPath = qualifyRowScopedPlaceholder(meta.expr, scopes);
      scanned.push({ from, to, raw, meta, prefix, scopedPath });
      continue;
    }
    // Only a tag that names one path can carry that path's rule: an expression
    // the author already wrote is the document's, not a field's.
    if (
      (meta.kind === "if" || meta.kind === "elif") &&
      isFieldPath(meta.expr)
    ) {
      const scopedPath = qualifyRowScopedPlaceholder(meta.expr, scopes);
      scanned.push({ from, to, raw, meta, prefix, scopedPath });
    }
  }
  return scanned;
};

/**
 * The edits that put the session's field configuration into the document: the
 * value marker of every configured path, the `{% for %}` opener of every
 * configured repeat, the markers that render a registry hit for the field that
 * lookup fills, and the `{% if %}` / `{% elif %}` tag of a rule with no marker
 * of its own. Markers whose text is unchanged are skipped, so a save that
 * changed nothing rewrites nothing.
 *
 * Where a configuration goes is the reading the server applies when it writes
 * one: the field's own marker, else the renderings of its lookup, else the tag
 * that asks the question.
 *
 * The document is the only store, so a configuration nothing can carry is
 * reported rather than dropped: the caller decides what to tell the author.
 */
export const markerConfigRewrites = ({
  directives,
  fields,
  markerText,
}: MarkerConfigRewriteOptions): MarkerProjection => {
  const scanned = scanDirectives({ directives, markerText });
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const markerPaths = new Set(
    scanned
      .filter(({ meta }) => meta.kind === "placeholder")
      .map(({ scopedPath }) => scopedPath),
  );

  // A lookup on a field the document never prints bare rides on the markers
  // that render its hit: `{{ company.name }}` renders `company`, so it is what
  // carries `company`'s chain.
  const renderedBy = new Map<string, StudioField>();
  for (const field of fields) {
    const lookup = fieldLookup(field);
    if (lookup === undefined || markerPaths.has(field.path)) {
      continue;
    }
    for (const { key } of lookup.formats) {
      const rendering = `${field.path}.${key}`;
      if (markerPaths.has(rendering)) {
        renderedBy.set(rendering, field);
      }
    }
  }

  const placed = new Set<string>();
  const unplaced: UnplacedField[] = [];

  /** The chain a field writes into this marker, or nothing when the grammar
   *  cannot spell one of its values there. A repeat's chain goes in a tag,
   *  which carries no quoted text; a value marker's arguments carry anything. */
  const chainFor = (
    field: StudioField,
    form: "output" | "statement",
  ): FilterCall[] | null => {
    const filters =
      form === "statement" ? arrayFieldFilters(field) : fieldFilters(field);
    const refused = unwritableFilterValues(filters, form).at(0);
    if (refused === undefined) {
      return filters;
    }
    unplaced.push({
      reason: "unwritable",
      path: field.path,
      filter: refused.filter,
    });
    return null;
  };

  const rewrites = scanned.flatMap(
    ({ from, to, meta, prefix, raw, scopedPath }) => {
      if (meta.kind === "if" || meta.kind === "elif") {
        // A field the document also prints keeps its rule in its own marker's
        // condition() filter, so the tag goes on naming it.
        if (markerPaths.has(scopedPath)) {
          return [];
        }
        const field = byPath.get(scopedPath);
        const rule = field === undefined ? null : fieldRule(field);
        if (rule?.kind !== "expression") {
          return [];
        }
        placed.add(scopedPath);
        return rewriteTo(
          { from, to },
          raw,
          renderConditionTag({
            kind: meta.kind,
            expression: rule.expression,
            prefix,
          }),
        );
      }
      if (meta.kind === "for") {
        const field = byPath.get(scopedPath);
        if (field === undefined) {
          return [];
        }
        placed.add(scopedPath);
        const filters = chainFor(field, "statement");
        if (filters === null) {
          return [];
        }
        // Rendered through the package's own writer rather than
        // `formatMarker`: only it keeps the docxtpl placement prefix, so
        // re-configuring a repeat cannot move a row-form loop off its table row.
        return rewriteTo(
          { from, to },
          raw,
          renderForOpener({
            alias: meta.alias,
            path: meta.path,
            filters,
            prefix,
          }),
        );
      }
      if (meta.kind !== "placeholder") {
        return [];
      }
      const field = byPath.get(scopedPath) ?? renderedBy.get(scopedPath);
      if (field === undefined) {
        return [];
      }
      placed.add(field.path);
      const filters = chainFor(field, "output");
      if (filters === null) {
        return [];
      }
      // The marker keeps the spelling the author gave it: rewriting
      // `{{ attorney.name }}` to `{{ attorneys.name }}` would move the field
      // out of its loop.
      const next: MarkerMeta = {
        kind: "placeholder",
        expr: meta.expr,
        filters,
      };
      return rewriteTo({ from, to }, raw, formatMarker(next));
    },
  );

  for (const field of fields) {
    // A rule with no expression form is refused wherever it would have gone:
    // a marker's chain has no place for a tree either.
    if (fieldRule(field).kind === "unspellable") {
      unplaced.push({ reason: "unspellable-rule", path: field.path });
      continue;
    }
    if (!placed.has(field.path) && carriesConfiguration(field)) {
      unplaced.push({ reason: "no-marker", path: field.path });
    }
  }

  return { rewrites, unplaced };
};
