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

import {
  assertNever,
  referencedConditionPaths,
} from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";
import { foldItemCountConstraints } from "@/api/lib/docx/field-filters";
import {
  manifestFieldsFromMerge,
  mergeManifestWithDiscovery,
} from "@/api/lib/docx/template-manifest";
import {
  FIELD_WIRE_PROPERTY,
  isLookupFormatKey,
  LOOKUP_FORMATS_MAX,
  type DiscoveredField,
  type DiscoveredTemplate,
  type FieldLookup,
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
  /** The one property of the entry the issue is about, when the entry itself
   *  was applied. A caller that re-numbers the entries rebuilds `path` from
   *  it rather than parsing the path it was handed. */
  property?: string;
};

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
  /** The `{% for %}` paths, which are the only ones that repeat, so a count
   *  of items has somewhere to land. */
  arrays: Set<string>;
};

const declaredPaths = (discovered: DiscoveredTemplate): DeclaredPaths => {
  const declared = new Set<string>();
  const roots = new Set<string>();
  const arrays = new Set<string>();
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
      arrays.add(path);
    }
    for (const item of arrayOrEmpty(field.itemFields)) {
      visit(item, path);
    }
  };
  for (const field of discovered.fields) {
    visit(field, "");
  }
  return { arrays, declared, roots };
};

/** Marker paths sitting under `path`. */
const childMarkers = (path: string, declared: ReadonlySet<string>): string[] =>
  [...declared].filter((candidate) => candidate.startsWith(`${path}.`));

/** True when the entry says anything beyond naming a path: a bare `{ path }`
 *  entry is a marker discovery recorded in the manifest, not a decision an
 *  author made, so it never becomes a field of its own. */
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
const canonicalizeOverlayPath = (
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

/**
 * A condition that reads only the field it is attached to.
 *
 * `expenses_reimbursed` is shown when `expenses_reimbursed` is true, which is
 * circular: the input has to be shown before anyone can answer it, so the
 * condition can only ever hide it. What the author meant is the plain
 * question, so the condition says nothing and is read as absent. A condition
 * that reads its own path AMONG others still decides something and stands.
 */
export const conditionReferencesOnlySelf = (
  path: string,
  condition: string,
): boolean => {
  const referenced = referencedConditionPaths(condition);
  return (
    referenced !== null &&
    referenced.length > 0 &&
    referenced.every((referencedPath) => referencedPath === path)
  );
};

/** The entry with a self-referential condition taken off it. The canonical
 *  AST is derived from the expression, so it goes with it. */
const withoutSelfCondition = (field: FieldMeta): FieldMeta => {
  const { condition } = field;
  if (
    condition === undefined ||
    !conditionReferencesOnlySelf(field.path, condition)
  ) {
    return field;
  }
  const { condition: _condition, conditionAst: _conditionAst, ...rest } = field;
  return rest;
};

/** One overlay entry, with the position it was sent at: an issue names the
 *  entry the caller wrote, never the position it ended up in. */
type OverlayEntry = {
  field: FieldMeta;
  index: number;
};

/** The dot path an issue carries: the entry the caller sent, or the one
 *  property of it the issue is about. A path with a property tail says the
 *  entry itself was applied. */
export const fieldOverlayIssuePath = (
  index: number,
  property?: string,
): string =>
  property === undefined
    ? `fields.${String(index)}`
    : `fields.${String(index)}.${property}`;

/** The issue a property dropped out of an entry that otherwise applied
 *  reports. Every dropped-property rule builds its issue here, so the path,
 *  the index and the property they carry cannot drift apart. */
const droppedPropertyIssue = ({
  hint,
  index,
  message,
  property,
}: {
  hint: string;
  index: number;
  message: string;
  property: string;
}): FieldOverlayIssue => ({
  path: fieldOverlayIssuePath(index, property),
  index,
  message,
  hint,
  property,
});

/**
 * The markers a group holds, without the namespaces between: `address` over
 * `{{address.street}}` and `{{address.city}}` holds those two, and a deeper
 * `{{address.geo.lat}}` is held by `address.geo`, which is a group of its own.
 */
const groupLeaves = (
  path: string,
  { declared, roots }: DeclaredPaths,
): string[] =>
  childMarkers(path, declared).filter(
    (child) => roots.has(child) || childMarkers(child, declared).length === 0,
  );

/**
 * Split a group entry into what it can decide and what it cannot.
 *
 * A path that is only a prefix of markers — `property_address` over
 * `{{property_address.street}}` and its siblings — is a GROUP: the fill asks
 * for the children, so there is nothing at the group for a label, an input
 * type or a source to configure. One property still means something on a
 * group, because it means the same thing on every child: `required` propagates
 * to the children that do not answer it themselves. The rest is dropped per
 * property, and the entry is never refused: the caller described a real part
 * of the document, and the entries beside it are unaffected.
 */
const expandGroupEntry = (
  { field, index }: OverlayEntry,
  leaves: readonly string[],
): { required: boolean; issues: FieldOverlayIssue[] } => {
  // A persisted-only key (the derived AST, a composite's parts) has no wire
  // property to name and no caller sets one on a group, so it goes with the
  // entry rather than being reported.
  const wireProperty: Readonly<Record<string, string>> = FIELD_WIRE_PROPERTY;
  const configured = new Set(
    Object.entries(field).flatMap(([key, value]) => {
      const property = wireProperty[key];
      return key === "path" ||
        key === "required" ||
        value === undefined ||
        property === undefined
        ? []
        : [property];
    }),
  );
  const markers = leaves.map((leaf) => `{{${leaf}}}`).join(", ");
  return {
    required: field.required === true,
    issues: [...configured].map((property) =>
      droppedPropertyIssue({
        index,
        property,
        message:
          `"${field.path}" is a group of ${markers}; a group carries no ` +
          `${property}.`,
        hint:
          `Send ${property} on the child paths instead. Only required ` +
          "travels from a group, to every child that does not set its own.",
      }),
    ),
  };
};

/**
 * The overlay with every group entry expanded into what its children can
 * carry. A group holding a lookup is not a group but the lookup's one input,
 * with the markers under it as its renderings, so it stays as it is.
 */
const expandGroups = (
  entries: readonly OverlayEntry[],
  declared: DeclaredPaths,
  lookupOwners: ReadonlySet<string>,
): { entries: OverlayEntry[]; issues: FieldOverlayIssue[] } => {
  const kept: OverlayEntry[] = [];
  const issues: FieldOverlayIssue[] = [];
  const required: OverlayEntry[] = [];
  for (const entry of entries) {
    const { field } = entry;
    const leaves =
      declared.roots.has(field.path) ||
      field.lookup !== undefined ||
      lookupOwners.has(field.path)
        ? []
        : groupLeaves(field.path, declared);
    if (leaves.length === 0) {
      kept.push(entry);
      continue;
    }
    const expanded = expandGroupEntry(entry, leaves);
    issues.push(...expanded.issues);
    if (expanded.required) {
      required.push(
        ...leaves.map((leaf) => ({
          field: { path: leaf, required: true },
          index: entry.index,
        })),
      );
    }
  }
  const keptPaths = new Set(kept.map((entry) => entry.field.path));
  const requiredPaths = new Set(required.map((entry) => entry.field.path));
  const created = new Map(
    required
      .filter((entry) => !keptPaths.has(entry.field.path))
      .map((entry) => [entry.field.path, entry] as const),
  );
  return {
    entries: [
      ...kept.map((entry) =>
        requiredPaths.has(entry.field.path) &&
        entry.field.required === undefined
          ? { ...entry, field: { ...entry.field, required: true } }
          : entry,
      ),
      ...created.values(),
    ],
    issues,
  };
};

/** The lookup each path carries once the overlay is applied: the entry the
 *  call sends wins over the one the template already stored. */
const effectiveLookups = (
  configured: readonly FieldMeta[],
  entries: readonly OverlayEntry[],
): Map<string, FieldLookup> => {
  const lookups = new Map<string, FieldLookup>();
  for (const { lookup, path } of [
    ...configured,
    ...entries.map((entry) => entry.field),
  ]) {
    if (lookup !== undefined) {
      lookups.set(path, lookup);
    }
  }
  return lookups;
};

/**
 * The issue one property of a lookup-format child reports. The entry landed —
 * it named a marker the parent's lookup renders — so the issue names the one
 * property that had nowhere to go, the way a group entry's does.
 */
const formatDropIssue = ({
  drop,
  index,
  key,
  parent,
  parentPath,
  path,
}: {
  drop: FormatFoldDrop;
  index: number;
  key: string;
  parent: FieldLookup;
  parentPath: string;
  path: string;
}): FieldOverlayIssue => {
  const { property } = drop;
  const renders = `"${path}" renders the "${key}" format of "${parentPath}"'s lookup`;
  const filledByTheParent =
    `One lookup fills "${parentPath}", and every marker under it renders ` +
    "the hit that lookup resolved.";
  switch (drop.reason) {
    case "registry":
      return droppedPropertyIssue({
        index,
        property,
        message:
          `${renders}, which queries ${parent.registry}; a format carries no ` +
          `registry of its own, so the ${drop.registry} lookup sent on ` +
          `"${path}" was dropped.`,
        hint: `Configure the registry on "${parentPath}". ${filledByTheParent}`,
      });
    case "renderings":
      return droppedPropertyIssue({
        index,
        property,
        message:
          `${renders}; a format is one rendering, so the lookup sent on ` +
          `"${path}", which names ${String(drop.renderings)}, was dropped.`,
        hint:
          `Name one format on "${path}" to set the template "${key}" renders ` +
          `with, or set every format on "${parentPath}". ${filledByTheParent}`,
      });
    case "property":
      return droppedPropertyIssue({
        index,
        property,
        message: `${renders}; a format carries no ${property}, so it was dropped.`,
        hint:
          `Send ${property} on "${parentPath}", the field a person fills; a ` +
          "format is a key and its [token] template, nothing else.",
      });
    default:
      return assertNever(drop);
  }
};

/**
 * The overlay with every entry a parent's lookup already renders reduced to
 * that rendering.
 *
 * `{{company.address}}` is the "address" format of the lookup on `company`,
 * so an entry at `company.address` is that format spelled as a field: its
 * template moves onto the format, and what a format cannot hold is dropped
 * per property. The entry is never refused — the caller described a real
 * marker of the document — and the parent's lookup stands.
 */
const foldLookupFormatChildren = (
  entries: readonly OverlayEntry[],
  lookups: ReadonlyMap<string, FieldLookup>,
): { entries: OverlayEntry[]; issues: FieldOverlayIssue[] } => {
  const issues: FieldOverlayIssue[] = [];
  const folded = entries.map((entry) => {
    const { field, index } = entry;
    const cut = field.path.lastIndexOf(".");
    const parentPath = field.path.slice(0, cut);
    const parent = cut === -1 ? undefined : lookups.get(parentPath);
    if (parent === undefined) {
      return entry;
    }
    const key = field.path.slice(cut + 1);
    const fold = foldFieldIntoFormat(field, parent, key);
    if (fold === null) {
      return entry;
    }
    issues.push(
      ...fold.drops.map((drop) =>
        formatDropIssue({
          drop,
          index,
          key,
          parent,
          parentPath,
          path: field.path,
        }),
      ),
    );
    return { field: fold.field, index };
  });
  return { entries: folded, issues };
};

/**
 * The overlay in the vocabulary the manifest speaks: loop aliases resolved,
 * item counts on the repeat they count, and a condition that answers itself
 * read as the absent condition it is.
 *
 * A model that configures `attorneys.name` writes the whole entry there,
 * item count included, because that is the entry it is filling in. The count
 * belongs to the array — an item field never holds a list — so it moves, and
 * the array entry the fold creates answers for the entry that sent it.
 */
const canonicalizeOverlay = ({
  configured,
  declared: declaredPathsOfDocument,
  discovered,
  overlay,
}: ValidateFieldOverlayOptions & {
  declared: DeclaredPaths;
}): { entries: OverlayEntry[]; issues: FieldOverlayIssue[] } => {
  const { arrays, declared } = declaredPathsOfDocument;
  const canonical = overlay.map((field, index) => ({
    field: withoutSelfCondition({
      ...field,
      path: canonicalizeOverlayPath(field.path, discovered, declared),
    }),
    index,
  }));
  const lookups = effectiveLookups(configured, canonical);
  const grouped = expandGroups(
    canonical,
    declaredPathsOfDocument,
    new Set(lookups.keys()),
  );
  const children = foldLookupFormatChildren(grouped.entries, lookups);
  const entries = children.entries;
  const { fields, moves } = foldItemCountConstraints(
    entries.map((entry) => entry.field),
    arrays,
  );
  const indexByPath = new Map(
    entries.map((entry) => [entry.field.path, entry.index] as const),
  );
  const movedFrom = new Map(moves.map(({ from, to }) => [to, from] as const));
  const positionOf = (path: string): number | undefined => {
    const own = indexByPath.get(path);
    if (own !== undefined) {
      return own;
    }
    const from = movedFrom.get(path);
    return from === undefined ? undefined : indexByPath.get(from);
  };
  return {
    entries: fields.flatMap((field) => {
      const index = positionOf(field.path);
      return index === undefined ? [] : [{ field, index }];
    }),
    issues: [...grouped.issues, ...children.issues],
  };
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
  // The configuration the entries make together: a path is a namespace parent
  // or the one input of a lookup by what the whole overlay says, not by what
  // the entry naming it says on its own.
  const effectiveByPath = new Map(
    applyFieldOverlay(
      { version: 1, fields: [...configured] },
      overlay,
    ).fields.map((field) => [field.path, field]),
  );
  const seenPaths = new Set<string>();

  for (const [index, field] of overlay.entries()) {
    const issuePath = fieldOverlayIssuePath(index);
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
 * Validation runs to a fixed point because an entry is checked against the
 * configuration the surviving entries make together, so dropping one can
 * settle another. Dropping only ever removes constraints, and every round
 * removes at least one entry, so the loop terminates in at most
 * `overlay.length` rounds.
 */
export const partitionFieldOverlay = ({
  configured,
  discovered,
  overlay,
}: ValidateFieldOverlayOptions): PartitionFieldOverlayResult => {
  const issuesByIndex = new Map<number, FieldOverlayIssue>();
  const canonical = canonicalizeOverlay({
    configured,
    declared: declaredPaths(discovered),
    discovered,
    overlay,
  });
  let survivors = canonical.entries;
  for (;;) {
    const issues = validateFieldOverlay({
      configured,
      discovered,
      overlay: survivors.map((entry) => entry.field),
    });
    if (issues.length === 0) {
      return {
        applied: survivors.map((entry) => entry.field),
        // A property one entry could not carry sorts beside the entries that
        // were refused whole, in the order the caller sent them.
        issues: [...canonical.issues, ...issuesByIndex.values()].toSorted(
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
          path: fieldOverlayIssuePath(entry.index),
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
 * nothing else:
 *
 *   identity  the path, which names the format's key
 *   template  becomes the format's template, when it restates the parent's
 *             lookup; a second registry over one marker is reported and gone
 *   silent    wording addressed at the person filling: nobody fills a
 *             rendering of the hit, so it goes without a word
 *   dropped   has nowhere to go in a format, and the caller is told which
 *             property went
 *   default   goes silently when it carries the value it would have anyway,
 *             and is reported like the rest when it decides something
 *
 * Nothing blocks: the marker belongs to the lookup that renders it, so the
 * child always folds and the difference is only what the caller hears about.
 *
 * Total over the manifest shape: a property added to `fieldMetaSchema` cannot
 * ship without deciding whether a rendering of a registry hit can hold it.
 */
const FORMAT_FOLD = {
  path: "identity",
  lookup: "template",
  label: "silent",
  hint: "silent",
  inputType: "default",
  options: "default",
  validation: "default",
  required: "default",
  optionsFrom: "dropped",
  aiPrompt: "dropped",
  aiAdapt: "dropped",
  aiSeesDocument: "dropped",
  parts: "dropped",
  format: "dropped",
  source: "dropped",
  formula: "dropped",
  condition: "dropped",
  conditionAst: "dropped",
  dateFormat: "dropped",
} as const satisfies Record<
  keyof FieldMeta,
  "identity" | "template" | "silent" | "dropped" | "default"
>;

/** Derived from {@link FORMAT_FOLD}, so a property that becomes `default`
 *  cannot ship without saying what its default is. */
type DefaultFoldProperty = {
  [Property in keyof typeof FORMAT_FOLD]: (typeof FORMAT_FOLD)[Property] extends "default"
    ? Property
    : never;
}[keyof typeof FORMAT_FOLD];

/**
 * A property spelled out at the value it would have had anyway decides
 * nothing. A model describing every marker it can see writes the whole entry
 * shape for each one, so `input_type: "text"` and `required: false` on a
 * rendering of a registry hit are a description of the default, not a second
 * configuration of the marker.
 */
const AT_DEFAULT_VALUE = {
  inputType: ({ inputType }) => inputType === undefined || inputType === "text",
  options: ({ options }) => options === undefined || options.length === 0,
  validation: ({ validation }) =>
    validation === undefined || Object.keys(validation).length === 0,
  required: ({ required }) => required !== true,
} as const satisfies Record<DefaultFoldProperty, (field: FieldMeta) => boolean>;

/** The parent's formats with `key` rendering `template`. The child is the more
 *  specific declaration, so its template replaces the parent's; a child that
 *  declares no template of its own leaves them alone. `null` when the fold
 *  cannot be made: nothing renders the key, or the key is new and the lookup
 *  already carries its maximum. */
const withFormatTemplate = (
  formats: readonly FieldLookupFormat[],
  key: string,
  template: string | undefined,
): FieldLookupFormat[] | null => {
  if (formats.some((format) => format.key === key)) {
    return template === undefined
      ? [...formats]
      : formats.map((format) =>
          format.key === key ? { ...format, template } : format,
        );
  }
  if (template === undefined) {
    return null;
  }
  return formats.length >= LOOKUP_FORMATS_MAX
    ? null
    : [...formats, { key, template }];
};

/**
 * One property of a child the parent's format cannot hold, and why. A lookup
 * a format cannot take is not a property with nowhere to go: it is either a
 * second registry over one marker, or several renderings offered for the one
 * the format holds, and each says something different back to the caller.
 */
type FormatFoldDrop = { property: string } & (
  | { reason: "property" }
  | { reason: "registry"; registry: string }
  | { reason: "renderings"; renderings: number }
);

/** What `parent.key` leaves behind once the format renders it. */
type FormatFold = {
  /** The child reduced to what the format keeps: its path, and the lookup
   *  whose template moves onto the format. */
  field: FieldMeta;
  /** The parent's formats with this child's rendering among them. */
  formats: FieldLookupFormat[];
  /** What the format could not carry, one entry per wire property — the
   *  derived half of the shape is configured through one `source` — and only
   *  the properties a caller is told about. */
  drops: FormatFoldDrop[];
};

/**
 * Fold `parent.key` into the format of `parent`'s lookup that renders it.
 *
 * A model that reads `{{company}}`, `{{company.address}}` and `{{company.krs}}`
 * describes every marker it sees, and describes the dotted ones the only way
 * it can: as the same registry lookup rendered differently, or as an entry
 * filled in with the shape every entry has. That is not a rival configuration
 * of one marker — the lookup owns every marker under it — so the child always
 * folds: whatever template it declares moves onto the format, and the rest
 * goes by {@link FORMAT_FOLD}. A child on a DIFFERENT registry folds too,
 * without its lookup: one registry fills the parent, and the formats render
 * the hit it resolved.
 *
 * `null` only when there is no format to fold into: the key is not one the
 * lookup carries, and it cannot be added because the child brings no template
 * of its own or the lookup already holds its maximum.
 */
const foldFieldIntoFormat = (
  field: FieldMeta,
  parent: FieldLookup,
  key: string,
): FormatFold | null => {
  if (!isLookupFormatKey(key)) {
    return null;
  }
  // The first format renders the bare marker, and a format key holds no dots,
  // so a field declaring several renderings cannot move into one.
  const restated =
    field.lookup !== undefined &&
    field.lookup.registry === parent.registry &&
    field.lookup.formats.length === 1
      ? field.lookup
      : undefined;
  const formats = withFormatTemplate(
    parent.formats,
    key,
    restated?.formats.at(0)?.template,
  );
  if (formats === null) {
    return null;
  }
  const declared: Record<string, unknown> = field;
  const atDefault: Readonly<Record<string, (value: FieldMeta) => boolean>> =
    AT_DEFAULT_VALUE;
  const wireProperty: Readonly<Record<string, string>> = FIELD_WIRE_PROPERTY;
  const drops = new Map<string, FormatFoldDrop>();
  // The `template` disposition is decided here, where the two lookups are in
  // hand; the loop below reads the dispositions that only depend on presence.
  if (field.lookup !== undefined && restated === undefined) {
    drops.set(FIELD_WIRE_PROPERTY.lookup, {
      property: FIELD_WIRE_PROPERTY.lookup,
      ...(field.lookup.registry === parent.registry
        ? { reason: "renderings", renderings: field.lookup.formats.length }
        : { reason: "registry", registry: field.lookup.registry }),
    });
  }
  for (const [property, disposition] of Object.entries(FORMAT_FOLD)) {
    const wire = wireProperty[property];
    if (
      disposition === "identity" ||
      disposition === "silent" ||
      disposition === "template" ||
      declared[property] === undefined ||
      // A persisted-only key (the derived AST, a composite's parts) has no
      // wire property to name, so its drop goes with the entry.
      wire === undefined ||
      (disposition === "default" && atDefault[property]?.(field) === true)
    ) {
      continue;
    }
    if (!drops.has(wire)) {
      drops.set(wire, { property: wire, reason: "property" });
    }
  }
  return {
    field:
      restated === undefined
        ? { path: field.path }
        : { path: field.path, lookup: restated },
    formats,
    drops: [...drops.values()],
  };
};

/**
 * The manifest with every marker a lookup renders folded into that lookup.
 *
 * This is the same ownership rule the overlay boundary applies, run over the
 * merged manifest so creation, configuration and read-back agree on which
 * fields exist. The drops are silent here because this merge has no issue
 * channel — the manifest is its whole result — while the boundary that a
 * caller reaches through reports them per property, against the entry the
 * caller sent.
 */
const foldLookupFormatFields = (fields: readonly FieldMeta[]): FieldMeta[] => {
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const folded = new Set<string>();
  for (const field of fields) {
    const cut = field.path.lastIndexOf(".");
    const parent =
      cut === -1 ? undefined : byPath.get(field.path.slice(0, cut));
    if (parent?.lookup === undefined || folded.has(parent.path)) {
      continue;
    }
    const fold = foldFieldIntoFormat(
      field,
      parent.lookup,
      field.path.slice(cut + 1),
    );
    if (fold === null) {
      continue;
    }
    byPath.set(parent.path, {
      ...parent,
      lookup: { ...parent.lookup, formats: fold.formats },
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
