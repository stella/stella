/**
 * Which paths a `fields` overlay may configure, and what the manifest looks
 * like once it is applied. Shared by template creation (`create-template.ts`)
 * and the configure-an-existing-template service so both accept exactly the
 * same overlay and reject the same one with the same issues.
 *
 * The rule both callers used to contradict: a dotted path is not automatically
 * a leaf. `{{company.name}}` and `{{company.krs}}` make `company` a namespace
 * parent — structural, not fillable — UNLESS the configuration declares a
 * registry lookup on it. Then `company` is the one real input (a registry
 * number) and the dotted markers are named renderings of the single resolved
 * hit, addressed by the lookup's format keys.
 */

import { panic } from "better-result";

import { arrayOrEmpty } from "@/api/lib/array";
import {
  manifestFieldsFromMerge,
  mergeManifestWithDiscovery,
} from "@/api/lib/docx/template-manifest";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldMeta,
  TemplateManifest,
} from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** One rejected overlay entry. `path` is the dot path of the offending entry in
 *  the tool input (`fields.2`), matching the schema-derived issue paths, so an
 *  agent can fix the entry it sent instead of parsing prose. */
export type FieldOverlayIssue = {
  path: string;
  message: string;
};

/**
 * What the DOCX declares, split by how the path came to exist. `declared` is
 * everything discovery knows: markers, the condition paths only an `{{#if}}`
 * names, loop item paths, and the object roots inferred from dotted markers.
 * `roots` is the subset that is value-bearing on its own — a literal
 * `{{marker}}` or an `{{#each}}` array — which is what separates a real field
 * from a structural namespace parent.
 */
type DeclaredPaths = {
  declared: Set<string>;
  roots: Set<string>;
};

const declaredPaths = (discovered: DiscoveredTemplate): DeclaredPaths => {
  const declared = new Set<string>();
  const roots = new Set<string>();
  for (const { name } of discovered.placeholders) {
    declared.add(name);
    roots.add(name);
  }
  const visit = (field: DiscoveredField, prefix: string): void => {
    const path = prefix === "" ? field.path : `${prefix}.${field.path}`;
    declared.add(path);
    // A loop root carries the array itself (min_items, max_items, its item
    // shape), so it is an input even though every marker under it is dotted.
    if (field.kind === "array") {
      roots.add(path);
    }
    for (const item of arrayOrEmpty(field.itemFields)) {
      visit(item, path);
    }
  };
  for (const field of discovered.fields) {
    visit(field, "");
  }
  return { declared, roots };
};

/** Marker paths sitting under `path`. */
const childMarkers = (path: string, declared: ReadonlySet<string>): string[] =>
  [...declared].filter((candidate) => candidate.startsWith(`${path}.`));

/** True when the entry says anything beyond naming a path: a bare `{ path }`
 *  entry is a marker discovery recorded in the manifest, not a decision an
 *  author made, so it never collides with a lookup that owns the same marker. */
const carriesConfiguration = (field: FieldMeta): boolean =>
  Object.entries(field).some(
    ([key, value]) => key !== "path" && value !== undefined,
  );

type ValidateFieldOverlayOptions = {
  /** Fields already configured on the template (its current manifest). */
  configured: readonly FieldMeta[];
  /** What the DOCX markers declare. */
  discovered: DiscoveredTemplate;
  /** The incoming overlay, in the order the caller sent it. */
  overlay: readonly FieldMeta[];
};

/**
 * Validate an overlay against the template's markers. An empty result accepts
 * the overlay; otherwise every offending entry is named, so one round trip
 * reports every problem rather than the first.
 */
export const validateFieldOverlay = ({
  configured,
  discovered,
  overlay,
}: ValidateFieldOverlayOptions): FieldOverlayIssue[] => {
  const { declared, roots } = declaredPaths(discovered);
  const issues: FieldOverlayIssue[] = [];
  const overlayIndexByPath = new Map(
    overlay.map((field, index) => [field.path, index] as const),
  );
  const effectiveFields = applyFieldOverlay(
    { version: 1, fields: [...configured] },
    overlay,
  ).fields;
  const effectiveByPath = new Map(
    effectiveFields.map((field) => [field.path, field]),
  );
  const seenPaths = new Set<string>();

  for (const [index, field] of overlay.entries()) {
    const issuePath = `fields.${index}`;
    if (seenPaths.has(field.path)) {
      issues.push({
        path: issuePath,
        message: `"${field.path}" is a duplicate field path. Send each path once.`,
      });
      continue;
    }
    seenPaths.add(field.path);
    const children = roots.has(field.path)
      ? []
      : childMarkers(field.path, declared);

    if (children.length > 0) {
      // A namespace parent is structural — unless a lookup makes it the one
      // real input, with the markers under it as its named renderings.
      if (effectiveByPath.get(field.path)?.lookup === undefined) {
        issues.push({
          path: issuePath,
          message:
            `"${field.path}" is not a marker of its own: the DOCX only ` +
            `groups ${children.map((child) => `{{${child}}}`).join(", ")} ` +
            "under it. Configure those paths, or declare a lookup on " +
            `"${field.path}" whose format keys are those markers.`,
        });
        continue;
      }
    } else if (!declared.has(field.path)) {
      issues.push({
        path: issuePath,
        message:
          `No marker {{${field.path}}} in the DOCX. Configure only paths ` +
          "that exist as {{markers}}.",
      });
      continue;
    }
  }

  // Validate the resulting ownership graph, so lookup owners and children are
  // checked identically whether they came from the document or this overlay.
  for (const field of effectiveFields) {
    if (field.lookup === undefined) {
      continue;
    }

    // A lookup owns `{{path.key}}` for every one of its format keys: that
    // marker renders the resolved hit. A field configured at the same path
    // would claim the same marker for a second, unrelated value, so the two
    // configurations are refused together rather than one silently winning.
    for (const format of field.lookup.formats) {
      const childPath = `${field.path}.${format.key}`;
      const child = effectiveByPath.get(childPath);
      if (!child || !carriesConfiguration(child)) {
        continue;
      }
      const message =
        `"${field.path}" declares a lookup whose format key "${format.key}" ` +
        `renders {{${childPath}}}, but "${childPath}" is configured as its ` +
        "own field. Drop one of the two: rename the format key, or remove " +
        `the "${childPath}" configuration.`;
      const ownerIndex = overlayIndexByPath.get(field.path);
      if (ownerIndex !== undefined) {
        issues.push({ path: `fields.${ownerIndex}`, message });
      }
      const childIndex = overlayIndexByPath.get(childPath);
      if (childIndex !== undefined) {
        issues.push({ path: `fields.${childIndex}`, message });
      }
    }
  }

  return issues;
};

/**
 * The manifest a validated overlay produces: entries merge by path onto the
 * existing configuration, and a path the manifest does not carry yet (a lookup
 * root the marker scan only saw as a namespace parent) is appended.
 */
export const applyFieldOverlay = (
  manifest: TemplateManifest | null,
  overlay: readonly FieldMeta[],
): TemplateManifest => {
  const overlayByPath = new Map(overlay.map((field) => [field.path, field]));
  const existing = arrayOrEmpty(manifest?.fields);
  const merged: FieldMeta[] = existing.map((field) => {
    const override = overlayByPath.get(field.path);
    return override ? { ...field, ...override } : field;
  });
  const existingPaths = new Set(existing.map((field) => field.path));
  for (const field of overlayByPath.values()) {
    if (!existingPaths.has(field.path)) {
      merged.push(field);
    }
  }
  return { version: manifest?.version ?? 1, fields: merged };
};

type ResolveTemplateFieldOverlayOptions = {
  discovered: DiscoveredTemplate;
  manifest: TemplateManifest | null;
  overlay: readonly FieldMeta[] | undefined;
};

/** Creation and its diagnostics must classify paths from the same final configuration. */
export const resolveTemplateFieldOverlay = ({
  discovered,
  manifest,
  overlay,
}: ResolveTemplateFieldOverlayOptions): TemplateManifest => {
  const baseManifest =
    overlay === undefined ? manifest : applyFieldOverlay(manifest, overlay);
  const fields = mergeManifestWithDiscovery(baseManifest, discovered);
  return {
    version: baseManifest?.version ?? 1,
    fields: manifestFieldsFromMerge(fields, baseManifest),
  };
};

/**
 * The 400 both overlay boundaries return. The summary message stays readable
 * for a plain HTTP client while `issues` carries every offending entry by its
 * input path, which is what the structured MCP envelope surfaces.
 */
export const fieldOverlayError = (
  issues: readonly FieldOverlayIssue[],
): HandlerError<400> => {
  const first = issues.at(0) ?? panic("field overlay rejected with no issue");
  const others = issues.length - 1;
  return new HandlerError({
    status: 400,
    message: others > 0 ? `${first.message} (${others} more)` : first.message,
    issues: [...issues],
  });
};
