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
  type ConditionRewrite,
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

/** Every path the document declares, so a configuration can be matched to the
 *  markers and tags that could carry it. */
const declaredPaths = (discovered: DiscoveredTemplate): Set<string> => {
  const paths = new Set(discovered.placeholders.map(({ name }) => name));
  const visit = (field: DiscoveredField, prefix: string): void => {
    const path = prefix === "" ? field.path : `${prefix}.${field.path}`;
    paths.add(path);
    for (const item of arrayOrEmpty(field.itemFields)) {
      visit(item, path);
    }
  };
  for (const field of discovered.fields) {
    visit(field, "");
  }
  return paths;
};

/**
 * Where a field's chain goes: its own value marker, or — for a registry lookup
 * on a field the document never prints bare — the markers that render its hit.
 * Empty when the document has nowhere to put it.
 */
const carrierPaths = (
  field: FieldMeta,
  markers: ReadonlySet<string>,
): string[] => {
  if (markers.has(field.path)) {
    return [field.path];
  }
  return arrayOrEmpty(field.lookup?.formats)
    .map(({ key }) => `${field.path}.${key}`)
    .filter((path) => markers.has(path));
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

/** The issue an entry gets when the document has nowhere to put it. The
 *  configuration lives in the document, so a path with no marker to carry a
 *  chain and no tag to carry a rule has nowhere to go. */
const noCarrierIssue = (
  path: string,
  index: number,
): FieldConfigurationIssue => ({
  path: fieldConfigurationIssuePath(index),
  index,
  message: `"${path}" has nothing in the document to carry its configuration.`,
  hint:
    `Put {{ ${path} }} in the document and save the new version, then ` +
    "configure it. A registry lookup can instead ride on the markers that " +
    "render its hit, and a condition on the {% if %} tag that reads it.",
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
  const markers = new Set(discovered.placeholders.map(({ name }) => name));
  const declaredHere = declaredPaths(discovered);
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
  // `{% if %}` reads) must not be refused for having nowhere to restate it.
  const configured = partitioned.applied.flatMap(({ field, index }) => {
    const declaredField = declaredByPath.get(field.path);
    const merged = mergeFieldConfiguration(declaredField, field);
    const filters = chainFor(merged);
    const unchanged =
      declaredField !== undefined &&
      filterChainSignature(filters) ===
        filterChainSignature(chainFor(declaredField));
    return unchanged ? [] : [{ field: merged, filters, index }];
  });

  // A rule that decides whether a block shows goes in the tag that shows it:
  // there is no value to print, so there is no value marker to carry a chain.
  const conditionRewrites: ConditionRewrite[] = [];
  const candidates: (FieldFilterRewrite & { index: number })[] = [];
  for (const { field, filters, index } of configured) {
    const carriers = carrierPaths(field, markers);
    if (carriers.length > 0) {
      candidates.push(
        ...carriers.map((path) => ({
          index,
          path,
          filters,
          declares: field.path,
        })),
      );
      continue;
    }
    if (field.condition !== undefined && declaredHere.has(field.path)) {
      conditionRewrites.push({
        path: field.path,
        expression: field.condition,
      });
      continue;
    }
    issues.push(noCarrierIssue(field.path, index));
  }

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
          path: candidate.declares ?? candidate.path,
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
    conditionRewrites,
  );
  for (const { declares, index, path } of rewrites) {
    if (!written.has(declares ?? path)) {
      issues.push(noCarrierIssue(declares ?? path, index));
    }
  }
  for (const { path } of conditionRewrites) {
    if (!written.has(path)) {
      const index =
        configured.find(({ field }) => field.path === path)?.index ?? 0;
      issues.push(noCarrierIssue(path, index));
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
