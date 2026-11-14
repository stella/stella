import * as v from "valibot";

import {
  BUSINESS_REGISTRY_SLUGS,
  STELLA_API_VERSION_PREFIX,
} from "@stll/api-contract";

import { DESKTOP_REGISTRY_KEY_PREFIX } from "@/api/lib/business-registries/desktop/config";
import { resourceIdSchema } from "@/api/lib/custom-schema";

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

const registry = v.picklist(BUSINESS_REGISTRY_SLUGS);

const desktopRegistryRequestIdentityHeaders = {
  authorization: v.pipe(
    v.string(),
    v.regex(
      new RegExp(`^${DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_PREFIX}`, "u"),
    ),
    v.maxLength(DESKTOP_REGISTRY_REQUEST_AUTHORIZATION_MAX_LENGTH),
  ),
  "user-agent": v.literal(DESKTOP_REGISTRY_REQUEST_USER_AGENT),
};

export const desktopRegistryRequestHeaders = v.looseObject({
  ...desktopRegistryRequestIdentityHeaders,
  "content-type": v.pipe(
    v.string(),
    v.regex(/^application\/json(?:\s*;.*)?$/iu),
  ),
});

export const desktopRegistryNativeRequestHeaders = v.looseObject({
  ...desktopRegistryRequestIdentityHeaders,
  "content-type": v.literal(DESKTOP_REGISTRY_REQUEST_CONTENT_TYPE),
});

export const desktopRegistryRequestBody = v.union([
  v.strictObject({ type: v.literal("config") }),
  v.strictObject({ type: v.literal("revoke") }),
  v.strictObject({
    type: v.literal("search"),
    registry,
    query: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  }),
  v.strictObject({
    type: v.literal("format"),
    registry,
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    formatId: v.union([resourceIdSchema("templateLookupFormat"), v.null()]),
  }),
  v.strictObject({
    type: v.literal("setDefaultFormat"),
    registry,
    formatId: v.union([resourceIdSchema("templateLookupFormat"), v.null()]),
  }),
]);
