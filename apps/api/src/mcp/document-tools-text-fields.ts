import type { FieldContent } from "@/api/db/schema-validators";
import type { VersionDiffSegment } from "@/api/lib/text-diff";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
} from "@/api/mcp/text-field-spec";
import type { McpTextFieldSpec } from "@/api/mcp/tool-types";

// --- Text-field specs (plan 049, Option B) --------------------------------

/**
 * Normalized read/write pair over one field's tenant-authored text unit. A
 * `FieldContent`'s text-bearing value is not always a lone scalar: a
 * multi-select holds several array-indexed values, a clip holds two named
 * fields (snippet, citation), and a "changed" diff segment holds several
 * inline runs. Every text-bearing shape becomes one unit apiece; a single
 * `McpTextFieldSpec` then just iterates `TextUnit`s without re-deriving the
 * union's shape at every call site.
 */
type TextUnit = {
  read: () => string | null | undefined;
  write: (value: string) => void;
};

/** One entity/version field row as fetched from the DB — text-field specs
 * only ever touch `content`. */
type EntityFieldRow = { content: FieldContent };

/**
 * The former `pushFieldContentTexts` helper's full discriminated-union walk,
 * narrowed here once: `text`/`single-select` are a scalar unit; `multi-select`
 * yields one unit per array index, writing back through the same array
 * reference; `clip` yields its snippet and citation as two named units;
 * `file` yields its fileName. `date`/`int`/`error`/`pending`/`unsupported`
 * carry no tenant-authored text and contribute nothing.
 */
const fieldContentTextUnits = (
  fields: readonly EntityFieldRow[],
): readonly TextUnit[] =>
  fields.flatMap(({ content }): TextUnit[] => {
    if (content.type === "text") {
      return [
        {
          read: () => content.value,
          write: (value) => {
            content.value = value;
          },
        },
      ];
    }
    if (content.type === "single-select") {
      return [
        {
          read: () => content.value,
          write: (value) => {
            content.value = value;
          },
        },
      ];
    }
    if (content.type === "multi-select") {
      const values = content.value;
      return values.map((_value, index) => ({
        read: () => values[index],
        write: (value: string) => {
          values[index] = value;
        },
      }));
    }
    if (content.type === "clip") {
      return [
        {
          read: () => content.snippet,
          write: (value) => {
            content.snippet = value;
          },
        },
        {
          read: () => content.citation,
          write: (value) => {
            content.citation = value;
          },
        },
      ];
    }
    if (content.type === "file") {
      return [
        {
          read: () => content.fileName,
          write: (value) => {
            content.fileName = value;
          },
        },
      ];
    }
    return [];
  });

/**
 * Same union-walk shape as `fieldContentTextUnits`, over a line-diff's
 * segments: a "changed" segment's several inline runs each become one unit;
 * every other segment kind is a single scalar unit over its own `text`.
 */
const diffSegmentTextUnits = (
  segments: readonly VersionDiffSegment[],
): readonly TextUnit[] =>
  segments.flatMap((segment): TextUnit[] => {
    if (segment.kind === "changed") {
      return segment.runs.map((run) => ({
        read: () => run.text,
        write: (value: string) => {
          run.text = value;
        },
      }));
    }
    return [
      {
        read: () => segment.text,
        write: (value: string) => {
          segment.text = value;
        },
      },
    ];
  });

/**
 * One anonymize-mode spec over a flat list of `TextUnit`s, shared by every
 * field-values path (`fields[].value`, `version.fields[].value`) and the diff
 * path (`diff.segments[].text`) below.
 */
const textUnitTextFieldSpec = <TPayload>({
  path,
  units,
  workspaceId,
}: {
  path: string;
  units: (payload: TPayload) => readonly TextUnit[];
  workspaceId: string;
}): McpTextFieldSpec<TPayload> =>
  defineTextFieldSpec({
    path,
    items: units,
    scope: () => workspaceId,
    read: (unit: TextUnit) => unit.read(),
    apply: (unit: TextUnit, value) => {
      unit.write(value);
    },
  });

/**
 * One anonymize-mode spec over a single `{ name: string }`-shaped payload,
 * shared across read_document's default/version/diff branches (P1: the whole
 * branch response shares one resolved `workspaceId`).
 */
const nameTextFieldSpec = <TPayload extends { name: string }>(
  workspaceId: string,
): McpTextFieldSpec<TPayload> =>
  defineTextFieldSpec({
    path: "name",
    items: (payload: TPayload) => [payload],
    scope: () => workspaceId,
    read: (item: TPayload) => item.name,
    apply: (item: TPayload, value) => {
      item.name = value;
    },
  });

// --- list_documents / list_properties -------------------------------------

type NamedListItem = { name: string };

export const DOCUMENT_LIST_TEXT_FIELD_PATH = "documents[].name";

export const documentListTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<{ documents: readonly NamedListItem[] }>[] => [
  defineTextFieldSpec({
    path: DOCUMENT_LIST_TEXT_FIELD_PATH,
    items: (payload) => payload.documents,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
];

export const PROPERTY_LIST_TEXT_FIELD_PATH = "properties[].name";

export const propertyListTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<{ properties: readonly NamedListItem[] }>[] => [
  defineTextFieldSpec({
    path: PROPERTY_LIST_TEXT_FIELD_PATH,
    items: (payload) => payload.properties,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
];

// --- read_document ---------------------------------------------------------

/** Version-history fields this surface redacts. See `VersionHistoryEntry`
 * below for the full row shape fetched from the DB. */
type VersionHistoryTextItem = {
  label: string | null;
  description: string | null;
};

type ReadDocumentDefaultPayload = {
  name: string;
  fields: readonly EntityFieldRow[];
  versions?: readonly VersionHistoryTextItem[];
};

/** `versions` is only present when `include_versions` was requested — a
 * genuine absence, not a structural invariant, so this reads as an explicit
 * presence check rather than a `?? []` fallback. */
const readDocumentVersionHistoryItems = (
  payload: ReadDocumentDefaultPayload,
): readonly VersionHistoryTextItem[] => {
  if (payload.versions === undefined) {
    return [];
  }
  return payload.versions;
};

/**
 * Default branch (current version): the entity's own name, its field values
 * (full `FieldContent` union recursion via `fieldContentTextUnits`), and,
 * when `include_versions` was requested, each version-history entry's label
 * and description — the exact fields Wave 1 declared but never pushed;
 * deriving the declaration from this same spec closes that gap structurally.
 */
export const readDocumentDefaultTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<ReadDocumentDefaultPayload>[] => [
  nameTextFieldSpec<ReadDocumentDefaultPayload>(workspaceId),
  textUnitTextFieldSpec({
    path: "fields[].value",
    units: (payload: ReadDocumentDefaultPayload) =>
      fieldContentTextUnits(payload.fields),
    workspaceId,
  }),
  defineTextFieldSpec({
    path: "versions[].label",
    items: readDocumentVersionHistoryItems,
    scope: () => workspaceId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "versions[].description",
    items: readDocumentVersionHistoryItems,
    scope: () => workspaceId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

type ReadDocumentVersionDetailPayload = {
  name: string;
  version: {
    label: string | null;
    description: string | null;
    fields: readonly EntityFieldRow[];
  };
};

/**
 * version_id branch: the entity name, the requested version's own
 * label/description (pushed by the original handler but never declared —
 * another instance of the declared-vs-pushed drift this migration closes),
 * and that version's field values.
 */
export const readDocumentVersionDetailTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<ReadDocumentVersionDetailPayload>[] => [
  nameTextFieldSpec<ReadDocumentVersionDetailPayload>(workspaceId),
  defineTextFieldSpec({
    path: "version.label",
    items: (payload: ReadDocumentVersionDetailPayload) => [payload.version],
    scope: () => workspaceId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "version.description",
    items: (payload: ReadDocumentVersionDetailPayload) => [payload.version],
    scope: () => workspaceId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  textUnitTextFieldSpec({
    path: "version.fields[].value",
    units: (payload: ReadDocumentVersionDetailPayload) =>
      fieldContentTextUnits(payload.version.fields),
    workspaceId,
  }),
];

type ReadDocumentDiffPayload = {
  name: string;
  diff: { segments: readonly VersionDiffSegment[] };
};

/**
 * compare_with_version_id branch: the entity name and every diff segment's
 * text (a "changed" segment's several inline runs, or the segment's own text
 * for every other kind).
 */
export const readDocumentDiffTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<ReadDocumentDiffPayload>[] => [
  nameTextFieldSpec<ReadDocumentDiffPayload>(workspaceId),
  textUnitTextFieldSpec({
    path: "diff.segments[].text",
    units: (payload: ReadDocumentDiffPayload) =>
      diffSegmentTextUnits(payload.diff.segments),
    workspaceId,
  }),
];

// read_document's three branches (default/version/diff) never populate the
// same response at once, but each has its own payload shape, so the declared
// path list is the union of all three specs' paths (deduped: `name` is
// shared by every branch).
export const READ_DOCUMENT_TEXT_FIELD_PATHS = [
  ...new Set([
    ...deriveTextFieldPaths(readDocumentDefaultTextFieldSpecs("")),
    ...deriveTextFieldPaths(readDocumentVersionDetailTextFieldSpecs("")),
    ...deriveTextFieldPaths(readDocumentDiffTextFieldSpecs("")),
  ]),
];
