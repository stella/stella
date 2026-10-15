import { t } from "elysia";

import {
  BUSINESS_REGISTRY_SLUGS,
  STELLA_API_VERSION_PREFIX,
} from "@stll/api-contract";

import { DESKTOP_REGISTRY_KEY_PREFIX } from "@/api/lib/business-registries/desktop/config";
import { tSafeId } from "@/api/lib/custom-schema";

export const DESKTOP_REGISTRY_ROUTE_PREFIX = "/desktop-registry";
export const DESKTOP_REGISTRY_REQUEST_ROUTE = "/request";
export const DESKTOP_REGISTRY_REQUEST_PATH = `${STELLA_API_VERSION_PREFIX}${DESKTOP_REGISTRY_ROUTE_PREFIX}${DESKTOP_REGISTRY_REQUEST_ROUTE}`;
export const DESKTOP_REGISTRY_REQUEST_USER_AGENT = "stella-desktop";
export const DESKTOP_REGISTRY_REQUEST_CONTENT_TYPE = "application/json";
export const DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX = `Bearer ${DESKTOP_REGISTRY_KEY_PREFIX}`;
export const DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_MAX_LENGTH = 256;
export const DESKTOP_REGISTRY_UNKNOWN_TOKEN_RESPONSE = {
  status: 401,
  body: { message: "Reconnect desktop to your account" },
} as const;

const registry = t.UnionEnum(BUSINESS_REGISTRY_SLUGS);

const desktopRegistryRequestIdentityHeaders = {
  authorization: t.String({
    pattern: `^${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}`,
    maxLength: DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_MAX_LENGTH,
  }),
  "user-agent": t.Literal(DESKTOP_REGISTRY_REQUEST_USER_AGENT),
};

export const desktopRegistryRequestHeaders = t.Object(
  {
    ...desktopRegistryRequestIdentityHeaders,
    "content-type": t.RegExp(/^application\/json(?:\s*;.*)?$/iu),
  },
  { additionalProperties: true },
);

export const desktopRegistryNativeRequestHeaders = t.Object(
  {
    ...desktopRegistryRequestIdentityHeaders,
    "content-type": t.Literal(DESKTOP_REGISTRY_REQUEST_CONTENT_TYPE),
  },
  { additionalProperties: true },
);

export const desktopRegistryRequestBody = t.Union([
  t.Object({ type: t.Literal("config") }, { additionalProperties: false }),
  t.Object({ type: t.Literal("revoke") }, { additionalProperties: false }),
  t.Object(
    {
      type: t.Literal("search"),
      registry,
      query: t.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal("format"),
      registry,
      id: t.String({ minLength: 1, maxLength: 64 }),
      formatId: t.Union([tSafeId("templateLookupFormat"), t.Null()]),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal("setDefaultFormat"),
      registry,
      formatId: t.Union([tSafeId("templateLookupFormat"), t.Null()]),
    },
    { additionalProperties: false },
  ),
]);
