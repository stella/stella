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
  renderForOpener,
  scanMarkers,
  unwritableFilterValues,
} from "@stll/template-conditions";
import type { FilterCall, MarkerMeta } from "@stll/template-conditions";

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

/**
 * The edits that put the session's field configuration into the document's
 * markers: the value marker of every configured path, and the `{% for %}`
 * opener of every configured repeat. Markers whose text is unchanged are
 * skipped, so a save that changed nothing rewrites nothing.
 *
 * A field with no marker of its own has nowhere to be written and is dropped;
 * the document is the only store, so a configuration the markers cannot hold
 * does not survive a save.
 */
export const markerConfigRewrites = ({
  directives,
  fields,
  markerText,
}: MarkerConfigRewriteOptions): MarkerConfigRewrite[] => {
  const byPath = new Map(fields.map((field) => [field.path, field]));
  return directives.flatMap(({ from, to }) => {
    const raw = markerText({ from, to });
    const [scanned, ...rest] = scanMarkers(raw);
    if (scanned === undefined || rest.length > 0) {
      return [];
    }
    const { meta } = scanned;
    if (meta.kind === "placeholder") {
      const field = byPath.get(meta.expr);
      if (field === undefined) {
        return [];
      }
      const next: MarkerMeta = {
        kind: "placeholder",
        expr: meta.expr,
        filters: fieldFilters(field),
      };
      return rewriteTo({ from, to }, raw, formatMarker(next));
    }
    if (meta.kind === "for") {
      const field = byPath.get(meta.path);
      if (field === undefined) {
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
          filters: arrayFieldFilters(field),
          prefix: scanned.prefix,
        }),
      );
    }
    return [];
  });
};

/**
 * Every configured value the marker grammar has no spelling for, with the
 * field that carries it. A brace inside a label would end the marker span, so
 * writing it would read back as different text: the save refuses instead.
 */
export const unwritableFieldValues = (
  fields: readonly StudioField[],
): { path: string; filter: string }[] =>
  fields.flatMap((field) =>
    unwritableFilterValues(fieldFilters(field)).map(({ filter }) => ({
      path: field.path,
      filter,
    })),
  );
