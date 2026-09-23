import { READER_ANNOTATION_KINDS } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderAnnotationKind } from "@stll/api-contract/legal-reader-annotations";

import type { ApprovalToolName } from "@/components/chat/chat-ui-tools";

/**
 * Pure (no-React) helpers that turn a chat tool's approval input into readable
 * key/value rows for `ToolApprovalCard`. Kept free of React so the row logic is
 * unit-testable (apps/web has no DOM test framework); the card only renders the
 * rows these produce.
 */

export type ReadableInputRow = {
  key: string;
  label: string;
  value: string;
};

/** Longer string values are truncated in the approval summary. */
const MAX_VALUE_CHARS = 200;

export const humanizeIdentifier = (value: string): string =>
  value
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/^\p{L}/u, (match) => match.toLocaleUpperCase());

const truncate = (value: string): string =>
  value.length > MAX_VALUE_CHARS
    ? `${value.slice(0, MAX_VALUE_CHARS)}…`
    : value;

export const formatReadableInputValue = ({
  emptyLabel,
  value,
}: {
  emptyLabel: string;
  value: unknown;
}): string => {
  if (value === null || value === undefined) {
    return emptyLabel;
  }

  if (typeof value === "string") {
    return truncate(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return truncate(
      value
        .map((child) => formatReadableInputValue({ emptyLabel, value: child }))
        .join(", "),
    );
  }

  const parts: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    parts.push(
      `${humanizeIdentifier(key)}: ${formatReadableInputValue({
        emptyLabel,
        value: child,
      })}`,
    );
  }
  return truncate(parts.join("; "));
};

export const getReadableInputRows = ({
  emptyLabel,
  input,
  requestLabel,
}: {
  emptyLabel: string;
  input: unknown;
  requestLabel: string;
}): ReadableInputRow[] => {
  if (input === undefined || input === null || typeof input !== "object") {
    return [
      {
        key: "request",
        label: requestLabel,
        value: formatReadableInputValue({ emptyLabel, value: input }),
      },
    ];
  }

  if (Array.isArray(input)) {
    return input.map((value, index) => ({
      key: String(index),
      label: String(index + 1),
      value: formatReadableInputValue({ emptyLabel, value }),
    }));
  }

  const rows: ReadableInputRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value }),
    });
  }

  return rows;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Readable rows for a registry write tool's approval input. Ref params
 * (`mat_N`/`ent_N`/`contact_N`/`prop_N`) are shown as their chat refs — the
 * exact model-visible values, never a raw id. Long values are truncated. The
 * template tools get bespoke handling so a base64 document upload or a large
 * field manifest is summarized rather than dumped.
 *
 * `documentLabel` and `uploadPlaceholder` are supplied by the caller
 * (translated) so this module stays i18n-free: they label and replace
 * `create_template`'s document input, which must never be dumped verbatim
 * into the summary — neither the base64 blob nor the host file reference's
 * signed download URL.
 */
export const buildRegistryWriteSummaryRows = ({
  documentLabel,
  emptyLabel,
  input,
  readerAnnotation,
  toolName,
  uploadPlaceholder,
}: {
  documentLabel: string;
  emptyLabel: string;
  input: unknown;
  /** The mark an annotation edit or delete names, when the reader holds it. */
  readerAnnotation: ReaderAnnotationSummary | null;
  toolName: string;
  uploadPlaceholder: string;
}): ReadableInputRow[] => {
  if (!isRecord(input)) {
    return getReadableInputRows({
      emptyLabel,
      input,
      requestLabel: humanizeIdentifier(toolName),
    });
  }

  if (readerAnnotation !== null && isReaderAnnotationEditToolName(toolName)) {
    return buildReaderAnnotationRows({ emptyLabel, input, readerAnnotation });
  }

  if (
    toolName === "create_template" ||
    toolName === "configure_template_fields" ||
    // Retired: persisted threads still carry `save_template` calls, whose
    // input mixes both document forms with the field manifest.
    toolName === "save_template"
  ) {
    return buildTemplateAuthoringRows({
      documentLabel,
      emptyLabel,
      input,
      uploadPlaceholder,
    });
  }
  if (toolName === "fill_template") {
    return buildFillTemplateRows({ emptyLabel, input });
  }
  if (toolName === "save_playbook") {
    return buildSavePlaybookRows({ emptyLabel, input });
  }

  const rows: ReadableInputRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value }),
    });
  }
  return rows;
};

/**
 * `save_playbook` upserts: `positions` holds only what the call adds or
 * changes, each a full tier ladder. The approver needs to know which
 * positions the call touches and how, not to read the ladders as one blob, so
 * the entries are named by issue and split by whether they carry a
 * `source_id` (a change to a stored position) or not (a new one). The card
 * reads the raw call, where the server reads a `null` as absent, so it does too.
 */
const buildSavePlaybookRows = ({
  emptyLabel,
  input,
}: {
  emptyLabel: string;
  input: Record<string, unknown>;
}): ReadableInputRow[] => {
  const rows: ReadableInputRow[] = [];
  for (const key of ["name", "description", "scope"]) {
    if (input[key] === undefined || input[key] === null) {
      continue;
    }
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value: input[key] }),
    });
  }

  const added: string[] = [];
  const changed: string[] = [];
  const positions = input["positions"];
  for (const position of Array.isArray(positions) ? positions : []) {
    if (!isRecord(position) || typeof position["issue"] !== "string") {
      continue;
    }
    (typeof position["source_id"] === "string" ? changed : added).push(
      position["issue"],
    );
  }
  const removed = input["remove_source_ids"];
  const changes = [
    { key: "positions_added", value: added.join("; ") },
    { key: "positions_changed", value: changed.join("; ") },
    {
      key: "positions_removed",
      value:
        Array.isArray(removed) && removed.length > 0 ? `${removed.length}` : "",
    },
  ];
  for (const { key, value } of changes) {
    if (value.length === 0) {
      continue;
    }
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value }),
    });
  }
  return rows;
};

/** The display name of a host file reference, when it carries one. */
const hostFileName = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const name = value["file_name"];
  return typeof name === "string" && name.length > 0 ? name : null;
};

const buildTemplateAuthoringRows = ({
  documentLabel,
  emptyLabel,
  input,
  uploadPlaceholder,
}: {
  documentLabel: string;
  emptyLabel: string;
  input: Record<string, unknown>;
  uploadPlaceholder: string;
}): ReadableInputRow[] => {
  const rows: ReadableInputRow[] = [];
  for (const [key, value] of Object.entries(input)) {
    // Never dump the base64 blob or the full field manifest into the card.
    if (key === "docx_base64") {
      rows.push({ key, label: documentLabel, value: uploadPlaceholder });
      continue;
    }
    // The host file reference carries a temporary signed download URL and an
    // opaque host id. Show the attachment's name instead of the transport.
    if (key === "file") {
      rows.push({
        key,
        label: documentLabel,
        value: hostFileName(value) ?? uploadPlaceholder,
      });
      continue;
    }
    if (key === "fields") {
      const count = Array.isArray(value) ? value.length : 0;
      rows.push({
        key,
        label: humanizeIdentifier(key),
        value: `${count}`,
      });
      continue;
    }
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value }),
    });
  }
  return rows;
};

const buildFillTemplateRows = ({
  emptyLabel,
  input,
}: {
  emptyLabel: string;
  input: Record<string, unknown>;
}): ReadableInputRow[] => {
  const rows: ReadableInputRow[] = [];
  // The template handle (hand-written tool uses `templateId`, the registry
  // shape `template_id`); show whichever is present.
  const templateId = input["templateId"] ?? input["template_id"];
  if (typeof templateId === "string") {
    rows.push({ key: "template", label: "Template", value: templateId });
  }

  // `values` maps each field path to its value: render one truncated row per
  // field rather than dumping the whole object as one blob.
  const values = input["values"];
  if (isRecord(values)) {
    for (const [path, value] of Object.entries(values)) {
      rows.push({
        key: `value:${path}`,
        label: path,
        value: formatReadableInputValue({ emptyLabel, value }),
      });
    }
  }
  return rows;
};

/** The annotation tools whose input names an existing mark by id. */
const READER_ANNOTATION_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delete_reader_annotation",
  "update_reader_annotation",
] as const satisfies readonly ApprovalToolName[]);

const isReaderAnnotationEditToolName = (toolName: string): boolean =>
  READER_ANNOTATION_EDIT_TOOL_NAMES.has(toolName);

/** The mark id an annotation edit or delete names; null for any other tool. */
export const getReaderAnnotationEditTargetId = ({
  input,
  toolName,
}: {
  input: unknown;
  toolName: string;
}): string | null => {
  if (!isReaderAnnotationEditToolName(toolName) || !isRecord(input)) {
    return null;
  }
  const annotationId = input["annotation_id"];
  return typeof annotationId === "string" ? annotationId : null;
};

/** The fields of a cached reader annotation row the approval summary reads. */
type ReaderAnnotationRow = {
  body: string | null;
  groupId: string | null;
  id: string;
  kind: ReaderAnnotationKind;
  quote: string;
};

const isReaderAnnotationKind = (
  value: unknown,
): value is ReaderAnnotationKind =>
  READER_ANNOTATION_KINDS.some((kind) => kind === value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isReaderAnnotationRow = (value: unknown): value is ReaderAnnotationRow =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isNullableString(value["groupId"]) &&
  isReaderAnnotationKind(value["kind"]) &&
  typeof value["quote"] === "string" &&
  isNullableString(value["body"]);

/**
 * The cached list that holds a mark, returned by reference so a store
 * snapshot stays stable until the cache itself changes. The chat names the
 * mark by id alone, not by the document it sits on, so every reader's cached
 * list is searched; the cache is untyped at that breadth, hence the narrowing.
 */
export const findCachedReaderAnnotationRows = ({
  annotationId,
  cachedLists,
}: {
  annotationId: string;
  cachedLists: Iterable<unknown>;
}): readonly ReaderAnnotationRow[] | undefined => {
  for (const list of cachedLists) {
    if (
      Array.isArray(list) &&
      list.every(isReaderAnnotationRow) &&
      list.some((row) => row.id === annotationId)
    ) {
      return list;
    }
  }
  return undefined;
};

export type ReaderAnnotationMark = {
  /** A comment's text; null for a highlight. */
  body: string | null;
  kind: ReaderAnnotationKind;
  /** Every paragraph the mark covers, in the reader's order. */
  quote: string;
};

/**
 * The mark a row id belongs to. A mark over several paragraphs is one row per
 * paragraph under a shared group, so the quote joins the whole group the way
 * the reader's toolbar does, and the comment text comes from the one row that
 * carries it.
 */
export const findReaderAnnotationMark = ({
  annotationId,
  rows,
}: {
  annotationId: string;
  rows: readonly ReaderAnnotationRow[];
}): ReaderAnnotationMark | null => {
  const target = rows.find((row) => row.id === annotationId);
  if (target === undefined) {
    return null;
  }
  const group =
    target.groupId === null
      ? [target]
      : rows.filter((row) => row.groupId === target.groupId);
  return {
    body: group.find((row) => row.body !== null)?.body ?? null,
    kind: target.kind,
    quote: group.map((row) => row.quote).join(" "),
  };
};

export type ReaderAnnotationSummary = {
  labels: {
    commentText: string;
    /** The passage row's label, which names the kind of mark. */
    passage: Record<ReaderAnnotationKind, string>;
  };
  mark: ReaderAnnotationMark;
};

/**
 * The approver sees the mark itself (the words it covers, labelled by its
 * kind, and a comment's text) in place of its opaque id; the rest of the input (an
 * update's change, a delete's confirmation) reads as usual.
 */
const buildReaderAnnotationRows = ({
  emptyLabel,
  input,
  readerAnnotation: { labels, mark },
}: {
  emptyLabel: string;
  input: Record<string, unknown>;
  readerAnnotation: ReaderAnnotationSummary;
}): ReadableInputRow[] => {
  const rows: ReadableInputRow[] = [
    {
      key: "quote",
      label: labels.passage[mark.kind],
      value: truncate(mark.quote),
    },
  ];
  if (mark.body !== null) {
    rows.push({
      key: "body",
      label: labels.commentText,
      value: truncate(mark.body),
    });
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "annotation_id") {
      continue;
    }
    rows.push({
      key,
      label: humanizeIdentifier(key),
      value: formatReadableInputValue({ emptyLabel, value }),
    });
  }
  return rows;
};
