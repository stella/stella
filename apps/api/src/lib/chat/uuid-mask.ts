// The UUID shape the chat projection masks in model-facing data and in
// degrade telemetry. One owner so the projection walk and the telemetry
// paths cannot disagree on what counts as an id.

const UUID_ANYWHERE_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const UUID_GLOBAL_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * Replaces each UUID-shaped substring of a forwarded data string. Not a chat
 * ref token, so a masked string can never be read back as a handle.
 */
export const MASKED_CONTENT_ID = "[id]";

export const containsUuid = (value: string): boolean =>
  UUID_ANYWHERE_REGEX.test(value);

export const maskUuids = (value: string): string =>
  value.replace(UUID_GLOBAL_REGEX, () => MASKED_CONTENT_ID);

/**
 * A verbatim-UUID guard for the "no tenant UUID reaches the model" invariant.
 * A projected payload must serialize without any raw UUID: every tenant id is
 * a ref and every `passthroughId` handle is documented as either
 * non-UUID-formatted (opaque cursors) or an out-of-band handle. Tests assert
 * this holds.
 */
export const containsRawUuid = (value: unknown): boolean =>
  containsUuid(JSON.stringify(value));
