// Passive regression fixture for `no-raw-resource-uri/no-raw-resource-uri`.

declare const CHAT_RESOURCE_HREF_PREFIX: { entity: string };
declare const RESOURCE_NAME_PREFIX: string;
declare const entityId: string;
declare const toChatResourceHref: (target: unknown) => string;

// oxlint-disable-next-line no-raw-resource-uri/require-rfc3986-resource-encoding -- regression case
export const unsafeResourceEncoding = encodeURIComponent(entityId);

// oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case
export const rawStaticHref = "#stella-entity=entity_1";

// oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case
export const rawTemplateHref = `#stella-entity=${entityId}`;

// oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case
export const rawPrefixTemplateHref = `${CHAT_RESOURCE_HREF_PREFIX.entity}${entityId}`;

export const rawPrefixConcatHref =
  // oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case
  CHAT_RESOURCE_HREF_PREFIX.entity.concat(entityId);

export const rawResourceName =
  // oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case
  RESOURCE_NAME_PREFIX + entityId;

export const parsedPrefixCheck = "candidate".startsWith(
  CHAT_RESOURCE_HREF_PREFIX.entity,
);
export const serializedHref = toChatResourceHref({ id: entityId });
