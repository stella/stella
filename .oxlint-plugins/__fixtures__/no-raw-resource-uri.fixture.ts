// Passive regression fixture for `no-raw-resource-uri/no-raw-resource-uri`.

import {
  CHAT_RESOURCE_HREF_PREFIX as IMPORTED_RESOURCE_PREFIX,
  RESOURCE_NAME_PREFIX as IMPORTED_NAME_PREFIX,
} from "@stll/api-contract";
import * as API_CONTRACT from "@stll/api-contract";

const CHAT_RESOURCE_HREF_PREFIX = IMPORTED_RESOURCE_PREFIX;
const RESOURCE_NAME_PREFIX = IMPORTED_NAME_PREFIX;
const ENTITY_PREFIX = IMPORTED_RESOURCE_PREFIX.entity;
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

// oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case proves imported aliases retain prefix provenance
export const rawImportedAliasHref = `${IMPORTED_RESOURCE_PREFIX.entity}${entityId}`;

// oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case proves property aliases retain prefix provenance
export const rawPropertyAliasHref = `${ENTITY_PREFIX}${entityId}`;

// oxlint-disable-next-line no-raw-resource-uri/no-raw-resource-uri -- regression case proves namespace aliases retain prefix provenance
export const rawNamespaceAliasHref = `${API_CONTRACT.CHAT_RESOURCE_HREF_PREFIX.entity}${entityId}`;

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
