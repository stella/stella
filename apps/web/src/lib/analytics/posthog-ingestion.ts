// posthog-js discards any event whose `token`, `distinct_id`, or
// `$cookieless_mode` property a `before_send` hook removed (its
// properties-required-for-ingestion guard). Every sanitizer that rebuilds
// event properties must spread this passthrough or the event is silently
// dropped client-side.
export const INGESTION_REQUIRED_KEYS = [
  "token",
  "distinct_id",
  "$cookieless_mode",
] as const;

export const pickIngestionRequired = (
  properties: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    INGESTION_REQUIRED_KEYS.filter((key) => key in properties).map((key) => [
      key,
      properties[key],
    ]),
  );
