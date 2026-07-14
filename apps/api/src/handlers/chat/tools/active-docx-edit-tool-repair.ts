/**
 * Pre-validation repair for `apply-active-docx-edits` tool calls.
 *
 * Folio's document-operation contract (`parseFolioDocumentOperationBatch` in
 * `@stll/folio-core`) validates strictly and never coerces, so the only
 * thing left for this layer is fixing malformations the model produces
 * BEFORE validation, where a hard failure would bounce the whole batch:
 *
 * - `kind` used instead of the `type` discriminator;
 * - an operation serialized as a JSON string inside `operations`;
 * - `null` standing in for an omitted optional field (see `stripNullValues`).
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

/**
 * OpenAI's strict Structured Outputs requires every property to appear in
 * `required`, so its adapter null-widens each optional property and the model
 * is then obliged to send `null` for the ones it means to omit: the envelope's
 * `version`, an operation's `id`, `parties[].signatory`. Folio's contract never
 * coerces and rejects those nulls outright, so drop the keys instead — absent
 * is what the schema means by optional, and no folio field accepts a null.
 */
const stripNullValues = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripNullValues);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      continue;
    }
    result[key] = stripNullValues(entry);
  }
  return result;
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
  const stripped = stripNullValues(parseJsonObject(input));
  const parsed = isJsonObject(stripped) ? stripped : null;
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
