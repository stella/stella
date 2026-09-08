/**
 * Configuring a template's fields, as an edit to the document.
 *
 * Bytes in, bytes out: the entries are read against what the markers already
 * declare, merged onto them, written back into the markers, and the manifest
 * is derived from the result. No database and no object storage: the storage
 * wrapper lives in `handlers/templates/configure-template-fields-service.ts`,
 * and the authoring eval drives this half directly, so the eval and the
 * service run the same code.
 */

import {
  arrayFiltersFromFieldConfig,
  assertNever,
  filtersFromFieldConfig,
  unwritableFilterValues,
  type FilterCall,
  type UnwritableReason,
} from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";
import { deriveManifest } from "@/api/lib/docx/derived-manifest";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { filterChainSignature } from "@/api/lib/docx/field-filters";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldMeta,
  TemplateManifest,
} from "@/api/lib/docx/types";
import {
  writeFieldFilters,
  type FieldFilterRewrite,
} from "@/api/lib/docx/write-field-filters";

import {
  fieldConfigurationIssuePath,
  mergeFieldConfiguration,
  partitionFieldConfiguration,
  type FieldConfigurationIssue,
} from "./configure-field-input";

export type ConfigureTemplateDocumentResult = {
  /** The document with the configuration written into its markers; the same
   *  bytes when nothing applied. */
  buffer: Buffer;
  /** The manifest those bytes declare. */
  manifest: TemplateManifest;
  /** Every entry that did not land, addressed by the position the caller sent
   *  it at. A call with seven usable entries and one bad path configures the
   *  seven. */
  issues: FieldConfigurationIssue[];
};

/** The paths the document repeats over, which are the ones whose filters are
 *  written on a `{% for %}` opener rather than on a value marker. */
const arrayPaths = (discovered: DiscoveredTemplate): Set<string> => {
  const paths = new Set<string>();
  const visit = (field: DiscoveredField, prefix: string): void => {
    const path = prefix === "" ? field.path : `${prefix}.${field.path}`;
    if (field.kind === "array") {
      paths.add(path);
    }
    for (const item of arrayOrEmpty(field.itemFields)) {
      visit(item, path);
    }
  };
  for (const field of discovered.fields) {
    visit(field, "");
  }
  return paths;
};

/** What to do about a value the grammar cannot spell. A `{{ }}` marker quotes
 *  its arguments, so only a repeat's `{% for %}` tag is delimiter-sensitive;
 *  a number's spelling is not the writer's to choose in either. */
const unwritableHint = (reason: UnwritableReason): string => {
  switch (reason) {
    case "tag-delimiter":
      return (
        "A {% for %} tag carries no quoted text, so take { and } out of the " +
        "repeat's label or hint. A value field's own marker holds them fine."
      );
    case "number-spelling":
      return "Write the number in full: an exponent is not a number a marker can carry.";
    default:
      return assertNever(reason);
  }
};

/** The issue an entry gets when the grammar has no spelling for one of its
 *  values, so writing it would come back as different text. */
const unwritableValueIssue = ({
  filter,
  index,
  path,
  reason,
  value,
}: {
  filter: string;
  index: number;
  path: string;
  reason: UnwritableReason;
  value: string;
}): FieldConfigurationIssue => ({
  path: fieldConfigurationIssuePath(index),
  index,
  message:
    `"${path}" cannot be written into the document: ${filter}(${value}) has ` +
    "no spelling the marker grammar reads back.",
  hint: unwritableHint(reason),
});

/** The issue an entry gets when the document has no marker to carry it. The
 *  configuration lives in the markers, so a path with none has nowhere to go. */
const noMarkerIssue = (
  path: string,
  index: number,
): FieldConfigurationIssue => ({
  path: fieldConfigurationIssuePath(index),
  index,
  message: `"${path}" has no {{ marker }} in the document to carry its configuration.`,
  hint:
    `Put {{ ${path} }} in the document and save the new version, then ` +
    "configure it. A path a condition only reads is not a marker.",
});

export type ConfigureTemplateDocumentOptions = {
  buffer: Buffer;
  /** The entries, in the order the caller sent them. */
  entries: readonly FieldMeta[];
};

/**
 * Apply a field configuration to a template's bytes.
 *
 * Each entry's properties replace what its marker says and leave the rest
 * standing; naming any source replaces the whole "who fills this" cluster. The
 * merged field is rendered back to a filter chain and written to every
 * occurrence of its marker, and the manifest that comes back is read from the
 * rewritten bytes rather than assembled beside them.
 */
export const configureTemplateDocument = async ({
  buffer,
  entries,
}: ConfigureTemplateDocumentOptions): Promise<ConfigureTemplateDocumentResult> => {
  const discovered = await discoverTemplate(buffer);
  const declared = deriveManifest(discovered);
  const partitioned = partitionFieldConfiguration({
    configured: declared.fields,
    discovered,
    entries,
  });
  const issues = [...partitioned.issues];
  const declaredByPath = new Map(
    declared.fields.map((field) => [field.path, field]),
  );
  const arrays = arrayPaths(discovered);
  const chainFor = (field: FieldMeta): FilterCall[] =>
    arrays.has(field.path)
      ? arrayFiltersFromFieldConfig(field)
      : filtersFromFieldConfig(field);

  // Each candidate keeps the position the caller sent it at, so an issue this
  // step raises names the entry the caller wrote rather than a place in a list
  // it never saw.
  //
  // An entry that asks for what the document already says is not a candidate
  // at all: the `configure` skeleton names every configurable path, so sending
  // it back unchanged has to be a no-op rather than a document rewrite, and a
  // path whose only configuration is what discovery derived (a boolean an
  // `{% if %}` reads) must not be refused for having no marker to restate it
  // in.
  const candidates = partitioned.applied.flatMap(({ field, index }) => {
    const declaredField = declaredByPath.get(field.path);
    const filters = chainFor(mergeFieldConfiguration(declaredField, field));
    const unchanged =
      declaredField !== undefined &&
      filterChainSignature(filters) ===
        filterChainSignature(chainFor(declaredField));
    return unchanged ? [] : [{ index, path: field.path, filters }];
  }) satisfies (FieldFilterRewrite & { index: number })[];

  const refused = new Set<string>();
  for (const candidate of candidates) {
    for (const { filter, reason, value } of unwritableFilterValues(
      candidate.filters,
      arrays.has(candidate.path) ? "statement" : "output",
    )) {
      refused.add(candidate.path);
      issues.push(
        unwritableValueIssue({
          filter,
          index: candidate.index,
          path: candidate.path,
          reason,
          value: JSON.stringify(value),
        }),
      );
    }
  }

  const rewrites = candidates.filter(({ path }) => !refused.has(path));
  const { buffer: rewritten, written } = await writeFieldFilters(
    buffer,
    rewrites,
  );
  for (const { index, path } of rewrites) {
    if (!written.has(path)) {
      issues.push(noMarkerIssue(path, index));
    }
  }

  return {
    buffer: rewritten,
    manifest: await deriveManifestFromBuffer(rewritten, buffer, discovered),
    issues: issues.toSorted((left, right) => left.index - right.index),
  };
};

/** The manifest of the rewritten bytes, or of the ones already in hand when
 *  nothing was written: re-running discovery over an unchanged document would
 *  read the same markers twice. */
const deriveManifestFromBuffer = async (
  rewritten: Buffer,
  original: Buffer,
  discovered: DiscoveredTemplate,
): Promise<TemplateManifest> =>
  rewritten === original
    ? deriveManifest(discovered)
    : deriveManifest(await discoverTemplate(rewritten));
