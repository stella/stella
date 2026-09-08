import { Result } from "better-result";
import { t } from "elysia";

import { BUSINESS_REGISTRY_SLUGS } from "@stll/api-contract";
import type {
  DesktopRegistryConfig,
  DesktopRegistrySearchResponse,
} from "@stll/api-contract/desktop-registry";

import { DESKTOP_REGISTRY_KEY_CONFIG } from "@/api/handlers/desktop-registry/config";
import {
  formatDesktopRegistry,
  getDesktopRegistryConfig,
  searchDesktopRegistry,
} from "@/api/handlers/desktop-registry/service";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import { authorizeDesktopRegistry } from "@/api/lib/desktop-registry-auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const registry = t.UnionEnum(BUSINESS_REGISTRY_SLUGS);
const config = {
  mcp: { type: "internal", reason: "auth_plumbing" },
  body: t.Union([
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
        formatId: t.Union([t.String({ format: "uuid" }), t.Null()]),
      },
      { additionalProperties: false },
    ),
  ]),
} as const;

// A dedicated bearer boundary, not an unauthenticated registry proxy. The
// ordinary session middleware intentionally does not recognize these keys.
type RegistryReply =
  | DesktopRegistryConfig
  | DesktopRegistrySearchResponse
  | { text: string }
  | { revoked: boolean };

export default createSafePublicHandler(
  config,
  async function* ({
    request,
    body,
    set,
  }): SafeHandlerGenerator<RegistryReply> {
    set.headers["cache-control"] = "no-store";
    const context = yield* Result.await(authorizeDesktopRegistry(request));
    switch (body.type) {
      case "revoke": {
        yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await getAuth().api.updateApiKey({
                body: {
                  configId: DESKTOP_REGISTRY_KEY_CONFIG,
                  keyId: context.keyId,
                  userId: context.userId,
                  enabled: false,
                },
              }),
            catch: () =>
              new HandlerError({
                status: 503,
                message: "Could not disconnect registry search",
              }),
          }),
        );
        const record = createAuditRecorder({
          organizationId: context.organizationId,
          userId: context.userId,
          request,
          server: null,
          workspaceId: null,
        });
        yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await context.scopedDb(
                async (tx) =>
                  await record(tx, {
                    action: AUDIT_ACTION.UPDATE,
                    resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
                    resourceId: context.keyId,
                    metadata: {
                      purpose: DESKTOP_REGISTRY_KEY_CONFIG,
                      enabled: false,
                    },
                  }),
              ),
            catch: () =>
              new HandlerError({
                status: 503,
                message: "Could not record registry disconnection",
              }),
          }),
        );
        return Result.ok({ revoked: true });
      }
      case "config":
        return Result.ok(
          yield* Result.await(getDesktopRegistryConfig(context)),
        );
      case "search":
        return Result.ok(
          yield* Result.await(searchDesktopRegistry(context, body)),
        );
      case "format":
        return Result.ok(
          yield* Result.await(formatDesktopRegistry(context, body)),
        );
    }
  },
);

