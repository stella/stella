/**
 * Pre-validation repair for `apply-active-docx-edits` tool calls.
 *
 * Folio's document-operation contract (`parseFolioDocumentOperationBatch` in
 * `@stll/folio-core`) validates strictly and never coerces, so the only
 * thing left for this layer is fixing malformations the model produces
 * BEFORE validation, where a hard failure would bounce the whole batch:
 *
 * - `kind` used instead of the `type` discriminator;
 * - an operation serialized as a JSON string inside `operations`.
 *
 * The former `id` -> `blockId` alias repair is intentionally gone: under
 * the versioned contract `id` is the operation id (echoed in
 * `queued`/`skipped`), so rewriting it into `blockId` would corrupt valid
 * inputs. An operation missing `blockId` now fails validation and the
 * error is fed back to the model to retry.
 */

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonObject = (text: string): JsonObject | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeOperation = (value: unknown): JsonObject | null => {
  const operation = typeof value === "string" ? parseJsonObject(value) : value;

  if (!isJsonObject(operation)) {
    return null;
  }

  const type = (() => {
    if (typeof operation["type"] === "string") {
      return operation["type"];
    }
    if (typeof operation["kind"] === "string") {
      return operation["kind"];
    }
    if (
      typeof operation["find"] === "string" &&
      typeof operation["replace"] === "string"
    ) {
      return "replaceInBlock";
    }
    return null;
  })();

  if (type === null) {
    return null;
  }

  const normalized: JsonObject = {
    ...operation,
    type,
  };
  delete normalized["kind"];

  return normalized;
};

export const normalizeActiveDocxEditToolInput = (
  input: string,
): string | null => {
  const parsed = parseJsonObject(input);
  if (!parsed || !Array.isArray(parsed["operations"])) {
    return null;
  }

  const operations: JsonObject[] = [];
  for (const operation of parsed["operations"]) {
    const normalized = normalizeOperation(operation);
    if (normalized === null) {
      return null;
    }
    operations.push(normalized);
  }

  // Preserve the batch's contract version; everything else on the
  // envelope is dropped (the strict input schema would reject it anyway).
  const version = parsed["version"];
  return JSON.stringify({
    ...(version === undefined ? {} : { version }),
    operations,
  });
};
