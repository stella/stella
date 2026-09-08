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
  qualifyLoopPath,
  qualifyRowScopedPlaceholder,
  renderForOpener,
  scanMarkers,
  unwritableFilterValues,
} from "@stll/template-conditions";
import type {
  FilterCall,
  MarkerMeta,
  RowScope,
} from "@stll/template-conditions";

import { formatMarker } from "@/routes/_protected.knowledge/-components/template-markers";
import { studioFieldToManifestField } from "@/routes/_protected.knowledge/-components/template-studio-model";
import type { StudioField } from "@/routes/_protected.knowledge/-components/template-studio-store";

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
export type MarkerConfigRewrite = { from: number; to: number; text: string };

/** One field the document cannot carry, and why. `unplaced` is a configuration
 *  with no marker to live in; `unwritable` is one whose value the marker
 *  grammar has no spelling for. */
export type UnplacedField =
  | { reason: "no-marker"; path: string }
  | { reason: "unwritable"; path: string; filter: string };

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

/**
 * The edits that put the session's field configuration into the document's
 * markers: the value marker of every configured path, and the `{% for %}`
 * opener of every configured repeat. Markers whose text is unchanged are
 * skipped, so a save that changed nothing rewrites nothing.
 *
 * A marker inside a loop is addressed by the path the manifest speaks: the
 * body writes `{{ attorney.name }}` and the session calls the field
 * `attorneys.name`, so the alias resolves through the same scoping the server
 * applies when it reads the document back.
 *
 * The document is the only store, so a configuration no marker can carry is
 * reported rather than dropped: the caller decides what to tell the author.
 */
export const markerConfigRewrites = ({
  directives,
  fields,
  markerText,
}: MarkerConfigRewriteOptions): MarkerProjection => {
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const placed = new Set<string>();
  const unplaced: UnplacedField[] = [];
  const scopes: RowScope[] = [];

  /** The chain a field writes into this marker, or the first value the grammar
   *  cannot spell there. A repeat's chain goes in a tag, which carries no
   *  quoted text; a value marker's arguments carry anything. */
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

  const rewrites = directives.flatMap(({ from, to }) => {
    const raw = markerText({ from, to });
    const [scanned, ...rest] = scanMarkers(raw);
    if (scanned === undefined || rest.length > 0) {
      return [];
    }
    const { meta } = scanned;
    if (meta.kind === "endfor") {
      scopes.pop();
      return [];
    }
    if (meta.kind === "for") {
      const scopedPath = qualifyLoopPath(meta.path, scopes);
      scopes.push({ alias: meta.alias, declaredPath: meta.path, scopedPath });
      const field = byPath.get(scopedPath);
      if (field === undefined) {
        return [];
      }
      placed.add(scopedPath);
      const filters = chainFor(field, "statement");
      if (filters === null) {
        return [];
      }
      // Rendered through the package's own writer rather than `formatMarker`:
      // only it keeps the docxtpl placement prefix, so re-configuring a repeat
      // cannot move a row-form loop off its table row.
      return rewriteTo(
        { from, to },
        raw,
        renderForOpener({
          alias: meta.alias,
          path: meta.path,
          filters,
          prefix: scanned.prefix,
        }),
      );
    }
    if (meta.kind !== "placeholder") {
      return [];
    }
    const scopedPath = qualifyRowScopedPlaceholder(meta.expr, scopes);
    const field = byPath.get(scopedPath);
    if (field === undefined) {
      return [];
    }
    placed.add(scopedPath);
    const filters = chainFor(field, "output");
    if (filters === null) {
      return [];
    }
    // The marker keeps the spelling the author gave it: rewriting
    // `{{ attorney.name }}` to `{{ attorneys.name }}` would move the field out
    // of its loop.
    const next: MarkerMeta = { kind: "placeholder", expr: meta.expr, filters };
    return rewriteTo({ from, to }, raw, formatMarker(next));
  });

  for (const field of fields) {
    if (!placed.has(field.path) && carriesConfiguration(field)) {
      unplaced.push({ reason: "no-marker", path: field.path });
    }
  }

  return { rewrites, unplaced };
};
