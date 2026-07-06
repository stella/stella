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
 * exact model-visible values, never a raw id. Long values are truncated. Two
 * template tools get bespoke handling so a base64 document upload or a large
 * field manifest is summarized rather than dumped.
 *
 * `documentLabel` and `uploadPlaceholder` are supplied by the caller
 * (translated) so this module stays i18n-free: they label and replace the
 * `save_template` base64 upload field, which must never be dumped verbatim
 * into the summary.
 */
export const buildRegistryWriteSummaryRows = ({
  documentLabel,
  emptyLabel,
  input,
  toolName,
  uploadPlaceholder,
}: {
  documentLabel: string;
  emptyLabel: string;
  input: unknown;
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

  if (toolName === "save_template") {
    return buildSaveTemplateRows({
      documentLabel,
      emptyLabel,
      input,
      uploadPlaceholder,
    });
  }
  if (toolName === "fill_template") {
    return buildFillTemplateRows({ emptyLabel, input });
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

const buildSaveTemplateRows = ({
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
