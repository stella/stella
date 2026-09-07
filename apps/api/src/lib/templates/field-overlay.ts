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
import {
  isLookupFormatKey,
  LOOKUP_FORMATS_MAX,
  type DiscoveredField,
  type DiscoveredTemplate,
  type FieldLookupFormat,
  type FieldMeta,
  type TemplateManifest,
} from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** One rejected overlay entry. `path` is the dot path of the offending entry in
 *  the tool input (`fields.2`), matching the schema-derived issue paths, so an
 *  agent can fix the entry it sent instead of parsing prose; `index` is the
 *  same position as a number, so a caller can address the entry it sent
 *  without parsing the path. `message` says what is wrong with the entry and
 *  `hint` says what to do about it. */
export type FieldOverlayIssue = {
  path: string;
  index: number;
  message: string;
  hint: string;
};

/** The phrase that names the lookup-ownership refusal built below. A reader
 *  of the issues (the template-authoring eval's grammar-trap detector) has to
 *  recognize that one refusal among the rest, so the message and the matcher
 *  are the same constant and cannot drift apart. */
export const LOOKUP_OWNERSHIP_REFUSAL = "declares a lookup whose format key";

/**
 * What the DOCX declares, split by how the path came to exist. `declared` is
 * everything discovery knows: markers, the condition paths only an `{% if %}`
 * names, loop item paths, and the object roots inferred from dotted markers.
 * `roots` is the subset that is value-bearing on its own — a literal
 * `{{marker}}` or an `{% for %}` array — which is what separates a real field
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

/**
 * The path an overlay entry means, in the vocabulary the manifest speaks.
 *
 * A loop names its item — `{% for attorney in attorneys %}` — and the body
 * writes `{{ attorney.name }}`, so that is the path a model reaches for when
 * it configures the field. The manifest speaks the array path, because a loop
 * over `attorneys` has ONE `attorneys.name` however the body spells it. The
 * two are the same field, so the alias resolves here rather than being
 * refused as a marker the DOCX does not carry.
 *
 * Only an alias the document actually bound is resolved, and only when it does
 * not collide with a real path: a field genuinely called `attorney.name`
 * always wins over the alias reading.
 */
export const canonicalizeOverlayPath = (
  path: string,
  discovered: DiscoveredTemplate,
  declared: ReadonlySet<string>,
): string => {
  if (declared.has(path)) {
    return path;
  }
  for (const { alias, path: arrayPath } of discovered.loopAliases) {
    if (path === alias) {
      return arrayPath;
    }
    if (path.startsWith(`${alias}.`)) {
      const resolved = `${arrayPath}.${path.slice(alias.length + 1)}`;
      if (declared.has(resolved)) {
        return resolved;
      }
    }
  }
  return path;
};

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
        index,
        message: `"${field.path}" is configured more than once.`,
        hint: "Send one entry per path; merge the duplicates into one entry.",
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
          index,
          message:
            `"${field.path}" is not a marker of its own: the DOCX only ` +
            `groups ${children.map((child) => `{{${child}}}`).join(", ")} ` +
            "under it.",
          hint:
            "Configure those paths instead, or give " +
            `"${field.path}" a lookup source whose format keys are those markers.`,
        });
        continue;
      }
    } else if (!declared.has(field.path)) {
      issues.push({
        path: issuePath,
        index,
        message: `No marker {{${field.path}}} in the DOCX.`,
        hint:
          "Configure only the paths the template reported. To add a field, " +
          "put its {{marker}} in the document and publish a new version.",
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
        `"${field.path}" ${LOOKUP_OWNERSHIP_REFUSAL} "${format.key}" ` +
        `renders {{${childPath}}}, but "${childPath}" is configured as its ` +
        "own field.";
      const hint =
        "Drop one of the two: rename the format key, or remove the " +
        `"${childPath}" configuration.`;
      const ownerIndex = overlayIndexByPath.get(field.path);
      if (ownerIndex !== undefined) {
        issues.push({
          path: `fields.${ownerIndex}`,
          index: ownerIndex,
          message,
          hint,
        });
      }
      const childIndex = overlayIndexByPath.get(childPath);
      if (childIndex !== undefined) {
        issues.push({
          path: `fields.${childIndex}`,
          index: childIndex,
          message,
          hint,
        });
      }
    }
  }

  return issues;
};

type PartitionFieldOverlayResult = {
  /** The entries that apply together, in the order they were sent. */
  applied: FieldMeta[];
  /** One issue per entry that does not, addressed by its position in the
   *  input the caller sent, not by its position among the survivors. */
  issues: FieldOverlayIssue[];
};

/**
 * Split an overlay into the entries that apply and the ones that do not. A
 * call carrying seven usable entries and one bad path configures the seven:
 * an agent that gets one property wrong should not have to resend the other
 * seven to find out whether they were fine.
 *
 * Validation runs to a fixed point because two of the rules relate a pair of
 * entries (a lookup owner and the marker one of its format keys renders), so
 * dropping one entry can settle another. Dropping only ever removes
 * constraints, and every round removes at least one entry, so the loop
 * terminates in at most `overlay.length` rounds.
 */
export const partitionFieldOverlay = ({
  configured,
  discovered,
  overlay,
}: ValidateFieldOverlayOptions): PartitionFieldOverlayResult => {
  const issuesByIndex = new Map<number, FieldOverlayIssue>();
  const { declared } = declaredPaths(discovered);
  let survivors = overlay.map((field, index) => ({
    field: {
      ...field,
      path: canonicalizeOverlayPath(field.path, discovered, declared),
    },
    index,
  }));
  for (;;) {
    const issues = validateFieldOverlay({
      configured,
      discovered,
      overlay: survivors.map((entry) => entry.field),
    });
    if (issues.length === 0) {
      return {
        applied: survivors.map((entry) => entry.field),
        issues: [...issuesByIndex.values()].toSorted(
          (left, right) => left.index - right.index,
        ),
      };
    }
    const rejected = new Set<number>();
    for (const issue of issues) {
      const entry =
        survivors[issue.index] ??
        panic(`overlay issue names position ${String(issue.index)}`);
      rejected.add(entry.index);
      // The first reason an entry is rejected describes the entry itself; a
      // later round can only report a consequence of dropping another.
      if (!issuesByIndex.has(entry.index)) {
        issuesByIndex.set(entry.index, {
          ...issue,
          path: `fields.${entry.index}`,
          index: entry.index,
        });
      }
    }
    survivors = survivors.filter((entry) => !rejected.has(entry.index));
  }
};

/**
 * What folding a field into one of its parent's lookup formats can do with
 * each manifest property. A format is a key and a `[token]` template and
 * nothing else, so a property a format cannot carry keeps the child a rival
 * configuration, refused as before. Total over the manifest shape: a property
 * added to `fieldMetaSchema` cannot ship without deciding whether a rendering
 * of a registry hit can hold it.
 */
const FORMAT_FOLD = {
  path: "identity",
  lookup: "template",
  // Nobody fills a rendering of the resolved hit, so wording addressed at the
  // person filling has nowhere to go in a format.
  label: "dropped",
  hint: "dropped",
  inputType: "blocking",
  options: "blocking",
  optionsFrom: "blocking",
  validation: "blocking",
  required: "blocking",
  aiPrompt: "blocking",
  aiAdapt: "blocking",
  aiSeesDocument: "blocking",
  parts: "blocking",
  format: "blocking",
  source: "blocking",
  formula: "blocking",
  condition: "blocking",
  conditionAst: "blocking",
  dateFormat: "blocking",
} as const satisfies Record<
  keyof FieldMeta,
  "identity" | "template" | "dropped" | "blocking"
>;

const foldsIntoFormat = (field: FieldMeta): boolean => {
  const declared: Record<string, unknown> = field;
  return Object.entries(FORMAT_FOLD).every(
    ([property, disposition]) =>
      disposition !== "blocking" || declared[property] === undefined,
  );
};

/** The parent's formats with `key` rendering `template`. The child is the more
 *  specific declaration, so its template replaces the parent's. `null` when the
 *  key is new and the lookup already carries its maximum. */
const withFormatTemplate = (
  formats: readonly FieldLookupFormat[],
  key: string,
  template: string,
): FieldLookupFormat[] | null => {
  if (formats.some((format) => format.key === key)) {
    return formats.map((format) =>
      format.key === key ? { ...format, template } : format,
    );
  }
  return formats.length >= LOOKUP_FORMATS_MAX
    ? null
    : [...formats, { key, template }];
};

/**
 * Fold `parent.key` back into the lookup that renders it.
 *
 * A model that reads `{{company}}`, `{{company.address}}` and `{{company.krs}}`
 * describes every marker it sees, and describes the dotted ones the only way
 * it can: as the same registry lookup rendered differently. That is not a
 * rival configuration of one marker, it is the parent's format `key` spelled
 * as a field of its own, so the template moves onto that format and the field
 * goes. A child on a DIFFERENT registry is two lookups over one marker, and a
 * child carrying what a format cannot hold is two configurations of it; both
 * stay separate fields and keep the ownership refusal.
 */
const foldLookupFormatFields = (fields: readonly FieldMeta[]): FieldMeta[] => {
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const folded = new Set<string>();
  for (const field of fields) {
    const cut = field.path.lastIndexOf(".");
    const parent =
      cut === -1 ? undefined : byPath.get(field.path.slice(0, cut));
    const key = field.path.slice(cut + 1);
    // The first format renders the bare marker, and a format key holds no
    // dots, so a field declaring several renderings cannot move into one.
    const only =
      field.lookup?.formats.length === 1
        ? field.lookup.formats.at(0)
        : undefined;
    if (
      only === undefined ||
      parent?.lookup === undefined ||
      parent.lookup.registry !== field.lookup?.registry ||
      folded.has(parent.path) ||
      !isLookupFormatKey(key) ||
      !foldsIntoFormat(field)
    ) {
      continue;
    }
    const formats = withFormatTemplate(
      parent.lookup.formats,
      key,
      only.template,
    );
    if (formats === null) {
      continue;
    }
    byPath.set(parent.path, {
      ...parent,
      lookup: { ...parent.lookup, formats },
    });
    folded.add(field.path);
  }
  return fields
    .filter((field) => !folded.has(field.path))
    .map((field) => byPath.get(field.path) ?? field);
};

/**
 * The manifest a validated overlay produces: entries merge by path onto the
 * existing configuration, and a path the manifest does not carry yet (a lookup
 * root the marker scan only saw as a namespace parent) is appended.
 *
 * The merge is where a field that restates its parent's lookup becomes that
 * parent's format, so creation, configuration and read-back fold identically.
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
    // A bare `{ path }` entry decides nothing: it is the skeleton read back
    // unchanged. Appending it would record a loop's item path as a field of
    // its own and grow the manifest on every no-op configure, so only an
    // entry that carries a decision creates a new manifest field.
    if (!existingPaths.has(field.path) && carriesConfiguration(field)) {
      merged.push(field);
    }
  }
  return {
    version: manifest?.version ?? 1,
    fields: foldLookupFormatFields(merged),
  };
};

type ResolveTemplateFieldOverlayOptions = {
  discovered: DiscoveredTemplate;
  manifest: TemplateManifest | null;
  overlay: readonly FieldMeta[] | undefined;
};

/**
 * The document layer under the stored one. A marker's filters are what the
 * DOCX itself says the field is, so they are the base; the stored manifest and
 * the call's overlay refine it, in that order. When the overlay layer is
 * deleted and the manifest becomes a derived cache, the two later layers go
 * and this becomes the whole resolution.
 */
const documentLayer = (
  discovered: DiscoveredTemplate,
  manifest: TemplateManifest | null,
): TemplateManifest | null =>
  discovered.documentFields.length === 0
    ? manifest
    : applyFieldOverlay(
        { version: manifest?.version ?? 1, fields: discovered.documentFields },
        arrayOrEmpty(manifest?.fields),
      );

/** Creation and its diagnostics must classify paths from the same final configuration. */
export const resolveTemplateFieldOverlay = ({
  discovered,
  manifest,
  overlay,
}: ResolveTemplateFieldOverlayOptions): TemplateManifest => {
  const stored = documentLayer(discovered, manifest);
  const baseManifest =
    overlay === undefined ? stored : applyFieldOverlay(stored, overlay);
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
  const summary = `${first.message} ${first.hint}`;
  return new HandlerError({
    status: 400,
    message: others > 0 ? `${summary} (${others} more)` : summary,
    issues: [...issues],
  });
};
